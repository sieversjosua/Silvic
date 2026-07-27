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

  it("answers what stands in the way before anything is attempted", async () => {
    const runner = new LocalCommandRunner();
    const directory = await mkdtemp(join(tmpdir(), "silvic-environment-"));
    const repository = join(directory, "project");

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
    const ask = (branch: string) =>
      service.conflict({
        sourcePath: repository,
        branch,
        destinationPath: join(directory, "project-anything"),
      });

    // The same sentences creation would have thrown, without creating.
    await expect(ask("main")).resolves.toBe("Branch main already exists");
    await expect(ask("feature/..bad")).resolves.toMatch(/valid Git branch/i);
    await expect(ask("feature/fine")).resolves.toBeUndefined();

    // And the destination, which is what a repeated plot name collides with.
    await expect(
      service.conflict({
        sourcePath: repository,
        branch: "feature/fine",
        destinationPath: repository,
      }),
    ).resolves.toMatch(/destination already exists/i);
  });

  it("takes up a branch that already exists instead of cutting a new one", async () => {
    const runner = new LocalCommandRunner();
    const directory = await mkdtemp(join(tmpdir(), "silvic-environment-"));
    const repository = join(directory, "project");
    const destination = join(directory, "project-existing");

    await requireSuccess(runner, {
      executable: "git",
      arguments: ["init", "--initial-branch=main", repository],
    });
    const commit = ["-c", "user.email=silvic@example.test", "-c", "user.name=Silvic Test"];
    await requireSuccess(runner, {
      executable: "git",
      arguments: [...commit, "commit", "--allow-empty", "-m", "Initial"],
      cwd: repository,
    });
    // Somebody else's branch, already in the repository.
    await requireSuccess(runner, {
      executable: "git",
      arguments: ["branch", "colleague/work"],
      cwd: repository,
    });

    await new EnvironmentService(runner).create({
      sourcePath: repository,
      destinationPath: destination,
      branch: "colleague/work",
      mode: "worktree",
      adopt: "colleague/work",
    });

    const head = await requireSuccess(runner, {
      executable: "git",
      arguments: ["rev-parse", "--abbrev-ref", "HEAD"],
      cwd: destination,
    });
    expect(head.trim()).toBe("colleague/work");
    // And Git's one-worktree-per-branch rule is now what stands in the way.
    await expect(
      new EnvironmentService(runner).conflict({
        sourcePath: repository,
        branch: "colleague/work",
        destinationPath: join(directory, "project-again"),
        adopt: "colleague/work",
      }),
    ).resolves.toMatch(/already open in/i);
  });
});
