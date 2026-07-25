import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";

import type {
  Connector,
  ConnectorObservation,
  WorkspaceTarget,
} from "@silvic/contracts";
import type { CommandRunner } from "@silvic/core";

interface Listener {
  processId: number;
  name: string;
  cwd: string;
  url: string;
}

interface CodexTask {
  id: string;
  cwd: string;
  title: string;
}

export function createLocalContextConnector(runner: CommandRunner): Connector {
  let cache:
    | {
        createdAt: number;
        value: Promise<{
          listeners: readonly Listener[];
          tasks: readonly CodexTask[];
        }>;
      }
    | undefined;
  const readContext = () => {
    const now = Date.now();
    if (cache && now - cache.createdAt < 3_000) return cache.value;
    const value = Promise.all([
      readListeners(runner),
      readCodexTasks(runner),
    ]).then(([listeners, tasks]) => ({ listeners, tasks }));
    cache = { createdAt: now, value };
    return value;
  };

  return {
    manifest: {
      id: "local-context",
      name: "Local context",
      kind: "service",
      capabilities: ["observe"],
    },
    observe: async (target) => {
      const context = await readContext();
      return [
        ...context.listeners
          .filter((listener) => containsPath(target.path, listener.cwd))
          .map((listener) => runtimeObservation(target, listener)),
        ...context.tasks
          .filter((task) => normalize(task.cwd) === normalize(target.path))
          .map((task) => taskObservation(target, task)),
      ];
    },
  };
}

async function readListeners(
  runner: CommandRunner,
): Promise<readonly Listener[]> {
  const result = await runner.run({
    executable: "lsof",
    arguments: ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
  });
  if (result.exitCode !== 0) return [];
  const seeds = parseListenerSeeds(result.stdout);
  const listeners = await mapWithConcurrency(seeds, 6, async (seed) => {
    const cwdResult = await runner.run({
      executable: "lsof",
      arguments: ["-a", "-p", String(seed.processId), "-d", "cwd", "-Fn"],
    });
    const cwd = cwdResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("n/"))
      ?.slice(1);
    return cwd ? { ...seed, cwd } : undefined;
  });
  return listeners.filter((listener) => listener !== undefined);
}

async function readCodexTasks(
  runner: CommandRunner,
): Promise<readonly CodexTask[]> {
  const database = [
    join(homedir(), ".codex", "state_5.sqlite"),
    join(homedir(), ".codex", "sqlite", "state_5.sqlite"),
  ].find(existsSync);
  if (!database) return [];
  const query = `
    SELECT id, cwd, COALESCE(NULLIF(title, ''), 'Untitled') AS title
    FROM threads
    WHERE archived = 0 AND cwd <> ''
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
    LIMIT 500;
  `;
  const result = await runner.run({
    executable: "sqlite3",
    arguments: ["-json", database, query],
  });
  if (result.exitCode !== 0) return [];
  try {
    const value: unknown = JSON.parse(result.stdout);
    return Array.isArray(value)
      ? value.filter(
          (task): task is CodexTask =>
            typeof task === "object" &&
            task !== null &&
            "id" in task &&
            "cwd" in task &&
            "title" in task &&
            typeof task.id === "string" &&
            typeof task.cwd === "string" &&
            typeof task.title === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function parseListenerSeeds(output: string): readonly Omit<Listener, "cwd">[] {
  let processId: number | undefined;
  let name = "process";
  const seeds = new Map<string, Omit<Listener, "cwd">>();
  for (const line of output.split(/\r?\n/)) {
    const marker = line[0];
    const value = line.slice(1);
    if (marker === "p") processId = Number(value);
    else if (marker === "c") name = value;
    else if (marker === "n" && processId) {
      const match = value.match(/:(\d+)(?:\s|$)/);
      if (!match?.[1]) continue;
      const url = `http://localhost:${match[1]}`;
      seeds.set(`${processId}:${url}`, { processId, name, url });
    }
  }
  return [...seeds.values()];
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(normalize(parent), normalize(child));
  return (
    relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
  );
}

function runtimeObservation(
  target: WorkspaceTarget,
  listener: Listener,
): ConnectorObservation {
  return {
    connectorId: "local-context",
    workspaceId: target.workspaceId,
    kind: "runtime",
    state: "active",
    label: listener.name,
    detail: listener.url,
    url: listener.url,
    metadata: { processId: listener.processId },
  };
}

function taskObservation(
  target: WorkspaceTarget,
  task: CodexTask,
): ConnectorObservation {
  return {
    connectorId: "local-context",
    workspaceId: target.workspaceId,
    kind: "session",
    state: "ready",
    label: task.title,
    detail: "Codex task",
    metadata: { taskId: task.id },
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
