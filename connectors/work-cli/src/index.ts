import { normalize } from "node:path";

import type {
  Connector,
  ConnectorObservation,
  WorkspaceTarget,
} from "@silvic/contracts";
import {
  readWorkCliWorkspaces,
  type CommandRunner,
  type WorkCliWorkspace,
} from "@silvic/core";

export interface WorkCommandDefinition {
  id: string;
  autoStart: boolean;
  routed: boolean;
}

export interface WorkProjectSetup {
  project: string;
  commands: readonly WorkCommandDefinition[];
  setup?: string;
  portless: boolean;
}

interface RunningCommand {
  project: string;
  workspace: string;
  command: string;
  status: string;
  runner: string;
  url?: string;
}

const cacheMilliseconds = 3_000;

export function createWorkCliConnector(
  runner: CommandRunner,
  stateRoot?: string,
): Connector {
  let workspaceCache:
    | { at: number; entries: Promise<ReadonlyMap<string, WorkCliWorkspace>> }
    | undefined;
  let runningCache:
    | { at: number; commands: Promise<readonly RunningCommand[]> }
    | undefined;
  const setupByProject = new Map<string, Promise<WorkProjectSetup | undefined>>();

  const workspaces = (now: number) => {
    if (!workspaceCache || now - workspaceCache.at >= cacheMilliseconds) {
      workspaceCache = { at: now, entries: readWorkCliWorkspaces(stateRoot) };
    }
    return workspaceCache.entries;
  };

  const running = (now: number, signal?: AbortSignal) => {
    if (!runningCache || now - runningCache.at >= cacheMilliseconds) {
      runningCache = {
        at: now,
        commands: runner
          .run({
            executable: "work",
            arguments: ["status", "-a"],
            ...(signal ? { signal } : {}),
          })
          .then((result) =>
            result.exitCode === 0 ? parseStatus(result.stdout) : [],
          )
          .catch(() => []),
      };
    }
    return runningCache.commands;
  };

  // `work doctor` reports the project slug and which commands are routed
  // without executing the repository's own config, which stays untrusted.
  const setupFor = (projectId: string, cwd: string, signal?: AbortSignal) => {
    const cached = setupByProject.get(projectId);
    if (cached) return cached;
    const pending = runner
      .run({
        executable: "work",
        arguments: ["doctor"],
        cwd,
        ...(signal ? { signal } : {}),
      })
      .then((result) =>
        result.exitCode === 0 ? parseDoctor(result.stdout) : undefined,
      )
      .catch(() => undefined);
    setupByProject.set(projectId, pending);
    return pending;
  };

  return {
    manifest: {
      id: "work-cli",
      name: "work-cli",
      kind: "service",
      capabilities: ["observe"],
    },
    observe: async (target, context) => {
      const now = Date.now();
      const entry = (await workspaces(now)).get(normalize(target.path));
      if (!entry) return [];
      const setup = await setupFor(
        target.projectId,
        target.path,
        context?.signal,
      );
      if (!setup) return [];
      const active = (await running(now, context?.signal)).filter(
        (command) =>
          command.project === entry.project &&
          command.workspace === entry.workspace,
      );
      return observations(target, entry, setup, active);
    },
  };
}

function observations(
  target: WorkspaceTarget,
  entry: WorkCliWorkspace,
  setup: WorkProjectSetup,
  active: readonly RunningCommand[],
): ConnectorObservation[] {
  const byCommand = new Map(active.map((command) => [command.command, command]));
  return setup.commands
    .filter((command) => command.routed || byCommand.has(command.id))
    .map((command) => {
      const live = byCommand.get(command.id);
      const url = command.routed
        ? routeUrl(command.id, entry.workspace, setup.project)
        : undefined;
      return {
        connectorId: "work-cli",
        workspaceId: target.workspaceId,
        kind: "runtime" as const,
        state: live ? runningState(live.status) : ("quiet" as const),
        label: command.id,
        detail: live
          ? `${live.status} via ${live.runner}`
          : command.autoStart
            ? "Not started · work up"
            : "Not started",
        ...(live?.url ?? url ? { url: live?.url ?? url } : {}),
      } satisfies ConnectorObservation;
    });
}

/**
 * portless publishes a stable route per command, so the address a plot will
 * answer on is known before anything is started.
 */
export function routeUrl(
  command: string,
  workspace: string,
  project: string,
): string {
  return `https://${command}-${workspace}-${project}.localhost`;
}

export function parseDoctor(output: string): WorkProjectSetup | undefined {
  let project: string | undefined;
  let setup: string | undefined;
  let portless = false;
  const commands: WorkCommandDefinition[] = [];

  for (const line of output.split(/\r?\n/)) {
    const columns = line.split("\t");
    const [key] = columns;
    if (key === "config" && columns[1] === "ok" && columns[2]) {
      project = columns[2].trim();
    } else if (key === "setup" && columns[1]) {
      setup = columns[1].trim();
    } else if (key === "portless") {
      portless = columns[1]?.trim() === "ok";
    } else if (key === "command" && columns[1]) {
      commands.push({
        id: columns[1].trim(),
        autoStart: columns[2]?.trim() === "auto",
        routed: columns[3]?.trim() === "routed",
      });
    }
  }
  if (!project) return undefined;
  return { project, commands, ...(setup ? { setup } : {}), portless };
}

function runningState(status: string): ConnectorObservation["state"] {
  const live = new Set(["active", "healthy", "listening", "running", "up"]);
  return live.has(status.toLowerCase()) ? "active" : "attention";
}

export function parseStatus(output: string): RunningCommand[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && !line.toLowerCase().startsWith("status "),
    )
    .flatMap((line) => {
      const columns = line.split(/\s+/);
      const scope = columns[1]?.split("/", 2);
      if (columns.length < 5 || scope?.length !== 2) return [];
      const [project, workspace] = scope;
      const [status, , command, commandRunner, , url] = columns;
      if (!project || !workspace || !status || !command || !commandRunner) {
        return [];
      }
      return [
        {
          project,
          workspace,
          command,
          status,
          runner: commandRunner,
          ...(url ? { url } : {}),
        },
      ];
    });
}
