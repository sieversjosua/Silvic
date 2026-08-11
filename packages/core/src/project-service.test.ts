import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { Connector } from "@silvic/contracts";

import { ConnectorRegistry } from "./connector-registry";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./command-runner";
import { LocalCommandRunner } from "./command-runner";
import { ProjectService } from "./project-service";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

class CountingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly runner: CommandRunner) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return this.runner.run(request);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectService.snapshot", () => {
  it("groups a repository and its linked worktree into one connector-enriched project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silvic-project-service-"));
    temporaryDirectories.push(directory);
    const repository = join(directory, "silvic");
    const worktree = join(directory, "silvic-auth");
    await git(directory, ["init", "--initial-branch=main", repository]);
    await git(repository, ["config", "user.email", "silvic@example.com"]);
    await git(repository, ["config", "user.name", "Silvic"]);
    await writeFile(join(repository, "README.md"), "# Silvic\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    await git(repository, [
      "remote",
      "add",
      "origin",
      "git@github.com:Example/Silvic.git",
    ]);
    await git(repository, ["worktree", "add", "-b", "agent/auth", worktree]);

    const observedBranches: string[] = [];
    const connector: Connector = {
      manifest: {
        id: "test-runtime",
        name: "Test runtime",
        kind: "service",
        capabilities: ["observe"],
      },
      observe: async (target) => {
        observedBranches.push(target.branch);
        return target.branch === "agent/auth"
          ? [
              {
                connectorId: "test-runtime",
                workspaceId: target.workspaceId,
                kind: "runtime",
                state: "active",
                label: "localhost:3000",
              },
            ]
          : [];
      },
    };
    const runner = new CountingRunner(new LocalCommandRunner());
    const service = new ProjectService({
      runner,
      connectors: new ConnectorRegistry([connector]),
    });

    const snapshot = await service.snapshot([directory]);

    expect(
      runner.requests.filter(
        (request) =>
          request.executable === "git" && request.arguments?.[0] === "worktree",
      ),
    ).toHaveLength(1);
    expect(
      runner.requests.filter(
        (request) =>
          request.executable === "git" && request.arguments?.[0] === "status",
      ),
    ).toHaveLength(2);

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.id).toBe("github.com/example/silvic");
    expect(
      snapshot.projects[0]?.workspaces
        .map((workspace) => workspace.branch)
        .sort(),
    ).toEqual(["agent/auth", "main"]);
    expect(
      snapshot.projects[0]?.workspaces.find(
        (workspace) => workspace.branch === "agent/auth",
      )?.observations,
    ).toEqual([
      {
        connectorId: "test-runtime",
        workspaceId: expect.any(String),
        kind: "runtime",
        state: "active",
        label: "localhost:3000",
      },
    ]);

    const processCount = runner.requests.length;
    await expect(service.snapshot([directory])).resolves.toBe(snapshot);
    expect(runner.requests).toHaveLength(processCount);

    const gitOnly = await service.snapshot([directory], {
      force: true,
      enrichProjectIds: new Set(["another-project"]),
    });
    expect(
      gitOnly.projects.flatMap((project) =>
        project.workspaces.flatMap((workspace) => workspace.observations),
      ),
    ).toEqual([]);
    expect(observedBranches.sort()).toEqual(["agent/auth", "main"]);

    const worktreeOnlySnapshot = await service.snapshot([worktree]);
    expect(worktreeOnlySnapshot.projects[0]?.rootPath).toBe(
      await realpath(repository),
    );
    expect(
      worktreeOnlySnapshot.projects[0]?.workspaces.find(
        (workspace) => workspace.isPrimary,
      )?.path,
    ).toBe(await realpath(repository));
  });

  it("keeps a project discoverable when a registered worktree directory is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "silvic-pruned-worktree-"));
    temporaryDirectories.push(directory);
    const repository = join(directory, "syntwin");
    const worktree = join(directory, "syntwin-agent");
    await git(directory, ["init", "--initial-branch=main", repository]);
    await git(repository, ["config", "user.email", "silvic@example.com"]);
    await git(repository, ["config", "user.name", "Silvic"]);
    await writeFile(join(repository, "README.md"), "# SynTwin\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    await git(repository, [
      "remote",
      "add",
      "origin",
      "git@github.com:Example/SynTwin.git",
    ]);
    await git(repository, ["worktree", "add", "-b", "agent/task", worktree]);
    // Git keeps reporting this worktree as prunable after the directory goes.
    await rm(worktree, { recursive: true, force: true });

    const service = new ProjectService({
      runner: new LocalCommandRunner(),
      connectors: new ConnectorRegistry([]),
    });

    const snapshot = await service.snapshot([repository]);

    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.rootPath).toBe(await realpath(repository));
    expect(
      snapshot.projects[0]?.workspaces.map((workspace) => workspace.branch),
    ).toEqual(["main"]);
  });
});

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execute("git", arguments_, { cwd });
}
