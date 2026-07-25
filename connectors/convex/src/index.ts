import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type {
  Connector,
  ConnectorObservation,
  WorkspaceTarget,
} from "@silvic/contracts";

export const convexConnector: Connector = {
  manifest: {
    id: "convex",
    name: "Convex",
    kind: "service",
    capabilities: ["observe"],
  },
  observe: async (target) => discoverDeployments(target),
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
        const [kind = "unknown", name = deployment] = deployment.split(":", 2);
        const url = values.NEXT_PUBLIC_CONVEX_URL ?? values.CONVEX_URL;
        return {
          connectorId: "convex",
          workspaceId: target.workspaceId,
          kind: "deployment",
          state: "active",
          label: name,
          detail: kind,
          ...(url ? { url } : {}),
          metadata: {
            source: relative(target.path, file),
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
