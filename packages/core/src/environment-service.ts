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
  /** Remote names, so `origin/feature-x` is told apart from a local branch. */
  remotes?: readonly string[];
}

/** A remote-tracking ref names its remote first: `origin/feature-x`. */
function isRemoteRef(ref: string, remotes: readonly string[]): boolean {
  return remotes.some((remote) => ref.startsWith(`${remote}/`));
}

/**
 * Three ways a worktree can come to hold a branch, and Git spells each
 * differently: cut a new one, take up a local one nothing has checked out, or
 * make a local one that follows somebody else's.
 */
function worktreeTarget(request: EnvironmentCreationOptions): string[] {
  if (!request.adopt) return ["-b", request.branch];
  return isRemoteRef(request.adopt, request.remotes ?? ["origin"])
    ? ["--track", "-b", request.branch]
    : [];
}

function worktreeStart(request: EnvironmentCreationOptions): string[] {
  if (!request.adopt) return [request.startPoint ?? "HEAD"];
  return [request.adopt];
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
          ...worktreeTarget(request),
          request.destinationPath,
          ...worktreeStart(request),
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
      "sourcePath" | "branch" | "destinationPath" | "adopt" | "remotes"
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
    const exists = existingBranch.exitCode === 0;

    if (request.adopt) {
      // Taking up a branch, so its existing is the point. What would stand in
      // the way is Git's own rule: one branch, at most one worktree.
      const remote = isRemoteRef(request.adopt, request.remotes ?? ["origin"]);
      if (remote && exists) {
        return `Branch ${request.branch} already exists here, so open that one rather than ${request.adopt}`;
      }
      const holder = await this.worktreeHolding(
        request.sourcePath,
        remote ? request.branch : request.adopt,
      );
      if (holder) {
        return `${request.adopt} is already open in ${holder}`;
      }
    } else if (exists) {
      return `Branch ${request.branch} already exists`;
    }

    try {
      await access(request.destinationPath);
      return "The destination already exists";
    } catch {
      return undefined;
    }
  }

  /** Which worktree holds a branch, since Git allows only one to. */
  private async worktreeHolding(
    sourcePath: string,
    branch: string,
  ): Promise<string | undefined> {
    const result = await this.runner.run({
      executable: "git",
      arguments: ["worktree", "list", "--porcelain"],
      cwd: sourcePath,
      environment: { GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.exitCode !== 0) return undefined;
    let path: string | undefined;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      if (line === `branch refs/heads/${branch}`) return path;
    }
    return undefined;
  }
}
