import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
let installedLauncher: string;
let installedRoot: string;
let packagedRuntimeExecutable: string;

beforeAll(async () => {
  execFileSync("pnpm", ["--filter", "@silvic/cli", "build"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  installedRoot = await mkdtemp(join(tmpdir(), "silvic-cli-install-"));
  packagedRuntimeExecutable = join(installedRoot, "SilvicRuntime");
  await symlink(process.execPath, packagedRuntimeExecutable);
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

it("forwards the selected production runtime through CLI start and wait", async () => {
  const requests: AutomationRequest[] = [];
  const directory = await serve(async (request) => {
    requests.push(request);
    return request.method === "start"
      ? { results: [], partialFailure: false }
      : { ready: true, url: "https://preview.localhost" };
  });
  const result = await executeFile(
    executable,
    ["preview", "--plot", "plot_123", "--runtime", "preview", "--json"],
    {
      env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
    },
  );
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "start", params: { plot: "plot_123", runtime: "preview" } },
    { method: "wait", params: { plot: "plot_123", runtime: "preview" } },
  ]);
  expect(JSON.parse(result.stdout).result.preview.url).toBe(
    "https://preview.localhost",
  );
});

it("lets provision request policy evaluation without inventing a confirmation", async () => {
  const requests: AutomationRequest[] = [];
  const directory = await serve(async (request) => {
    requests.push(request);
    return {
      provision: [],
      runtime: { status: "not-required", durationMs: 0 },
      readiness: { status: "not-required", durationMs: 0 },
      failed: false,
      partialFailure: false,
    };
  });
  await executeFile(executable, ["provision", "--plot", "plot_123", "--json"], {
    env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
  });
  expect(requests[0]?.params).toEqual({ plot: "plot_123" });
});

it("uses the current Git checkout for preview and forwards an explicit refresh", async () => {
  const requests: AutomationRequest[] = [];
  const directory = await serve(async (request) => {
    requests.push(request);
    if (request.method === "start")
      return { results: [], partialFailure: false };
    if (request.method === "wait")
      return { ready: true, url: "https://preview.localhost" };
    return {
      provision: [],
      runtime: { status: "not-required" },
      readiness: { status: "not-required" },
    };
  });
  const options = {
    cwd: resolve(repositoryRoot, "apps/cli/src"),
    env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
  };
  await executeFile(
    executable,
    ["preview", "--runtime", "web", "--json"],
    options,
  );
  await executeFile(
    executable,
    ["provision", "--refresh", "--confirm", "plot_123", "--json"],
    options,
  );
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
    { method: "start", params: { plot: repositoryRoot, runtime: "web" } },
    { method: "wait", params: { plot: repositoryRoot, runtime: "web" } },
    {
      method: "provision",
      params: {
        plot: repositoryRoot,
        refresh: true,
        confirmPlotId: "plot_123",
      },
    },
  ]);
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

it("starts the installed CLI and plugin with a packaged runtime and no Node on PATH", async () => {
  const environment = {
    HOME: tmpdir(),
    PATH: "/usr/bin:/bin",
    SILVIC_APP_EXECUTABLE: packagedRuntimeExecutable,
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

it("prints resource kind in human-readable Plot status", async () => {
  const directory = await serve(async () => ({
    id: "plot_123",
    projectId: "project_123",
    name: "Runtime isolation",
    path: "/projects/Silvic.plots/runtime-isolation",
    branch: "fix/runtime-isolation",
    isPrimary: false,
    state: "stopped",
    runtimes: [],
    resources: [
      {
        id: "agent",
        provider: "livekit",
        kind: "agent",
        isolation: "shared",
        runtimeIdentity: "namespaced",
      },
    ],
    diagnostics: [],
  }));

  const result = await executeFile(
    executable,
    ["status", "--plot", "plot_123"],
    {
      env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
    },
  );

  expect(result.stdout).toContain(
    "resource\tagent\tlivekit\tagent\tshared\tnamespaced",
  );
});

it("prints a selected Plot path without opening the interactive picker", async () => {
  const directory = await serve(async () => ({
    id: "plot_123",
    projectId: "project_123",
    name: "Runtime isolation",
    path: "/projects/Silvic.plots/runtime-isolation",
    branch: "fix/runtime-isolation",
    isPrimary: false,
    state: "ready",
    runtimes: [],
    resources: [],
    diagnostics: [],
  }));

  const result = await executeFile(executable, ["cd", "--plot", "plot_123"], {
    env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
  });

  expect(result.stdout).toBe("/projects/Silvic.plots/runtime-isolation\n");
  expect(result.stderr).toBe("");
});

it("changes the calling shell directory through shell-init", async () => {
  const plotDirectory = await mkdtemp(join(tmpdir(), "silvic-selected-plot-"));
  directories.push(plotDirectory);
  const directory = await serve(async () => ({
    id: "plot_123",
    projectId: "project_123",
    name: "Selected Plot",
    path: plotDirectory,
    branch: "fix/selected-plot",
    isPrimary: false,
    state: "ready",
    runtimes: [],
    resources: [],
    diagnostics: [],
  }));
  const binDirectory = await mkdtemp(join(tmpdir(), "silvic-shell-bin-"));
  directories.push(binDirectory);
  await symlink(executable, join(binDirectory, "silvic"));

  const result = await executeFile(
    "bash",
    ["-c", 'eval "$(silvic shell-init)"; silvic cd --plot plot_123; pwd'],
    {
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        SILVIC_AUTOMATION_DIR: directory,
      },
    },
  );

  expect(result.stdout).toBe(`${plotDirectory}\n`);
  expect(result.stderr).toBe("");
});

it("requires a terminal when cd has no explicit Plot", async () => {
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

  const failure = await executeFailure(["cd"], directory);

  expect(failure.code).toBe(2);
  expect(failure.stderr).toContain("needs an interactive terminal");
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

it("prints automatic adoption eligibility and blocking reasons", async () => {
  const directory = await serve(async () => ({
    projectId: "project_123",
    selectedPlotId: "plot_123",
    scope: "single",
    members: [],
    steps: [{ label: "Deploy shared state", providerChanging: true }],
    automaticAdoption: {
      policy: "isolated-disposable",
      eligible: false,
      reasons: [
        "Deploy shared state: shell steps must declare providerChanges false.",
      ],
    },
    requiresProviderConfirmation: true,
  }));

  const result = await executeFile(
    executable,
    ["adoption-plan", "--plot", "plot_123"],
    { env: { ...process.env, SILVIC_AUTOMATION_DIR: directory } },
  );

  expect(result.stdout).toContain("policy\tisolated-disposable\tblocked\n");
  expect(result.stdout).toContain(
    "policy-reason\tDeploy shared state: shell steps must declare providerChanges false.\n",
  );
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

it.each(["convex-adopt", "convex-recreate"] as const)(
  "forwards the offered %s remedy by its closed identifier",
  async (remedy) => {
    const requests: AutomationRequest[] = [];
    const directory = await serve(async (request) => {
      requests.push(request);
      return {
        provision: [],
        runtime: { status: "not-required" },
        readiness: { status: "not-required" },
        failed: false,
        partialFailure: false,
      };
    });

    await executeFile(
      executable,
      [
        "provision",
        "--plot",
        "plot_123",
        "--confirm",
        "plot_123",
        "--remedy",
        remedy,
        "--json",
      ],
      { env: { ...process.env, SILVIC_AUTOMATION_DIR: directory } },
    );

    expect(requests).toMatchObject([
      {
        method: "provision",
        params: {
          plot: "plot_123",
          confirmPlotId: "plot_123",
          remedy,
        },
      },
    ]);
  },
);

it("inspects state before passing the exact plan confirmation to pruning", async () => {
  const requests: AutomationRequest[] = [];
  const statePlan = {
    planId: "state_exact123",
    retentionDays: 30,
    totalRecords: 153,
    activeRecords: 44,
    staleRecords: [
      {
        workspaceId: "stale_1",
        path: "/missing/stale",
        missingSince: "2026-06-01T00:00:00.000Z",
        ageDays: 88,
        action: "prune-metadata",
        reasons: [],
      },
    ],
    prunableRecordIds: ["stale_1"],
    storage: [
      {
        path: "/Users/me/.codex/worktrees",
        bytes: 63_000_000_000,
        ownership: "codex",
        note: "Observed Codex worktrees; Silvic never removes them",
      },
    ],
    boundaries: ["Apply removes only the listed Silvic workspace records."],
  };
  const directory = await serve(async (request) => {
    requests.push(request);
    return request.method === "workspaceStatePlan"
      ? statePlan
      : { plan: statePlan, removedRecordIds: ["stale_1"] };
  });

  const inspected = await executeFile(executable, ["state-plan", "--json"], {
    env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
  });
  const applied = await executeFile(
    executable,
    ["state-prune", "--confirm", "state_exact123", "--json"],
    { env: { ...process.env, SILVIC_AUTOMATION_DIR: directory } },
  );

  expect(JSON.parse(inspected.stdout)).toMatchObject({
    ok: true,
    result: { planId: "state_exact123", prunableRecordIds: ["stale_1"] },
  });
  expect(JSON.parse(applied.stdout)).toMatchObject({
    ok: true,
    result: { removedRecordIds: ["stale_1"] },
  });
  expect(requests).toMatchObject([
    { method: "workspaceStatePlan", params: {} },
    {
      method: "pruneWorkspaceState",
      params: { confirmPlanId: "state_exact123" },
    },
  ]);
});

it("maps a changed state plan to fail-closed exit 5", async () => {
  const directory = await serve(async () => {
    throw new AutomationError(
      "STATE_PLAN_CONFIRMATION_REQUIRED",
      "Workspace state changed; inspect a fresh plan before applying.",
      { planId: "state_new" },
    );
  });
  const failure = await executeFailure(
    ["state-prune", "--confirm", "state_old", "--json"],
    directory,
  );

  expect(failure.code).toBe(5);
  expect(JSON.parse(failure.stdout)).toMatchObject({
    ok: false,
    error: {
      code: "STATE_PLAN_CONFIRMATION_REQUIRED",
      details: { planId: "state_new" },
    },
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
        plot: {
          id: "plot_123",
          runtimes: [
            { id: "preview", servesPreview: true, status: "running" },
            { id: "web", servesPreview: true, status: "starting" },
          ],
        },
        partialFailure: false,
      };
    }
    expect(request.params.runtime).toBe("web");
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

it.each(["invalid", "0", "600001"])(
  "rejects invalid preview timeout %s before starting anything",
  async (timeout) => {
    const methods: string[] = [];
    const directory = await serve(async (request) => {
      methods.push(request.method);
      return { results: [], partialFailure: false };
    });
    const failure = await executeFailure(
      ["preview", "--plot", "plot_123", "--timeout", timeout, "--json"],
      directory,
    );
    expect(failure.code).toBe(2);
    expect(methods).toEqual([]);
  },
);

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
