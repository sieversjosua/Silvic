import { execFile, execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  AutomationError,
  startAutomationServer,
  type AutomationRequest,
  type AutomationServer,
} from "@silvic/automation";

import packageMetadata from "../package.json" with { type: "json" };

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const releaseVersion = packageMetadata.version;
const executable = resolve(repositoryRoot, "apps/cli/dist/silvic.mjs");
const directories: string[] = [];
let server: AutomationServer | undefined;
let electronExecutable: string;
let installedLauncher: string;
let installedRoot: string;

beforeAll(async () => {
  execFileSync("pnpm", ["--filter", "@silvic/cli", "build"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  electronExecutable = execFileSync(
    "pnpm",
    [
      "--filter",
      "@silvic/desktop",
      "exec",
      "node",
      "-p",
      "require('electron')",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  installedRoot = await mkdtemp(join(tmpdir(), "silvic-cli-install-"));
  await mkdir(join(installedRoot, "bin"), { recursive: true });
  await mkdir(join(installedRoot, "lib"), { recursive: true });
  await cp(
    resolve(repositoryRoot, "apps/cli/bin/silvic"),
    join(installedRoot, "bin/silvic"),
  );
  await cp(executable, join(installedRoot, "lib/silvic.mjs"));
  installedLauncher = join(installedRoot, "bin/silvic");
});

afterAll(async () => {
  await rm(installedRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("writes one versioned JSON document and keeps stderr clean", async () => {
  const directory = await serve(async () => ({
    roots: ["/projects"],
    projects: [
      {
        id: "project_123",
        name: "Silvic",
        rootPath: "/projects/Silvic",
        plots: [],
      },
    ],
    refreshedAt: "2026-08-25T12:00:00.000Z",
  }));

  const result = await executeFile(executable, ["projects", "--json"], {
    env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
  });

  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    ok: true,
    result: {
      roots: ["/projects"],
      projects: [
        {
          id: "project_123",
          name: "Silvic",
          rootPath: "/projects/Silvic",
          plotCount: 0,
        },
      ],
    },
  });
});

it("starts the installed CLI and plugin without Node on PATH", async () => {
  const environment = {
    HOME: tmpdir(),
    PATH: "/usr/bin:/bin",
    SILVIC_APP_EXECUTABLE: electronExecutable,
  };
  const installed = await executeFile(installedLauncher, ["--version"], {
    env: environment,
  });
  const plugin = await executeFile(
    resolve(repositoryRoot, "plugins/silvic/bin/silvic"),
    ["--version"],
    { env: environment },
  );

  expect(installed.stdout.trim()).toBe(releaseVersion);
  expect(plugin.stdout).toBe(installed.stdout);
  expect(installed.stderr).toBe("");
  expect(plugin.stderr).toBe("");
});

it("negotiates MCP and exposes the complete release tool catalog", async () => {
  const replies = await mcpExchange([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "silvic-smoke", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]);
  const initialized = replies.find((reply) => reply.id === 1);
  const catalog = replies.find((reply) => reply.id === 2);

  expect(initialized?.result).toMatchObject({
    serverInfo: { name: "silvic", version: releaseVersion },
  });
  expect(
    (catalog?.result as { tools: readonly { name: string }[] }).tools.map(
      (tool) => tool.name,
    ),
  ).toEqual([
    "list_projects",
    "list_plots",
    "plot_status",
    "plan_plot_adoption",
    "adopt_plot",
    "provision_plot",
    "start_runtimes",
    "stop_runtimes",
    "wait_for_preview",
    "runtime_logs",
  ]);
});

it("maps not-found failures to exit 4 with structured stdout", async () => {
  const directory = await serve(async () => {
    throw new AutomationError(
      "PLOT_NOT_FOUND",
      "No watched Plot matches missing.",
    );
  });

  const failure = await executeFailure(
    ["status", "--plot", "missing", "--json"],
    directory,
  );

  expect(failure.code).toBe(4);
  expect(failure.stderr).toBe("");
  expect(JSON.parse(failure.stdout)).toEqual({
    schemaVersion: 1,
    ok: false,
    error: {
      code: "PLOT_NOT_FOUND",
      message: "No watched Plot matches missing.",
    },
  });
});

it("maps Plot lifecycle preconditions to exit 5", async () => {
  const directory = await serve(async () => {
    throw new AutomationError(
      "ADOPTION_REQUIRED",
      "Adopt this Plot in Silvic before starting runtimes.",
    );
  });

  const failure = await executeFailure(
    ["start", "--plot", "plot_123", "--json"],
    directory,
  );

  expect(failure.code).toBe(5);
  expect(JSON.parse(failure.stdout)).toMatchObject({
    schemaVersion: 1,
    ok: false,
    error: { code: "ADOPTION_REQUIRED" },
  });
});

it("plans adoption before provider changes run", async () => {
  const requests: AutomationRequest[] = [];
  const directory = await serve(async (request) => {
    requests.push(request);
    return {
      projectId: "project_123",
      selectedPlotId: "plot_123",
      scope: "family",
      members: [
        {
          workspaceId: "plot_123",
          name: "Issue 13",
          path: "/projects/Silvic/.worktrees/issue-13",
          status: "not-adopted",
          url: "https://issue-13-silvic.localhost",
        },
      ],
      steps: [{ label: "Convex deployment", providerChanging: true }],
      requiresProviderConfirmation: true,
    };
  });

  const result = await executeFile(
    executable,
    [
      "adoption-plan",
      "--plot",
      "/projects/Silvic/.worktrees/issue-13",
      "--scope",
      "family",
      "--json",
    ],
    { env: { ...process.env, SILVIC_AUTOMATION_DIR: directory } },
  );

  expect(requests).toMatchObject([
    {
      method: "adoptionPlan",
      params: {
        plot: "/projects/Silvic/.worktrees/issue-13",
        scope: "family",
      },
    },
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    ok: true,
    result: { members: [{ workspaceId: "plot_123" }] },
  });
});

it("passes the literal stable Plot confirmation to adoption", async () => {
  const requests: AutomationRequest[] = [];
  const directory = await serve(async (request) => {
    requests.push(request);
    return {
      members: [
        { workspaceId: "plot_123", name: "Issue 13", status: "adopted" },
      ],
      failed: false,
      partialFailure: false,
    };
  });

  await executeFile(
    executable,
    ["adopt", "--plot", "plot_123", "--confirm", "plot_123", "--json"],
    { env: { ...process.env, SILVIC_AUTOMATION_DIR: directory } },
  );

  expect(requests).toMatchObject([
    {
      method: "adopt",
      params: { plot: "plot_123", confirmPlotId: "plot_123" },
    },
  ]);
});

it("returns exit 5 when a provisioning retry fails completely", async () => {
  const directory = await serve(async () => ({
    provision: [
      {
        label: "Convex deployment",
        exitCode: 1,
        advice: "Connect and retry.",
      },
    ],
    runtime: { status: "not-required" },
    readiness: { status: "not-required" },
    failed: true,
    partialFailure: false,
  }));

  const failure = await executeFailure(
    ["provision", "--plot", "plot_123", "--confirm", "plot_123", "--json"],
    directory,
  );

  expect(failure.code).toBe(5);
  expect(JSON.parse(failure.stdout)).toMatchObject({
    ok: true,
    result: { failed: true, partialFailure: false },
  });
});

it("uses exit 6 for a parseable partial runtime result", async () => {
  const directory = await serve(async () => ({
    results: [
      { runtimeId: "web", action: "started" },
      { runtimeId: "worker", action: "failed", message: "Exited with code 1" },
    ],
    plot: { id: "plot_123" },
    partialFailure: true,
  }));

  const failure = await executeFailure(
    ["start", "--plot", "plot_123", "--json"],
    directory,
  );

  expect(failure.code).toBe(6);
  expect(JSON.parse(failure.stdout)).toMatchObject({
    schemaVersion: 1,
    ok: true,
    result: { partialFailure: true },
  });
});

it("starts a Plot, waits for readiness, and prints its preview URL", async () => {
  const methods: string[] = [];
  const directory = await serve(async (request) => {
    methods.push(request.method);
    if (request.method === "start") {
      return {
        results: [{ runtimeId: "web", action: "started" }],
        plot: { id: "plot_123" },
        partialFailure: false,
      };
    }
    return {
      ready: true,
      url: "http://silvic.test",
      durationMs: 12,
      plot: { id: "plot_123" },
    };
  });

  const result = await executeFile(
    executable,
    ["preview", "--plot", "/projects/Silvic/.worktrees/codex"],
    { env: { ...process.env, SILVIC_AUTOMATION_DIR: directory } },
  );

  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("http://silvic.test\n");
  expect(methods).toEqual(["start", "wait"]);
});

async function serve(
  handle: (request: AutomationRequest) => Promise<unknown>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "silvic-cli-"));
  directories.push(directory);
  server = await startAutomationServer({
    socketPath: join(directory, "automation.sock"),
    serverVersion: releaseVersion,
    handle,
  });
  return directory;
}

async function executeFailure(args: readonly string[], directory: string) {
  try {
    await executeFile(executable, [...args], {
      env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
    });
    throw new Error("Command unexpectedly succeeded");
  } catch (error) {
    return error as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
  }
}

function mcpExchange(
  requests: readonly Record<string, unknown>[],
): Promise<Array<{ id?: number; result?: unknown }>> {
  return new Promise((done, reject) => {
    const child = spawn(
      resolve(repositoryRoot, "plugins/silvic/bin/silvic"),
      ["mcp"],
      {
        env: {
          HOME: tmpdir(),
          PATH: "/usr/bin:/bin",
          SILVIC_APP_EXECUTABLE: electronExecutable,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 || stderr) {
        reject(new Error(`MCP smoke failed (${String(code)}): ${stderr}`));
        return;
      }
      done(
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    });
    child.stdin.end(
      `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    );
  });
}
