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
  processGroupId?: number;
  processLineage?: readonly number[];
  name: string;
  cwd: string;
  url: string;
}

interface CodexTask {
  id: string;
  cwd: string;
  title: string;
}

interface Shelf<T> {
  createdAt: number;
  value: Promise<T>;
}

/**
 * The listener scan walks every open TCP socket on the machine and follows up
 * with lsof and ps per process — the most expensive look the polling loop
 * takes. It keeps for a minute: Silvic's own starts and stops invalidate the
 * shelf explicitly, so the only thing that can arrive late is a dev server
 * started by hand in some terminal. The Codex read is one cheap sqlite query
 * and stays near-live.
 */
const listenerShelfLifeMs = 60_000;
const taskShelfLifeMs = 3_000;

export function createLocalContextConnector(runner: CommandRunner): Connector {
  let listeners: Shelf<readonly Listener[]> | undefined;
  let tasks: Shelf<readonly CodexTask[]> | undefined;
  const readContext = () => {
    const now = Date.now();
    if (!listeners || now - listeners.createdAt >= listenerShelfLifeMs) {
      listeners = { createdAt: now, value: readListeners(runner) };
    }
    if (!tasks || now - tasks.createdAt >= taskShelfLifeMs) {
      tasks = { createdAt: now, value: readCodexTasks(runner) };
    }
    return Promise.all([listeners.value, tasks.value]).then(
      ([listenerValues, taskValues]) => ({
        listeners: listenerValues,
        tasks: taskValues,
      }),
    );
  };

  return {
    manifest: {
      id: "local-context",
      name: "Local context",
      kind: "service",
      capabilities: ["observe"],
    },
    invalidate: () => {
      listeners = undefined;
      tasks = undefined;
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
  const treeResult = await runner.run({
    executable: "ps",
    arguments: ["-axo", "pid=,ppid="],
  });
  const parents = parseProcessParents(treeResult.stdout);
  const listeners = await mapWithConcurrency(seeds, 6, async (seed) => {
    const cwdResult = await runner.run({
      executable: "lsof",
      arguments: ["-a", "-p", String(seed.processId), "-d", "cwd", "-Fn"],
    });
    const cwd = cwdResult.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("n/"))
      ?.slice(1);
    if (!cwd) return undefined;
    const groupResult = await runner.run({
      executable: "ps",
      arguments: ["-o", "pgid=", "-p", String(seed.processId)],
    });
    const processGroupId = Number(groupResult.stdout.trim());
    const lineage = processLineage(seed.processId, parents);
    return {
      ...seed,
      cwd,
      ...(lineage ? { processLineage: lineage } : {}),
      ...(Number.isSafeInteger(processGroupId) && processGroupId > 0
        ? { processGroupId }
        : {}),
    };
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
    metadata: {
      processId: listener.processId,
      ...(listener.processGroupId === undefined
        ? {}
        : { processGroupId: listener.processGroupId }),
      ...(listener.processLineage === undefined
        ? {}
        : { processLineage: listener.processLineage }),
    },
  };
}

function parseProcessParents(output: string): ReadonlyMap<number, number> {
  return new Map(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(
        (pair): pair is [number, number] =>
          pair.length === 2 && pair.every(Number.isSafeInteger),
      ),
  );
}

function processLineage(
  processId: number,
  parents: ReadonlyMap<number, number>,
): readonly number[] | undefined {
  const lineage = [processId];
  let current = processId;
  while (lineage.length < 16) {
    const parent = parents.get(current);
    if (!parent || parent === current) break;
    lineage.push(parent);
    current = parent;
  }
  return lineage.length > 1 ? lineage : undefined;
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
