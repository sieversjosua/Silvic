import { createHash } from "node:crypto";
import { basename, normalize } from "node:path";

import type { GitStatus, WorkspaceSnapshot } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import { requireSuccess } from "./command-runner";

interface WorktreeRegistration {
  path: string;
  branch?: string;
  revision?: string;
  bare: boolean;
}

export interface RepositoryReadResult {
  name: string;
  rootPath: string;
  origin?: string;
  projectId: string;
  workspaces: readonly WorkspaceSnapshot[];
  /** Every local branch, so a name can be refused as it is typed. */
  branches: readonly string[];
}

export async function readRepository(
  runner: CommandRunner,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<RepositoryReadResult> {
  const discoveryPath = normalize(repositoryPath);
  const [worktreeOutput, originResult, branchResult] = await Promise.all([
    requireSuccess(runner, {
      executable: "git",
      arguments: ["worktree", "list", "--porcelain"],
      cwd: discoveryPath,
      environment: { GIT_OPTIONAL_LOCKS: "0" },
      ...(signal ? { signal } : {}),
    }),
    runner.run({
      executable: "git",
      arguments: ["remote", "get-url", "origin"],
      cwd: discoveryPath,
      environment: { GIT_OPTIONAL_LOCKS: "0" },
      ...(signal ? { signal } : {}),
    }),
    runner.run({
      executable: "git",
      arguments: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      cwd: discoveryPath,
      environment: { GIT_OPTIONAL_LOCKS: "0" },
      ...(signal ? { signal } : {}),
    }),
  ]);
  const branches =
    branchResult.exitCode === 0
      ? branchResult.stdout.split("\n").filter(Boolean)
      : [];
  const origin =
    originResult.exitCode === 0
      ? originResult.stdout.trim() || undefined
      : undefined;
  const registrations = parseWorktrees(worktreeOutput).filter(
    (registration) => !registration.bare,
  );
  const rootPath = normalize(registrations[0]?.path ?? discoveryPath);
  const projectId = projectIdentity(origin, rootPath);
  const readWorkspaces = await mapWithConcurrency(
    registrations,
    6,
    async (registration) => {
      let statusOutput: string;
      try {
        statusOutput = await requireSuccess(runner, {
          executable: "git",
          arguments: ["status", "--porcelain=v2", "--branch"],
          cwd: registration.path,
          environment: { GIT_OPTIONAL_LOCKS: "0" },
          ...(signal ? { signal } : {}),
        });
      } catch {
        // `git worktree list` still reports prunable worktrees whose directory
        // is gone. Dropping that one registration keeps the rest of the
        // Project visible instead of losing the repository entirely.
        return undefined;
      }
      const git = parseGitStatus(statusOutput);
      const path = normalize(registration.path);
      const branch =
        git.branch === "(detached)"
          ? (registration.branch ?? "(detached)")
          : git.branch;
      return {
        workspaceId: workspaceId(path),
        projectId,
        path,
        repositoryName: basename(rootPath),
        branch,
        name: branch === "(detached)" ? basename(path) : branch,
        locationKind: path === rootPath ? "checkout" : "worktree",
        isPrimary: path === rootPath,
        git,
        observations: [],
      } satisfies WorkspaceSnapshot;
    },
  );
  const workspaces = readWorkspaces.filter(
    (workspace) => workspace !== undefined,
  );

  return {
    name: basename(rootPath),
    rootPath,
    ...(origin ? { origin } : {}),
    projectId,
    workspaces,
    branches,
  };
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex++;
        const input = inputs[index];
        if (input !== undefined) results[index] = await operation(input);
      }
    }),
  );
  return results;
}

export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = {
    branch: "unknown",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      status.revision = line.slice("# branch.oid ".length);
    } else if (line.startsWith("# branch.head ")) {
      const branch = line.slice("# branch.head ".length);
      status.branch = branch === "(detached)" ? "(detached)" : branch;
    } else if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      status.ahead = Number(match?.[1] ?? 0);
      status.behind = Number(match?.[2] ?? 0);
    } else if (line.startsWith("? ")) {
      status.untracked += 1;
    } else if (line.startsWith("u ")) {
      status.conflicted += 1;
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.split(" ")[1] ?? "..";
      if (xy[0] !== ".") status.staged += 1;
      if (xy[1] !== ".") status.unstaged += 1;
    }
  }
  return status;
}

/**
 * A browsable address for the origin, so the project can link to where it
 * lives. SSH and HTTPS remotes both resolve; anything unrecognised gets
 * nothing rather than a guess.
 */
export function remoteWebUrl(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const trimmed = origin.trim().replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp?.[1] && scp[2]) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `https://${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function projectIdentity(
  origin: string | undefined,
  rootPath: string,
): string {
  if (!origin) return normalize(rootPath);
  const trimmed = origin.trim().replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) {
    const host = scp[1]?.toLowerCase() ?? "";
    return `${host}/${normalizeRemotePath(host, scp[2] ?? "")}`;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol === "file:") return normalize(url.pathname);
    const host = url.hostname.toLowerCase();
    const authority = url.port ? `${host}:${url.port}` : host;
    return `${authority}/${normalizeRemotePath(host, url.pathname.replace(/^\/+/, ""))}`;
  } catch {
    return trimmed.startsWith("/") ? normalize(trimmed) : trimmed;
  }
}

function normalizeRemotePath(host: string, path: string): string {
  const withoutSuffix = path.replace(/\.git$/, "");
  return new Set(["github.com", "gitlab.com", "bitbucket.org"]).has(host)
    ? withoutSuffix.toLowerCase()
    : withoutSuffix;
}

function workspaceId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 20);
}

function parseWorktrees(output: string): WorktreeRegistration[] {
  return output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const registration: WorktreeRegistration = { path: "", bare: false };
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) registration.path = line.slice(9);
        else if (line.startsWith("HEAD "))
          registration.revision = line.slice(5);
        else if (line.startsWith("branch ")) {
          registration.branch = line.slice(7).replace(/^refs\/heads\//, "");
        } else if (line === "bare") registration.bare = true;
      }
      return registration;
    })
    .filter((registration) => registration.path.length > 0);
}
