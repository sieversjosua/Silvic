import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalCommandRunner, requireSuccess } from "./command-runner";
import { EnvironmentService } from "./environment-service";

describe("EnvironmentService", () => {
  it("creates a linked worktree from an existing workspace", async () => {
    const runner = new LocalCommandRunner();
    const directory = await mkdtemp(join(tmpdir(), "silvic-environment-"));
    const repository = join(directory, "project");
    const destination = join(directory, "project-feature");

    await requireSuccess(runner, {
      executable: "git",
      arguments: ["init", "--initial-branch=main", repository],
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: [
        "-c",
        "user.email=silvic@example.test",
        "-c",
        "user.name=Silvic Test",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      ],
      cwd: repository,
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["config", "user.email", "silvic@example.test"],
      cwd: repository,
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["config", "user.name", "Silvic Test"],
      cwd: repository,
    });
    await writeFile(join(repository, "README.md"), "root\n");
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["add", "README.md"],
      cwd: repository,
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["commit", "-m", "Initial"],
      cwd: repository,
    });

    const service = new EnvironmentService(runner);
    await service.create({
      sourcePath: repository,
      destinationPath: destination,
      branch: "feature/agent-ready",
      mode: "worktree",
    });

    expect(
      (await readFile(join(destination, "README.md"), "utf8")).trim(),
    ).toBe("root");
    expect(
      (
        await requireSuccess(runner, {
          executable: "git",
          arguments: ["branch", "--show-current"],
          cwd: destination,
        })
      ).trim(),
    ).toBe("feature/agent-ready");
  });

  it("rejects an existing branch without leaving a partial clone", async () => {
    const runner = new LocalCommandRunner();
    const directory = await mkdtemp(join(tmpdir(), "silvic-environment-"));
    const repository = join(directory, "project");
    const destination = join(directory, "project-main");
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["init", "--initial-branch=main", repository],
    });
    await requireSuccess(runner, {
      executable: "git",
      arguments: [
        "-c",
        "user.email=silvic@example.test",
        "-c",
        "user.name=Silvic Test",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
      ],
      cwd: repository,
    });

    const service = new EnvironmentService(runner);
    await expect(
      service.create({
        sourcePath: repository,
        destinationPath: destination,
        branch: "main",
        mode: "clone",
      }),
    ).rejects.toThrow("already exists");
    await expect(access(destination)).rejects.toThrow();
  });
});
