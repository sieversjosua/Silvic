import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceTarget } from "@silvic/contracts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import { createWorkCliConnector } from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("work-cli connector", () => {
  it("attaches only commands whose recorded workspace root matches the target", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "silvic-work-cli-"));
    temporaryDirectories.push(stateRoot);
    const target: WorkspaceTarget = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      path: "/projects/silvic-auth",
      repositoryName: "silvic",
      branch: "agent/auth",
    };
    const stateDirectory = join(
      stateRoot,
      "projects",
      "silvic",
      "workspaces",
      "auth",
    );
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "state.json"),
      JSON.stringify({ root: target.path }),
    );
    const runner = new StaticRunner({
      exitCode: 0,
      stdout: "running silvic/auth dev bun abc123 http://localhost:3000\n",
      stderr: "",
    });

    const observations = await createWorkCliConnector(
      runner,
      stateRoot,
    ).observe(target);

    expect(observations).toEqual([
      {
        connectorId: "work-cli",
        workspaceId: "workspace-1",
        kind: "runtime",
        state: "active",
        label: "dev",
        detail: "running via bun",
        url: "http://localhost:3000",
        metadata: {
          handle: "abc123",
        },
      },
    ]);
  });
});

class StaticRunner implements CommandRunner {
  constructor(private readonly result: CommandResult) {}

  async run(_request: CommandRequest): Promise<CommandResult> {
    return this.result;
  }
}
