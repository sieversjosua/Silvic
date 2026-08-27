import { execFile } from "node:child_process";
import { platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  AutomationClient,
  AutomationError,
  type AutomationPlot,
  type AutomationProject,
} from "@silvic/automation";
import { z } from "zod";

import packageMetadata from "../package.json" with { type: "json" };

const version = packageMetadata.version;
const client = new AutomationClient();
const executeFile = promisify(execFile);

interface SnapshotResult {
  roots: readonly string[];
  projects: readonly AutomationProject[];
  refreshedAt: string;
}

async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    writeHelp();
    return;
  }
  if (command === "--version" || command === "-V") {
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === "mcp") {
    await runMcpServer();
    return;
  }

  const { values } = parseArgs({
    args: [...argv.slice(1)],
    strict: true,
    allowPositionals: false,
    options: {
      json: { type: "boolean", default: false },
      project: { type: "string" },
      plot: { type: "string" },
      runtime: { type: "string" },
      timeout: { type: "string" },
      limit: { type: "string" },
      open: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    writeHelp();
    return;
  }

  switch (command) {
    case "projects": {
      rejectOptions(values, ["json", "help"]);
      const snapshot = await automationCall<SnapshotResult>("snapshot");
      output(
        {
          roots: snapshot.roots,
          projects: snapshot.projects.map(projectSummary),
        },
        values.json,
        snapshot.projects.map(
          (project) => `${project.id}\t${project.name}\t${project.rootPath}`,
        ),
      );
      return;
    }
    case "plots": {
      rejectOptions(values, ["json", "help", "project"]);
      const snapshot = await automationCall<SnapshotResult>("snapshot", {
        ...(values.project ? { projectId: values.project } : {}),
      });
      const plots = snapshot.projects.flatMap((project) => project.plots);
      output(
        { plots },
        values.json,
        plots.map(
          (plot) =>
            `${plot.id}\t${plot.state}\t${plot.name}\t${plot.previewUrl ?? "-"}\t${plot.path}`,
        ),
      );
      return;
    }
    case "status": {
      rejectOptions(values, ["json", "help", "plot"]);
      const plot = await automationCall<AutomationPlot>("status", {
        plot: requireOption(values.plot, "--plot"),
      });
      output(plot, values.json, formatStatus(plot));
      return;
    }
    case "start":
    case "stop": {
      rejectOptions(values, ["json", "help", "plot", "runtime"]);
      const result = await automationCall<OperationResult>(command, {
        plot: requireOption(values.plot, "--plot"),
        ...(values.runtime ? { runtime: values.runtime } : {}),
      });
      output(
        result,
        values.json,
        result.results.map(
          (entry) =>
            `${entry.runtimeId}\t${entry.action}${entry.message ? `\t${entry.message}` : ""}`,
        ),
      );
      if (result.partialFailure) process.exitCode = 6;
      return;
    }
    case "preview": {
      rejectOptions(values, ["json", "help", "plot", "timeout", "open"]);
      const plot = requireOption(values.plot, "--plot");
      const started = await automationCall<OperationResult>("start", { plot });
      if (started.partialFailure) {
        output(
          { start: started },
          values.json,
          started.results.map(
            (entry) =>
              `${entry.runtimeId}\t${entry.action}${entry.message ? `\t${entry.message}` : ""}`,
          ),
        );
        process.exitCode = 6;
        return;
      }
      const preview = await automationCall<WaitResult>("wait", {
        plot,
        ...(values.timeout
          ? { timeoutMs: positiveInteger(values.timeout, "--timeout") }
          : {}),
      });
      if (values.open) await openPreview(preview.url);
      output({ start: started, preview }, values.json, [preview.url]);
      return;
    }
    case "wait": {
      rejectOptions(values, ["json", "help", "plot", "timeout"]);
      const result = await automationCall<WaitResult>("wait", {
        plot: requireOption(values.plot, "--plot"),
        ...(values.timeout
          ? { timeoutMs: positiveInteger(values.timeout, "--timeout") }
          : {}),
      });
      output(result, values.json, [result.url]);
      return;
    }
    case "logs": {
      rejectOptions(values, ["json", "help", "plot", "runtime", "limit"]);
      const result = await automationCall<LogsResult>("logs", {
        plot: requireOption(values.plot, "--plot"),
        ...(values.runtime ? { runtime: values.runtime } : {}),
        ...(values.limit
          ? { limit: positiveInteger(values.limit, "--limit") }
          : {}),
      });
      output(
        result,
        values.json,
        result.entries.flatMap((entry) => [
          `==> ${entry.runtimeId} <==`,
          entry.output,
        ]),
      );
      return;
    }
    default:
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}

interface OperationResult {
  results: readonly {
    runtimeId: string;
    action: string;
    message?: string;
  }[];
  plot: AutomationPlot;
  partialFailure: boolean;
}

interface WaitResult {
  ready: true;
  url: string;
  durationMs: number;
  plot: AutomationPlot;
}

interface LogsResult {
  plotId: string;
  entries: readonly { runtimeId: string; output: string }[];
  diagnostics: readonly string[];
}

function projectSummary(project: AutomationProject) {
  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    plotCount: project.plots.length,
  };
}

function output(
  value: unknown,
  json: boolean | undefined,
  lines: readonly string[],
): void {
  process.stdout.write(
    json
      ? `${JSON.stringify({ schemaVersion: 1, ok: true, result: value })}\n`
      : `${lines.join("\n")}\n`,
  );
}

function formatStatus(plot: AutomationPlot): string[] {
  return [
    `${plot.id}\t${plot.state}\t${plot.previewUrl ?? "-"}\t${plot.path}`,
    ...plot.runtimes.map(
      (runtime) =>
        `${runtime.id}\t${runtime.status}\t${runtime.ownership}\t${runtime.url ?? "-"}`,
    ),
    ...plot.diagnostics.map((diagnostic) => `diagnostic\t${diagnostic}`),
  ];
}

function rejectOptions(
  values: Record<string, string | boolean | undefined>,
  allowed: readonly string[],
): void {
  const found = Object.entries(values).find(
    ([key, value]) =>
      value !== undefined && value !== false && !allowed.includes(key),
  );
  if (found) throw new CliUsageError(`Option --${found[0]} is not valid here.`);
}

function requireOption(value: string | undefined, name: string): string {
  if (!value) throw new CliUsageError(`${name} is required.`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function writeHelp(): void {
  process.stdout.write(
    `Silvic ${version}\n\nUsage:\n  silvic projects [--json]\n  silvic plots [--project ID] [--json]\n  silvic status --plot ID [--json]\n  silvic start --plot ID [--runtime ID] [--json]\n  silvic preview --plot ID [--timeout MS] [--open] [--json]\n  silvic stop --plot ID [--runtime ID] [--json]\n  silvic wait --plot ID [--timeout MS] [--json]\n  silvic logs --plot ID [--runtime ID] [--limit BYTES] [--json]\n\nPlot selectors accept a stable Plot id or an absolute Plot path. Start and stop\nwithout --runtime apply to every declared runtime and are idempotent. Preview\nstarts all runtimes, waits for readiness, and returns the canonical URL.\n`,
  );
}

class CliUsageError extends Error {}

async function runMcpServer(): Promise<void> {
  serveStdio(buildMcpServer, {
    onerror: (error) => process.stderr.write(`silvic mcp: ${error.message}\n`),
  });
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "silvic", version });
  const outputSchema = z.object({ result: z.unknown() });
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  const startMutation = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  const stopMutation = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  server.registerTool(
    "list_projects",
    {
      description: "List projects watched by Silvic with stable ids and paths.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: readOnly,
    },
    async (_input, context) =>
      mcpCall(
        "snapshot",
        {},
        (snapshot: SnapshotResult) => ({
          roots: snapshot.roots,
          projects: snapshot.projects.map(projectSummary),
        }),
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "list_plots",
    {
      description:
        "List Silvic Plots, their lifecycle state, runtimes, and canonical preview URL.",
      inputSchema: z.object({ projectId: z.string().optional() }),
      outputSchema,
      annotations: readOnly,
    },
    async ({ projectId }, context) =>
      mcpCall(
        "snapshot",
        projectId ? { projectId } : {},
        (snapshot: SnapshotResult) => ({
          plots: snapshot.projects.flatMap((project) => project.plots),
        }),
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "plot_status",
    {
      description:
        "Read runtime, route, ownership, readiness, and diagnostics for one Plot.",
      inputSchema: z.object({ plot: z.string().min(1) }),
      outputSchema,
      annotations: readOnly,
    },
    async ({ plot }, context) =>
      mcpCall("status", { plot }, undefined, context.mcpReq.signal),
  );
  server.registerTool(
    "start_runtimes",
    {
      description:
        "Idempotently start every declared runtime or one named runtime in a Plot.",
      inputSchema: z.object({
        plot: z.string().min(1),
        runtime: z.string().min(1).optional(),
      }),
      outputSchema,
      annotations: startMutation,
    },
    async ({ plot, runtime }, context) =>
      mcpCall(
        "start",
        { plot, ...(runtime ? { runtime } : {}) },
        undefined,
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "stop_runtimes",
    {
      description:
        "Idempotently stop Silvic-owned runtimes; external runtimes are detached, never terminated.",
      inputSchema: z.object({
        plot: z.string().min(1),
        runtime: z.string().min(1).optional(),
      }),
      outputSchema,
      annotations: stopMutation,
    },
    async ({ plot, runtime }, context) =>
      mcpCall(
        "stop",
        { plot, ...(runtime ? { runtime } : {}) },
        undefined,
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "wait_for_preview",
    {
      description:
        "Wait until a Plot preview responds and return its canonical URL.",
      inputSchema: z.object({
        plot: z.string().min(1),
        timeoutMs: z.number().int().min(1).max(600_000).optional(),
      }),
      outputSchema,
      annotations: readOnly,
    },
    async ({ plot, timeoutMs }, context) =>
      mcpCall(
        "wait",
        { plot, ...(timeoutMs ? { timeoutMs } : {}) },
        undefined,
        context.mcpReq.signal,
      ),
  );
  server.registerTool(
    "runtime_logs",
    {
      description:
        "Read recent runtime logs and actionable diagnostics for a Plot.",
      inputSchema: z.object({
        plot: z.string().min(1),
        runtime: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200_000).optional(),
      }),
      outputSchema,
      annotations: readOnly,
    },
    async ({ plot, runtime, limit }, context) =>
      mcpCall(
        "logs",
        {
          plot,
          ...(runtime ? { runtime } : {}),
          ...(limit ? { limit } : {}),
        },
        undefined,
        context.mcpReq.signal,
      ),
  );

  return server;
}

async function mcpCall<T>(
  method: "snapshot" | "status" | "start" | "stop" | "wait" | "logs",
  params: Record<string, unknown>,
  transform: (value: T) => unknown = (value) => value,
  signal?: AbortSignal,
) {
  try {
    const result = transform(
      await automationCall<T>(method, params, signal ? { signal } : {}),
    );
    return {
      structuredContent: { result },
      content: [
        { type: "text" as const, text: JSON.stringify(result, undefined, 2) },
      ],
    };
  } catch (error) {
    const body =
      error instanceof AutomationError
        ? {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          }
        : {
            code: "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : String(error),
          };
    return {
      isError: true,
      structuredContent: { result: body },
      content: [
        { type: "text" as const, text: JSON.stringify(body, undefined, 2) },
      ],
    };
  }
}

async function automationCall<T>(
  method: "snapshot" | "status" | "start" | "stop" | "wait" | "logs",
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  try {
    return await client.call<T>(method, params, options);
  } catch (error) {
    if (
      !(error instanceof AutomationError) ||
      error.code !== "SILVIC_UNAVAILABLE" ||
      platform() !== "darwin" ||
      process.env["SILVIC_AUTOMATION_DIR"]
    ) {
      throw error;
    }
  }

  try {
    await executeFile("open", ["-gj", "-b", "dev.silvic.app"]);
  } catch {
    throw new AutomationError(
      "SILVIC_UNAVAILABLE",
      "Silvic is not running and could not be launched. Install or open Silvic and try again.",
    );
  }
  const deadline = Date.now() + 15_000;
  while (true) {
    if (options.signal?.aborted) {
      throw new AutomationError("CANCELLED", "Operation was cancelled.");
    }
    try {
      return await client.call<T>(method, params, options);
    } catch (error) {
      if (
        !(error instanceof AutomationError) ||
        error.code !== "SILVIC_UNAVAILABLE" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      try {
        await delay(250, undefined, { signal: options.signal });
      } catch {
        if (options.signal?.aborted) {
          throw new AutomationError("CANCELLED", "Operation was cancelled.");
        }
        throw new AutomationError(
          "SILVIC_UNAVAILABLE",
          "Silvic did not become available after launch.",
        );
      }
    }
  }
}

async function openPreview(url: string): Promise<void> {
  if (platform() !== "darwin") {
    throw new CliUsageError("--open is currently supported on macOS only.");
  }
  await executeFile("open", [url]);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  const usage = error instanceof CliUsageError;
  const automation = error instanceof AutomationError;
  const payload = automation
    ? {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    : {
        code: usage ? "USAGE" : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, ok: false, error: payload })}\n`,
    );
  } else {
    process.stderr.write(`silvic: ${payload.message}\n`);
  }
  process.exitCode = usage
    ? 2
    : automation &&
        (error.code === "SILVIC_UNAVAILABLE" ||
          error.code === "UNSUPPORTED_PROTOCOL" ||
          error.code === "INVALID_REPLY")
      ? 3
      : automation &&
          (error.code === "PLOT_NOT_FOUND" ||
            error.code === "RUNTIME_NOT_FOUND")
        ? 4
        : automation && error.code === "READINESS_TIMEOUT"
          ? 7
          : automation && error.code === "CANCELLED"
            ? 130
            : automation &&
                (error.code === "RUNTIME_FAILED" ||
                  error.code === "NO_PREVIEW" ||
                  error.code === "ADOPTION_REQUIRED" ||
                  error.code === "PROVISIONING_REQUIRED")
              ? 5
              : 1;
});
