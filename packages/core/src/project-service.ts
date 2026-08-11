import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";

import type {
  ConnectorFailure,
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import type { ConnectorRegistry } from "./connector-registry";
import { readRepository, remoteWebUrl } from "./git";

export interface ProjectServiceOptions {
  runner: CommandRunner;
  connectors: ConnectorRegistry;
}

export interface ProjectSnapshotOptions {
  signal?: AbortSignal;
  /** Re-read the filesystem and external tools even when this query is cached. */
  force?: boolean;
  /** Projects outside this set remain Git-only suggestions. */
  enrichProjectIds?: ReadonlySet<string>;
}

function remoteUrlFor(origin: string | undefined): { remoteUrl?: string } {
  const remoteUrl = remoteWebUrl(origin);
  return remoteUrl ? { remoteUrl } : {};
}

export class ProjectService {
  private readonly snapshots = new Map<string, SilvicSnapshot>();

  constructor(private readonly options: ProjectServiceOptions) {}

  async snapshot(
    roots: readonly string[],
    options: ProjectSnapshotOptions = {},
  ): Promise<SilvicSnapshot> {
    const cacheKey = snapshotCacheKey(roots, options.enrichProjectIds);
    const cached = this.snapshots.get(cacheKey);
    if (!options.force && cached) return cached;
    const repositoryPaths = await discoverRepositories(roots);
    const repositories = (
      await mapWithConcurrency(repositoryPaths, 8, async (path) => {
        try {
          return await readRepository(
            this.options.runner,
            path,
            options.signal,
          );
        } catch {
          return undefined;
        }
      })
    ).filter((repository) => repository !== undefined);

    const groups = Map.groupBy(
      repositories,
      (repository) => repository.projectId,
    );
    const connectorFailures: ConnectorFailure[] = [];
    const projects = await mapWithConcurrency(
      [...groups.entries()],
      4,
      async ([id, members]) => {
        const preferred =
          members.find((member) =>
            member.workspaces.some(
              (workspace) =>
                workspace.isPrimary &&
                ["main", "master"].includes(workspace.branch),
            ),
          ) ?? members[0];
        if (!preferred) throw new Error(`Project ${id} has no repository`);
        const seen = new Set<string>();
        const workspaces = members
          .flatMap((member) => member.workspaces)
          .filter((workspace) => {
            if (seen.has(workspace.workspaceId)) return false;
            seen.add(workspace.workspaceId);
            return true;
          })
          .map((workspace) => ({
            ...workspace,
            isPrimary:
              normalize(workspace.path) === normalize(preferred.rootPath),
          }));
        const shouldEnrich =
          options.enrichProjectIds === undefined ||
          options.enrichProjectIds.has(id);
        const enriched = shouldEnrich
          ? await mapWithConcurrency(workspaces, 2, async (workspace) => {
              const result = await this.options.connectors.observe(
                {
                  ...workspace,
                  ...(preferred.origin ? { origin: preferred.origin } : {}),
                },
                options.signal,
              );
              connectorFailures.push(...result.failures);
              return {
                ...workspace,
                observations: result.observations,
              } satisfies WorkspaceSnapshot;
            })
          : workspaces;
        return {
          id,
          name: preferred.name,
          rootPath: preferred.rootPath,
          ...(preferred.origin ? { origin: preferred.origin } : {}),
          ...remoteUrlFor(preferred.origin),
          // A project's branches live in one ref store however many worktrees
          // are checked out of it, so any member answers for all of them.
          branches: [
            ...new Set(members.flatMap((member) => member.branches)),
          ].sort(),
          remoteBranches: [
            ...new Set(members.flatMap((member) => member.remoteBranches)),
          ].sort(),
          workspaces: enriched.sort(
            (left, right) =>
              Number(right.isPrimary) - Number(left.isPrimary) ||
              left.name.localeCompare(right.name),
          ),
        } satisfies ProjectSnapshot;
      },
    );

    const snapshot = {
      projects: projects.sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      connectorFailures: uniqueFailures(connectorFailures),
      refreshedAt: new Date().toISOString(),
    };
    this.snapshots.set(cacheKey, snapshot);
    return snapshot;
  }
}

function snapshotCacheKey(
  roots: readonly string[],
  enrichProjectIds: ReadonlySet<string> | undefined,
): string {
  const paths = roots.map(normalize).sort();
  const projects = enrichProjectIds ? [...enrichProjectIds].sort() : ["*"];
  return JSON.stringify([paths, projects]);
}

export async function discoverRepositories(
  roots: readonly string[],
): Promise<readonly string[]> {
  const repositories = new Set<string>();
  const ignored = new Set([
    ".build",
    ".cache",
    ".git",
    ".next",
    ".pnpm-store",
    "DerivedData",
    "node_modules",
    "Pods",
    "vendor",
  ]);

  async function inspect(path: string): Promise<readonly string[]> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
    if (entries.some((entry) => entry.name === ".git")) {
      repositories.add(normalize(path));
      return [];
    }
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !ignored.has(entry.name),
      )
      .map((entry) => join(path, entry.name));
  }

  for (const root of roots) {
    try {
      if (!(await stat(root)).isDirectory()) continue;
      const queue = [normalize(root)];
      while (queue.length > 0) {
        const path = queue.shift();
        if (path) queue.push(...(await inspect(path)));
      }
    } catch {
      // Missing roots are expected when a removable volume is offline.
    }
  }
  const representatives = new Map<string, { path: string; primary: boolean }>();
  for (const path of repositories) {
    const family = await repositoryFamily(path);
    const known = representatives.get(family.key);
    if (!known || (!known.primary && family.primary)) {
      representatives.set(family.key, { path, primary: family.primary });
    }
  }
  return [...representatives.values()]
    .map(({ path }) => path)
    .sort((left, right) => basename(left).localeCompare(basename(right)));
}

/**
 * Linked worktrees carry a `.git` file pointing into the primary checkout's
 * shared administrative directory. Group them before asking Git anything, so
 * one family is never read once per worktree.
 */
async function repositoryFamily(
  path: string,
): Promise<{ key: string; primary: boolean }> {
  const gitPath = join(path, ".git");
  try {
    const information = await stat(gitPath);
    if (information.isDirectory()) {
      return { key: normalize(await realpath(gitPath)), primary: true };
    }
    const contents = await readFile(gitPath, "utf8");
    const target = contents.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!target) return { key: normalize(gitPath), primary: false };
    const gitDirectory = normalize(await realpath(resolve(path, target)));
    const container = dirname(gitDirectory);
    const commonDirectory =
      basename(container) === "worktrees" ? dirname(container) : gitDirectory;
    return { key: commonDirectory, primary: false };
  } catch {
    return { key: normalize(gitPath), primary: false };
  }
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex++;
        const input = inputs[index];
        if (input !== undefined) results[index] = await operation(input);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function uniqueFailures(
  failures: readonly ConnectorFailure[],
): ConnectorFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.connectorId}:${failure.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
