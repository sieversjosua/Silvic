import { readdir, readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

import type {
  Connector,
  ConnectorObservation,
  WorkspaceTarget,
} from "@silvic/contracts";

const observationShelfLifeMs = 5 * 60_000;
const observationCache = new Map<
  string,
  {
    projectId: string;
    createdAt: number;
    value: Promise<readonly ConnectorObservation[]>;
  }
>();

export const convexConnector: Connector = {
  manifest: {
    id: "convex",
    name: "Convex",
    kind: "service",
    capabilities: ["observe"],
  },
  invalidate: (scope) => {
    if (!scope) {
      observationCache.clear();
      return;
    }
    for (const [path, entry] of observationCache) {
      if (
        (scope.workspacePath && normalize(scope.workspacePath) === path) ||
        (scope.projectId && scope.projectId === entry.projectId)
      ) {
        observationCache.delete(path);
      }
    }
  },
  observe: (target) => {
    const key = normalize(target.path);
    const cached = observationCache.get(key);
    const now = Date.now();
    if (cached && now - cached.createdAt < observationShelfLifeMs) {
      return cached.value;
    }
    const value = discoverDeployments(target);
    observationCache.set(key, {
      projectId: target.projectId,
      createdAt: now,
      value,
    });
    return value;
  },
};

async function discoverDeployments(
  target: WorkspaceTarget,
): Promise<readonly ConnectorObservation[]> {
  const files = await findEnvironmentFiles(target.path, 4);
  const observations = (
    await mapWithConcurrency(files, 8, async (file) => {
      try {
        const values = parseEnvironmentFile(await readFile(file, "utf8"));
        const deployment = values.CONVEX_DEPLOYMENT;
        if (!deployment) return undefined;
        // `dev:reliable-curlew-319 # team: syntwin, project: mono` — the
        // comment carries the team and project, and belongs to neither the
        // kind nor the name. Splitting on a limit would keep half of it.
        const separator = deployment.indexOf(":");
        const kind = separator > 0 ? deployment.slice(0, separator) : "unknown";
        const name =
          (separator > 0 ? deployment.slice(separator + 1) : deployment)
            .split("#")[0]
            ?.trim() || deployment;
        const deploymentUrl =
          values.NEXT_PUBLIC_CONVEX_URL ?? values.CONVEX_URL;
        const dashboard = dashboardUrl(kind, name);
        return {
          connectorId: "convex",
          workspaceId: target.workspaceId,
          kind: "deployment",
          state: "active",
          label: name,
          detail: kind,
          // Somewhere worth arriving. The deployment's own address answers
          // clients, not people: opening it in a browser shows nothing you
          // could do anything with. It is kept for whoever needs to call it.
          ...((dashboard ?? deploymentUrl)
            ? { url: dashboard ?? deploymentUrl }
            : {}),
          metadata: {
            source: relative(target.path, file),
            ...(deploymentUrl ? { deploymentUrl } : {}),
          },
        } satisfies ConnectorObservation;
      } catch {
        return undefined;
      }
    })
  ).filter((observation) => observation !== undefined);
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = `${observation.detail}:${observation.label}:${observation.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where a person can actually act on a deployment. This is the address the
 * Convex CLI itself opens for `npx convex dashboard`. Only cloud deployments
 * live there: a local or anonymous one is served from the machine it runs on,
 * and pointing at the cloud dashboard for it would be a dead end.
 */
function dashboardUrl(kind: string, name: string): string | undefined {
  if (kind !== "dev" && kind !== "prod") return undefined;
  return `https://dashboard.convex.dev/d/${encodeURIComponent(name)}`;
}

async function findEnvironmentFiles(
  root: string,
  maximumDepth: number,
): Promise<string[]> {
  const result: string[] = [];
  const ignored = new Set([".git", ".next", "node_modules", "vendor"]);

  async function inspect(
    path: string,
    depth: number,
  ): Promise<readonly { path: string; depth: number }[]> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return [];
    }
    if (
      entries.some((entry) => entry.isFile() && entry.name === ".env.local")
    ) {
      result.push(join(path, ".env.local"));
    }
    if (depth >= maximumDepth) return [];
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !ignored.has(entry.name),
      )
      .map((entry) => ({ path: join(path, entry.name), depth: depth + 1 }));
  }

  const queue = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry) queue.push(...(await inspect(entry.path, entry.depth)));
  }
  return result.sort();
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

function parseEnvironmentFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
