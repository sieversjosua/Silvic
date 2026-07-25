import { access, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

import type { CreateEnvironmentRequest } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import { requireSuccess } from "./command-runner";

export interface EnvironmentCreationOptions extends CreateEnvironmentRequest {
  origin?: string;
  startPoint?: string;
}

export class EnvironmentService {
  constructor(private readonly runner: CommandRunner) {}

  async create(request: EnvironmentCreationOptions): Promise<void> {
    await this.validate(request);

    if (request.mode === "worktree") {
      await requireSuccess(this.runner, {
        executable: "git",
        arguments: [
          "worktree",
          "add",
          "-b",
          request.branch,
          request.destinationPath,
          request.startPoint ?? "HEAD",
        ],
        cwd: request.sourcePath,
      });
      return;
    }

    const temporaryDestination = `${request.destinationPath}.silvic-${randomUUID()}.tmp`;
    try {
      await requireSuccess(this.runner, {
        executable: "git",
        arguments: [
          "clone",
          "--no-hardlinks",
          request.sourcePath,
          temporaryDestination,
        ],
      });
      if (request.origin) {
        await requireSuccess(this.runner, {
          executable: "git",
          arguments: ["remote", "set-url", "origin", request.origin],
          cwd: temporaryDestination,
        });
      }
      await requireSuccess(this.runner, {
        executable: "git",
        arguments: [
          "switch",
          "-c",
          request.branch,
          request.startPoint ?? "HEAD",
        ],
        cwd: temporaryDestination,
      });
      await rename(temporaryDestination, request.destinationPath);
    } catch (error) {
      await rm(temporaryDestination, { recursive: true, force: true });
      throw error;
    }
  }

  private async validate(request: EnvironmentCreationOptions): Promise<void> {
    const branchResult = await this.runner.run({
      executable: "git",
      arguments: ["check-ref-format", "--branch", request.branch],
      cwd: request.sourcePath,
    });
    if (branchResult.exitCode !== 0)
      throw new Error("Enter a valid Git branch name");

    const existingBranch = await this.runner.run({
      executable: "git",
      arguments: [
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${request.branch}`,
      ],
      cwd: request.sourcePath,
    });
    if (existingBranch.exitCode === 0) {
      throw new Error(`Branch ${request.branch} already exists`);
    }

    try {
      await access(request.destinationPath);
      throw new Error("The destination already exists");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "The destination already exists"
      )
        throw error;
    }
  }
}
