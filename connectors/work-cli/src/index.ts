import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

import type {
  Connector,
  ConnectorObservation,
  WorkspaceTarget,
} from "@silvic/contracts";
import type { CommandRunner } from "@silvic/core";

interface WorkCommand {
  status: string;
  project: string;
  workspace: string;
  command: string;
  runner: string;
  handle: string;
  url?: string;
}

export function createWorkCliConnector(
  runner: CommandRunner,
  stateRoot = process.env.WORK_STATE_ROOT ?? join(homedir(), ".work-cli"),
): Connector {
  let statusCache:
    | {
        createdAt: number;
        commands: Promise<
          readonly { command: WorkCommand; root: string | undefined }[]
        >;
      }
    | undefined;

  const readCommands = (
    signal?: AbortSignal,
  ): Promise<readonly { command: WorkCommand; root: string | undefined }[]> => {
    const now = Date.now();
    if (statusCache && now - statusCache.createdAt < 3_000) {
      return statusCache.commands;
    }
    const commands = runner
      .run({
        executable: "work",
        arguments: ["status", "-a"],
        ...(signal ? { signal } : {}),
      })
      .then((result) => {
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || "work-cli is unavailable");
        }
        return Promise.all(
          parseStatus(result.stdout).map(async (command) => ({
            command,
            root: await workspaceRoot(command, stateRoot),
          })),
        );
      });
    statusCache = { createdAt: now, commands };
    return commands;
  };

  return {
    manifest: {
      id: "work-cli",
      name: "work-cli",
      kind: "service",
      capabilities: ["observe"],
    },
    observe: async (target, context) => {
      const commands = await readCommands(context?.signal);
      const matches = commands.filter(
        ({ root }) => root && normalize(root) === normalize(target.path),
      );
      return matches.map(({ command }) => observation(target, command));
    },
  };
}

function parseStatus(output: string): WorkCommand[] {
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
      const [status, , command, commandRunner, handle, url] = columns;
      if (
        !project ||
        !workspace ||
        !status ||
        !command ||
        !commandRunner ||
        !handle
      )
        return [];
      return [
        {
          status,
          project,
          workspace,
          command,
          runner: commandRunner,
          handle,
          ...(url ? { url } : {}),
        },
      ];
    });
}

async function workspaceRoot(
  command: WorkCommand,
  stateRoot: string,
): Promise<string | undefined> {
  if (!safeName(command.project) || !safeName(command.workspace))
    return undefined;
  try {
    const contents = await readFile(
      join(
        stateRoot,
        "projects",
        command.project,
        "workspaces",
        command.workspace,
        "state.json",
      ),
      "utf8",
    );
    const value: unknown = JSON.parse(contents);
    return typeof value === "object" &&
      value !== null &&
      "root" in value &&
      typeof value.root === "string"
      ? value.root
      : undefined;
  } catch {
    return undefined;
  }
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function observation(
  target: WorkspaceTarget,
  command: WorkCommand,
): ConnectorObservation {
  const active = new Set([
    "active",
    "healthy",
    "listening",
    "running",
    "up",
  ]).has(command.status.toLowerCase());
  return {
    connectorId: "work-cli",
    workspaceId: target.workspaceId,
    kind: "runtime",
    state: active ? "active" : "quiet",
    label: command.command,
    detail: `${command.status} via ${command.runner}`,
    ...(command.url ? { url: command.url } : {}),
    metadata: {
      handle: command.handle,
    },
  };
}
