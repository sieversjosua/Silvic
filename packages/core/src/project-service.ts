import { readdir, stat } from "node:fs/promises";
import { basename, join, normalize } from "node:path";

import type {
  ConnectorFailure,
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import type { ConnectorRegistry } from "./connector-registry";
import { readRepository } from "./git";

export interface ProjectServiceOptions {
  runner: CommandRunner;
  connectors: ConnectorRegistry;
}

export class ProjectService {
  constructor(private readonly options: ProjectServiceOptions) {}

  async snapshot(
    roots: readonly string[],
    signal?: AbortSignal,
  ): Promise<SilvicSnapshot> {
    const repositoryPaths = await discoverRepositories(roots);
    const repositories = (
      await mapWithConcurrency(repositoryPaths, 8, async (path) => {
        try {
          return await readRepository(this.options.runner, path, signal);
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
        const enriched = await mapWithConcurrency(
          workspaces,
          2,
          async (workspace) => {
            const result = await this.options.connectors.observe(
              workspace,
              signal,
            );
            connectorFailures.push(...result.failures);
            return {
              ...workspace,
              observations: result.observations,
            } satisfies WorkspaceSnapshot;
          },
        );
        return {
          id,
          name: preferred.name,
          rootPath: preferred.rootPath,
          ...(preferred.origin ? { origin: preferred.origin } : {}),
          workspaces: enriched.sort(
            (left, right) =>
              Number(right.isPrimary) - Number(left.isPrimary) ||
              left.name.localeCompare(right.name),
          ),
        } satisfies ProjectSnapshot;
      },
    );

    return {
      projects: projects.sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      connectorFailures: uniqueFailures(connectorFailures),
      refreshedAt: new Date().toISOString(),
    };
  }
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
  return [...repositories].sort((left, right) =>
    basename(left).localeCompare(basename(right)),
  );
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
