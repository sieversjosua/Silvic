import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { Connector } from "@silvic/contracts";

import { ConnectorRegistry } from "./connector-registry";
import { LocalCommandRunner } from "./command-runner";
import { ProjectService } from "./project-service";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

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

    const connector: Connector = {
      manifest: {
        id: "test-runtime",
        name: "Test runtime",
        kind: "service",
        capabilities: ["observe"],
      },
      observe: async (target) =>
        target.branch === "agent/auth"
          ? [
              {
                connectorId: "test-runtime",
                workspaceId: target.workspaceId,
                kind: "runtime",
                state: "active",
                label: "localhost:3000",
              },
            ]
          : [],
    };
    const service = new ProjectService({
      runner: new LocalCommandRunner(),
      connectors: new ConnectorRegistry([connector]),
    });

    const snapshot = await service.snapshot([directory]);

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
});

async function git(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execute("git", arguments_, { cwd });
}
