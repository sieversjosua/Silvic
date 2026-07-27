import { access, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

import type { CreateEnvironmentRequest } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import { requireSuccess } from "./command-runner";

export interface EnvironmentCreationOptions extends CreateEnvironmentRequest {
  /** Decided by the recipe, not by the caller of the IPC request. */
  destinationPath: string;
  origin?: string;
  startPoint?: string;
}

export class EnvironmentService {
  constructor(private readonly runner: CommandRunner) {}

  async create(request: EnvironmentCreationOptions): Promise<void> {
    const conflict = await this.conflict(request);
    if (conflict) throw new Error(conflict);

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

  /**
   * What stands in the way of creating this plot, said the way a person would
   * be told. Answering instead of throwing lets the same question be asked
   * before anything is attempted, so a name that cannot work is refused while
   * it is still being typed rather than halfway through a creation.
   */
  async conflict(
    request: Pick<
      EnvironmentCreationOptions,
      "sourcePath" | "branch" | "destinationPath"
    >,
  ): Promise<string | undefined> {
    const branchResult = await this.runner.run({
      executable: "git",
      arguments: ["check-ref-format", "--branch", request.branch],
      cwd: request.sourcePath,
    });
    if (branchResult.exitCode !== 0) return "Enter a valid Git branch name";

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
      return `Branch ${request.branch} already exists`;
    }

    try {
      await access(request.destinationPath);
      return "The destination already exists";
    } catch {
      return undefined;
    }
  }
}
