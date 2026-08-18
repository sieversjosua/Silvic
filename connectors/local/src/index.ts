import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize, relative } from "node:path";

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

/** Which harness recorded a session, for the line under its label. */
export type SessionHarness = "codex" | "t3-code" | "claude";

export interface AgentSession {
  id: string;
  cwd: string;
  title: string;
  updatedAtMs: number;
  harness: SessionHarness;
}

const harnessDetail: Record<SessionHarness, string> = {
  codex: "Codex task",
  "t3-code": "T3 Code session",
  claude: "Claude Code session",
};

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
const taskShelfLifeMs = 30_000;

/** Where the other harnesses keep their session records, for tests. */
export interface LocalContextSources {
  /** Claude Code's transcript folders. */
  claudeProjects?: string;
  /** T3 Code's projection database. */
  t3Database?: string;
}

export function createLocalContextConnector(
  runner: CommandRunner,
  sources: LocalContextSources = {},
): Connector {
  let listeners: Shelf<readonly Listener[]> | undefined;
  let sessions: Shelf<readonly AgentSession[]> | undefined;
  const readContext = () => {
    const now = Date.now();
    if (!listeners || now - listeners.createdAt >= listenerShelfLifeMs) {
      listeners = { createdAt: now, value: readListeners(runner) };
    }
    if (!sessions || now - sessions.createdAt >= taskShelfLifeMs) {
      sessions = {
        createdAt: now,
        value: readAgentSessions(runner, sources),
      };
    }
    return Promise.all([listeners.value, sessions.value]).then(
      ([listenerValues, sessionValues]) => ({
        listeners: listenerValues,
        sessions: sessionValues,
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
      sessions = undefined;
    },
    observe: async (target) => {
      const context = await readContext();
      return [
        ...context.listeners
          .filter((listener) => containsPath(target.path, listener.cwd))
          .map((listener) => runtimeObservation(target, listener)),
        ...context.sessions
          .filter((session) => sessionMatches(target.path, session))
          .map((session) => sessionObservation(target, session)),
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
  if (seeds.length === 0) return [];
  const treeResult = await runner.run({
    executable: "ps",
    arguments: ["-axo", "pid=,ppid="],
  });
  const parents = parseProcessParents(treeResult.stdout);
  const processIds = [...new Set(seeds.map((seed) => seed.processId))];
  const processList = processIds.join(",");
  const [cwdResult, groupResult] = await Promise.all([
    runner.run({
      executable: "lsof",
      arguments: ["-a", "-p", processList, "-d", "cwd", "-Fpn"],
    }),
    runner.run({
      executable: "ps",
      arguments: ["-o", "pid=,pgid=", "-p", processList],
    }),
  ]);
  const workingDirectories = parseProcessWorkingDirectories(cwdResult.stdout);
  const processGroups = parseProcessGroups(groupResult.stdout);
  const listeners = seeds.map((seed) => {
    const cwd = workingDirectories.get(seed.processId);
    if (!cwd) return undefined;
    const processGroupId = processGroups.get(seed.processId);
    const lineage = processLineage(seed.processId, parents);
    return {
      ...seed,
      cwd,
      ...(lineage ? { processLineage: lineage } : {}),
      ...(processGroupId !== undefined && processGroupId > 0
        ? { processGroupId }
        : {}),
    };
  });
  return listeners.filter((listener) => listener !== undefined);
}

function parseProcessWorkingDirectories(
  output: string,
): ReadonlyMap<number, string> {
  const directories = new Map<number, string>();
  let processId: number | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) processId = Number(line.slice(1));
    else if (line.startsWith("n/") && processId) {
      directories.set(processId, line.slice(1));
    }
  }
  return directories;
}

function parseProcessGroups(output: string): ReadonlyMap<number, number> {
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

/**
 * Every harness that leaves a trace on this machine, not just the one Silvic
 * started with. A plot worked on in Claude Code or T3 Code used to look
 * untouched, so the grove folded it away while it was the most recent thing
 * the person did.
 */
async function readAgentSessions(
  runner: CommandRunner,
  sources: LocalContextSources,
): Promise<readonly AgentSession[]> {
  const [codex, t3] = await Promise.all([
    readCodexSessions(runner),
    readT3Sessions(runner, sources.t3Database),
  ]);
  return [
    ...codex,
    ...t3,
    ...(sources.claudeProjects === undefined
      ? readClaudeSessions()
      : readClaudeSessions(sources.claudeProjects)),
  ];
}

async function readCodexSessions(
  runner: CommandRunner,
): Promise<readonly AgentSession[]> {
  // Codex has kept state in both of these homes over time, and a stale copy
  // of the abandoned one lingers. Preferring a fixed path once served a
  // months-old snapshot — every plot looked idle. Read the file Codex
  // actually writes: the newest.
  const database = [
    join(homedir(), ".codex", "state_5.sqlite"),
    join(homedir(), ".codex", "sqlite", "state_5.sqlite"),
  ]
    .filter(existsSync)
    .toSorted((left, right) => modifiedAt(right) - modifiedAt(left))[0];
  if (!database) return [];
  const query = `
    SELECT
      id,
      cwd,
      COALESCE(NULLIF(title, ''), 'Untitled') AS title,
      COALESCE(updated_at_ms, updated_at * 1000) AS updatedAtMs
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
    return parseCodexSessions(result.stdout);
  } catch {
    return [];
  }
}

/**
 * T3 Code keeps one projection database for every project it knows, so a
 * thread's directory is its worktree when it has one and the project root
 * otherwise. `updated_at` is ISO text, which SQLite converts for us.
 */
export async function readT3Sessions(
  runner: CommandRunner,
  database = join(homedir(), ".t3", "userdata", "state.sqlite"),
): Promise<readonly AgentSession[]> {
  if (!existsSync(database)) return [];
  const query = `
    SELECT
      thread.thread_id AS id,
      COALESCE(NULLIF(thread.worktree_path, ''), project.workspace_root) AS cwd,
      COALESCE(NULLIF(thread.title, ''), 'Untitled') AS title,
      CAST(strftime('%s', thread.updated_at) AS INTEGER) * 1000 AS updatedAtMs
    FROM projection_threads AS thread
    JOIN projection_projects AS project
      ON project.project_id = thread.project_id
    WHERE thread.deleted_at IS NULL AND thread.archived_at IS NULL
    ORDER BY updatedAtMs DESC
    LIMIT 500;
  `;
  const result = await runner.run({
    executable: "sqlite3",
    arguments: ["-json", database, query],
  });
  if (result.exitCode !== 0) return [];
  try {
    return parseSessions(result.stdout, "t3-code");
  } catch {
    return [];
  }
}

/**
 * Claude Code writes one transcript per session under a folder named after
 * the project path — lossily, because every slash becomes a dash. The
 * transcript itself records the real `cwd`, so the newest one in each folder
 * answers both "where" and "when" without guessing the path back.
 */
export function readClaudeSessions(
  root = join(homedir(), ".claude", "projects"),
  now = Date.now(),
): readonly AgentSession[] {
  let folders: readonly string[];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
  const sessions: AgentSession[] = [];
  for (const folder of folders) {
    const newest = newestTranscript(folder);
    // Old projects are the bulk of that folder and cannot change any view
    // that asks about recent work; reading their heads would be waste.
    if (!newest || newest.modifiedAt < now - claudeTranscriptWindowMs) continue;
    const head = readHead(newest.path);
    const cwd = transcriptCwd(head);
    if (!cwd) continue;
    sessions.push({
      id: basename(newest.path, ".jsonl"),
      cwd,
      title: transcriptTitle(head) ?? "Claude Code session",
      updatedAtMs: Math.round(newest.modifiedAt),
      harness: "claude",
    });
  }
  return sessions;
}

/** Two weeks: well past any window a view of recent work asks about. */
const claudeTranscriptWindowMs = 14 * 24 * 60 * 60 * 1_000;

/** Enough of a transcript to hold its header and first prompt. */
const transcriptHeadBytes = 64 * 1_024;

function newestTranscript(
  folder: string,
): { path: string; modifiedAt: number } | undefined {
  let newest: { path: string; modifiedAt: number } | undefined;
  let entries: readonly string[];
  try {
    entries = readdirSync(folder);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(folder, entry);
    const stamp = modifiedAt(path);
    if (stamp === 0) continue;
    if (!newest || stamp > newest.modifiedAt) {
      newest = { path, modifiedAt: stamp };
    }
  }
  return newest;
}

function readHead(path: string): string {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    const buffer = Buffer.alloc(transcriptHeadBytes);
    const read = readSync(handle, buffer, 0, transcriptHeadBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Nothing left to do with a handle that will not close.
      }
    }
  }
}

export function transcriptCwd(head: string): string | undefined {
  for (const line of head.split("\n")) {
    const record = parseRecord(line);
    const cwd = record?.["cwd"];
    if (typeof cwd === "string" && isAbsolute(cwd)) return cwd;
  }
  return undefined;
}

/**
 * The first thing the person actually typed, which is what T3 Code and Codex
 * both show as a thread's title. Slash commands and the harness's own
 * preamble are not that.
 */
export function transcriptTitle(head: string): string | undefined {
  for (const line of head.split("\n")) {
    const record = parseRecord(line);
    if (record?.["type"] !== "user") continue;
    const message = record["message"];
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>)["content"];
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block) =>
                typeof block === "object" &&
                block !== null &&
                (block as Record<string, unknown>)["type"] === "text"
                  ? String((block as Record<string, unknown>)["text"] ?? "")
                  : "",
              )
              .join(" ")
          : "";
    const cleaned = text.replaceAll(/\s+/g, " ").trim();
    if (!cleaned || cleaned.startsWith("<") || cleaned.startsWith("Caveat:")) {
      continue;
    }
    return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
  }
  return undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Subtree containment, exactly like listeners: a Codex session started in
 * apps/web of a monorepo plot is that plot's activity. Requiring the exact
 * worktree root left such plots looking idle, and the grove folded them away
 * while Codex was busy inside.
 *
 * Codex itself records the *container* as a session's directory
 * (`~/.codex/worktrees/65e0`, one level above the repo it made there), so a
 * cwd that holds exactly one repository counts for that repository too. The
 * one-repo requirement keeps a session run in a folder of many projects
 * from lighting all of them up.
 */
export function sessionMatches(
  targetPath: string,
  session: AgentSession,
  resolveSoleRepository: (cwd: string) => string | undefined = soleRepositoryIn,
): boolean {
  if (containsPath(targetPath, session.cwd)) return true;
  if (!containsPath(session.cwd, targetPath)) return false;
  const sole = resolveSoleRepository(session.cwd);
  return sole !== undefined && normalize(sole) === normalize(targetPath);
}

function soleRepositoryIn(cwd: string): string | undefined {
  try {
    const repositories = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cwd, entry.name))
      .filter((candidate) => existsSync(join(candidate, ".git")));
    return repositories.length === 1 ? repositories[0] : undefined;
  } catch {
    return undefined;
  }
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function parseCodexSessions(output: string): readonly AgentSession[] {
  return parseSessions(output, "codex");
}

export function parseSessions(
  output: string,
  harness: SessionHarness,
): readonly AgentSession[] {
  const value: unknown = JSON.parse(output);
  return Array.isArray(value)
    ? value
        .filter(
          (task): task is Omit<AgentSession, "harness"> =>
            typeof task === "object" &&
            task !== null &&
            "id" in task &&
            "cwd" in task &&
            "title" in task &&
            "updatedAtMs" in task &&
            typeof task.id === "string" &&
            typeof task.cwd === "string" &&
            typeof task.title === "string" &&
            typeof task.updatedAtMs === "number" &&
            Number.isFinite(task.updatedAtMs),
        )
        .map((task) => ({ ...task, harness }))
    : [];
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

export function sessionObservation(
  target: WorkspaceTarget,
  session: AgentSession,
): ConnectorObservation {
  return {
    connectorId: "local-context",
    workspaceId: target.workspaceId,
    kind: "session",
    state: "ready",
    label: session.title,
    detail: harnessDetail[session.harness],
    metadata: { taskId: session.id, updatedAtMs: session.updatedAtMs },
  };
}
