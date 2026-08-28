import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, expect, it } from "vitest";

import type {
  PlotAdoptionPlan,
  PlotCommand,
  PlotProvisioning,
  PlotProvisionRunResult,
  ProvisionStep,
  SilvicSnapshot,
} from "@silvic/contracts";
import {
  CommandSupervisor,
  ConnectorRegistry,
  GateRoutePublisher,
  LocalCommandRunner,
  ProjectService,
  Provisioner,
  WorkspaceRegistry,
  applyWorkspaceStatePlan,
  buildAdoptionPlan,
  executePlannedAdoption,
  planWorkspaceState,
  runtimeStartResult,
  waitForReadiness,
  type GateRouteLink,
  type SupervisedCommand,
  type WorkspaceRecord,
} from "@silvic/core";

import { AutomationClient } from "./client";
import { AutomationController } from "./controller";
import { startAutomationServer, type AutomationServer } from "./server";

const temporaryDirectories: string[] = [];
const cleanupProcesses: ChildProcess[] = [];
const cleanupSupervisors: CommandSupervisor[] = [];
let automationServer: AutomationServer | undefined;

afterEach(async () => {
  await automationServer?.close();
  automationServer = undefined;
  for (const supervisor of cleanupSupervisors.splice(0)) supervisor.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const child of cleanupProcesses.splice(0)) stopChild(child);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("integrates automation recovery with production adoption, provisioning, supervisor, and routing services", async () => {
  const fixture = await gitWorktreeFixture();
  const runner = new LocalCommandRunner();
  const projectService = new ProjectService({
    runner,
    connectors: new ConnectorRegistry([]),
  });
  const raw = await projectService.snapshot([fixture.primary], { force: true });
  const registry = new WorkspaceRegistry();
  const reconciled = registry.reconcile(raw, [], {
    now: new Date("2026-08-28T10:00:00.000Z"),
  });
  let snapshot = reconciled.snapshot;
  const discovered = snapshot.projects
    .flatMap((project) => project.workspaces)
    .find(
      (workspace) => normalize(workspace.path) === normalize(fixture.worktree),
    );
  expect(discovered).toMatchObject({
    path: fixture.worktree,
    branch: "codex/e2e",
    isPrimary: false,
    adoption: { status: "not-adopted" },
  });
  if (!discovered) throw new Error("Fresh worktree was not discovered");

  const stablePlotId = discovered.workspaceId;
  const port = await availablePort();
  const canonicalUrl = `http://127.0.0.1:${port}`;
  const foreignPid = await startForeignChild(fixture.primary);
  const branchesBefore = await git(runner, fixture.primary, [
    "branch",
    "--format=%(refname)",
  ]);
  const worktreesBefore = await git(runner, fixture.primary, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const settingsPath = join(fixture.root, "persisted-settings.json");
  let records = [...reconciled.records];
  const persistedSettings: {
    workspaceRecords: WorkspaceRecord[];
    plotPorts: Record<string, number>;
    plotProvisioning: Record<string, PlotProvisioning>;
    runningCommands: SupervisedCommand[];
    routes: Record<string, { host: "127.0.0.1" | "::1"; port: number }>;
  } = {
    workspaceRecords: records,
    plotPorts: {},
    plotProvisioning: {},
    runningCommands: [],
    routes: {},
  };
  const persistSettings = () =>
    writeFileSync(settingsPath, JSON.stringify(persistedSettings), "utf8");
  persistSettings();
  const publishedRouteNames: string[] = [];
  const link: GateRouteLink = {
    set: async (route) => {
      publishedRouteNames.push(route.name);
      persistedSettings.routes[route.name] = {
        host: route.host,
        port: route.port,
      };
      persistSettings();
    },
    suspend: async (name) => {
      delete persistedSettings.routes[name];
      persistSettings();
    },
    inspect: async (name) => persistedSettings.routes[name],
  };
  const publisher = new GateRoutePublisher({
    link,
    inspect: async (processId) =>
      (await listenerPorts(runner, processId)).map((listenerPort) => ({
        processId,
        port: listenerPort,
      })),
    probe: async (url) => {
      try {
        const response = await fetch(url);
        const contentType = response.headers.get("content-type");
        return {
          status: response.status,
          ...(contentType ? { contentType } : {}),
        };
      } catch {
        return undefined;
      }
    },
    settleMs: 0,
  });
  const supervisor = new CommandSupervisor({
    logDirectory: join(fixture.root, "runtime-logs"),
    routePublisher: publisher,
    routeHealthIntervalMs: 60_000,
    onChange: (processes) => {
      persistedSettings.runningCommands = [...processes];
      persistSettings();
    },
  });
  cleanupSupervisors.push(supervisor);
  const definition: Readonly<Record<string, PlotCommand>> = {
    web: {
      run: shellCommand(
        process.execPath,
        `require("http").createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/html"});res.end("ready");}).listen(Number(process.env.PORT),"127.0.0.1",()=>console.log("web-ready"));`,
      ),
      url: true,
    },
    worker: {
      run: shellCommand(
        process.execPath,
        `console.log("worker-ready"); setInterval(() => {}, 1000);`,
      ),
    },
  };
  const provisionSteps: readonly ProvisionStep[] = [
    {
      label: "Create isolated test state",
      run: "printf provisioned > .silvic-provisioned",
    },
  ];
  const provisioner = new Provisioner(runner);
  const currentProject = () => {
    const project = snapshot.projects.find((candidate) =>
      candidate.workspaces.some(
        (candidateWorkspace) => candidateWorkspace.workspaceId === stablePlotId,
      ),
    );
    if (!project) throw new Error("Integration Project disappeared");
    return project;
  };
  const buildPlan = (
    workspaceId: string,
    scope: "single" | "family",
  ): PlotAdoptionPlan =>
    buildAdoptionPlan({
      project: currentProject(),
      selectedWorkspaceId: workspaceId,
      scope,
      steps: provisionSteps,
      member: () => ({ port, url: canonicalUrl }),
    });
  const persistAdoption = (
    workspaceId: string,
    adoption: NonNullable<WorkspaceRecord["adoption"]>,
  ) => {
    records = records.map((record) =>
      record.workspaceId === workspaceId ? { ...record, adoption } : record,
    );
    persistedSettings.workspaceRecords = records;
    snapshot = updateWorkspace(snapshot, workspaceId, { adoption });
    persistSettings();
  };
  const startRuntime = async (path: string, runtimeId: string) => {
    const command = definition[runtimeId];
    if (!command) throw new Error(`Unknown integration runtime ${runtimeId}`);
    await supervisor.start({
      plotPath: path,
      id: runtimeId,
      command,
      routeName: `${runtimeId}-codex-integration`,
      environment: {
        PORT: String(port),
        SILVIC_URL: canonicalUrl,
      },
      canRoute: true,
      detached: false,
    });
  };
  const productionProvision = async (
    path: string,
  ): Promise<PlotProvisionRunResult> => {
    const provision = await provisioner.run(provisionSteps, {
      root: path,
      sourceRoot: fixture.primary,
      project: "silvic-integration",
      plot: "codex-integration",
      branch: "codex/e2e",
      url: canonicalUrl,
      port,
    });
    const provisioning: PlotProvisioning = {
      status: provision.every((step) => step.exitCode === 0)
        ? "complete"
        : "failed",
      at: new Date().toISOString(),
      steps: provision,
    };
    persistedSettings.plotProvisioning[path] = provisioning;
    snapshot = updateWorkspace(snapshot, stablePlotId, { provisioning });
    persistSettings();
    if (provisioning.status !== "complete") {
      return {
        provision,
        runtime: {
          status: "failed",
          durationMs: 0,
          detail: "Provisioning failed before runtime startup",
        },
        readiness: {
          status: "failed",
          durationMs: 0,
          detail: "Provisioning failed before readiness",
        },
      };
    }
    const startedAt = Date.now();
    const failures: Record<string, string> = {};
    for (const runtimeId of Object.keys(definition)) {
      try {
        await startRuntime(path, runtimeId);
      } catch (error) {
        failures[runtimeId] =
          error instanceof Error ? error.message : String(error);
      }
    }
    const runtime = runtimeStartResult({
      commands: Object.keys(definition),
      processes: supervisor.list(),
      failures,
      durationMs: Date.now() - startedAt,
    });
    const readiness = await waitForReadiness({
      url: canonicalUrl,
      timeoutMs: 5_000,
      intervalMs: 50,
      probe: async (url) => {
        const web = supervisor.list().find((process) => process.id === "web");
        return web?.status === "running" && (await fetch(url)).ok;
      },
    });
    return { provision, runtime, readiness };
  };
  const controller = new AutomationController({
    snapshot: () => snapshot,
    roots: () => [fixture.primary],
    definition: async () => ({
      commands: definition,
      resources: {},
      previewUrl: canonicalUrl,
      requiresProvisioning: true,
    }),
    planAdoption: async ({ workspaceId, scope }) =>
      buildPlan(workspaceId, scope),
    adopt: async (request) =>
      executePlannedAdoption({
        plan: buildPlan(request.workspaceId, request.scope),
        confirmProviderChanges: request.confirmProviderChanges,
        state: (workspaceId) =>
          records.find((record) => record.workspaceId === workspaceId)
            ?.adoption,
        persist: persistAdoption,
        reserve: (member) => {
          persistedSettings.plotPorts[member.path] = member.port;
          persistSettings();
        },
        provision: (member) => productionProvision(member.path),
      }),
    provision: ({ path }) => productionProvision(path),
    inspectWorkspaceState: async () => emptyStatePlan(),
    pruneWorkspaceState: async () => ({
      plan: emptyStatePlan(),
      removedRecordIds: [],
    }),
    processes: () => supervisor.list(),
    start: startRuntime,
    stop: (path, runtimeId) => supervisor.stop(path, runtimeId),
    output: (path, runtimeId, limit) =>
      supervisor.output(path, runtimeId, limit),
    probe: async (url) => (await fetch(url)).ok,
  });
  const socketPath = join(fixture.root, "automation.sock");
  automationServer = await startAutomationServer({
    socketPath,
    handle: (request, signal) => controller.handle(request, signal),
  });
  const client = new AutomationClient({ socketPath });

  const projects = await client.call<{
    projects: { plots: { id: string }[] }[];
  }>("snapshot");
  expect(projects.projects[0]?.plots.map((plot) => plot.id)).toContain(
    stablePlotId,
  );
  await expect(
    client.call("start", { plot: fixture.worktree }),
  ).rejects.toMatchObject({ code: "ADOPTION_REQUIRED" });
  expect(supervisor.list()).toEqual([]);

  const planned = await client.call<{
    selectedPlotId: string;
    steps: { providerChanging: boolean }[];
  }>("adoptionPlan", { plot: fixture.worktree });
  expect(planned).toMatchObject({ selectedPlotId: stablePlotId });
  expect(planned.steps.some((step) => step.providerChanging)).toBe(true);
  await expect(
    client.call("adopt", {
      plot: fixture.worktree,
      confirmPlotId: fixture.worktree,
    }),
  ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  expect(workspace(snapshot, stablePlotId).adoption?.status).toBe(
    "not-adopted",
  );
  const adopted = await client.call<{
    members: { workspaceId: string; status: string }[];
  }>("adopt", {
    plot: fixture.worktree,
    confirmPlotId: stablePlotId,
  });
  expect(adopted.members).toEqual([
    expect.objectContaining({ workspaceId: stablePlotId, status: "adopted" }),
  ]);
  expect(persistedSettings.plotPorts[fixture.worktree]).toBe(port);
  expect(persistedSettings.plotProvisioning[fixture.worktree]?.status).toBe(
    "complete",
  );
  await expect(
    client.call("wait", { plot: stablePlotId, timeoutMs: 5_000 }),
  ).resolves.toMatchObject({ url: canonicalUrl });

  await client.call("stop", { plot: stablePlotId });
  const failedProvisioning: PlotProvisioning = {
    status: "failed",
    at: new Date().toISOString(),
    steps: [],
  };
  persistedSettings.plotProvisioning[fixture.worktree] = failedProvisioning;
  snapshot = updateWorkspace(snapshot, stablePlotId, {
    provisioning: failedProvisioning,
  });
  persistSettings();
  await expect(
    client.call("start", { plot: stablePlotId }),
  ).rejects.toMatchObject({ code: "PROVISIONING_REQUIRED" });
  expect(
    supervisor
      .list()
      .filter((process) =>
        ["starting", "running", "stopping"].includes(process.status),
      ),
  ).toEqual([]);
  await expect(
    client.call("provision", {
      plot: stablePlotId,
      confirmPlotId: "not-the-stable-id",
    }),
  ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  expect(workspace(snapshot, stablePlotId).provisioning?.status).toBe("failed");
  await client.call("provision", {
    plot: stablePlotId,
    confirmPlotId: stablePlotId,
  });

  const started = await client.call<{
    results: { runtimeId: string; action: string }[];
  }>("start", { plot: stablePlotId });
  expect(started.results).toEqual([
    { runtimeId: "web", action: "already-running" },
    { runtimeId: "worker", action: "already-running" },
  ]);
  const ready = await client.call<{ url: string }>("wait", {
    plot: stablePlotId,
    timeoutMs: 5_000,
  });
  expect(ready.url).toBe(canonicalUrl);

  const status = await client.call<{
    state: string;
    previewUrl: string;
    runtimes: { id: string; status: string; processId: number }[];
  }>("status", { plot: stablePlotId });
  expect(status).toMatchObject({ state: "ready", previewUrl: canonicalUrl });
  expect(status.runtimes.map((runtime) => runtime.status)).toEqual([
    "running",
    "running",
  ]);
  for (const runtime of status.runtimes) {
    expect(runtime.processId).toBeGreaterThan(0);
    expect(await processCwd(runner, runtime.processId)).toBe(
      normalize(fixture.worktree),
    );
  }
  const webPid = status.runtimes.find(
    (runtime) => runtime.id === "web",
  )?.processId;
  if (!webPid) throw new Error("Web PID missing from status");
  expect(await listenerPorts(runner, webPid)).toContain(port);

  const logs = await client.call<{
    entries: { runtimeId: string; output: string }[];
  }>("logs", { plot: stablePlotId });
  expect(logs.entries).toEqual([
    expect.objectContaining({
      runtimeId: "web",
      output: expect.stringContaining("web-ready"),
    }),
    expect.objectContaining({
      runtimeId: "worker",
      output: expect.stringContaining("worker-ready"),
    }),
  ]);
  expect(publishedRouteNames).toContain("web-codex-integration");
  const persistedWhileRunning = JSON.parse(
    await readFile(settingsPath, "utf8"),
  ) as typeof persistedSettings;
  expect(
    persistedWhileRunning.runningCommands.filter(
      (process) => process.status === "running",
    ),
  ).toHaveLength(2);
  expect(persistedWhileRunning.routes["web-codex-integration"]?.port).toBe(
    port,
  );

  const stopped = await client.call<{
    results: { runtimeId: string; action: string }[];
  }>("stop", { plot: stablePlotId });
  expect(stopped.results).toEqual([
    { runtimeId: "web", action: "stopped", ownership: "silvic" },
    { runtimeId: "worker", action: "stopped", ownership: "silvic" },
  ]);
  expect(isAlive(foreignPid)).toBe(true);
  expect(
    await git(runner, fixture.primary, ["branch", "--format=%(refname)"]),
  ).toBe(branchesBefore);
  expect(
    await git(runner, fixture.primary, ["worktree", "list", "--porcelain"]),
  ).toBe(worktreesBefore);
  const persistedAfterStop = JSON.parse(
    await readFile(settingsPath, "utf8"),
  ) as typeof persistedSettings;
  expect(persistedAfterStop.routes).toEqual({});
  expect(
    persistedAfterStop.runningCommands.some((process) =>
      ["starting", "running", "stopping"].includes(process.status),
    ),
  ).toBe(false);
}, 30_000);

it("prunes stale metadata beside an active Plot without touching foreign state", async () => {
  const fixture = await gitWorktreeFixture();
  const runner = new LocalCommandRunner();
  const foreignPid = await startForeignChild(fixture.worktree);
  const branchesBefore = await git(runner, fixture.primary, [
    "branch",
    "--format=%(refname)",
  ]);
  const worktreesBefore = await git(runner, fixture.primary, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  const records: WorkspaceRecord[] = [
    {
      workspaceId: "active-plot",
      projectId: "project",
      path: fixture.worktree,
      branch: "codex/e2e",
      lastSeenAt: "2026-08-28T00:00:00.000Z",
    },
    {
      workspaceId: "stale-metadata",
      projectId: "project",
      path: join(fixture.root, "gone-worktree"),
      branch: "foreign/untouched",
      missingSince: "2026-01-01T00:00:00.000Z",
    },
  ];
  const plan = planWorkspaceState({
    records,
    now: new Date("2026-08-28T00:00:00.000Z"),
    existingPaths: new Set([fixture.worktree]),
    activeRuntimePaths: new Set([fixture.worktree]),
  });
  const applied = applyWorkspaceStatePlan(records, plan, plan.planId);

  expect(applied.removed.map((record) => record.workspaceId)).toEqual([
    "stale-metadata",
  ]);
  expect(applied.records.map((record) => record.workspaceId)).toEqual([
    "active-plot",
  ]);
  expect(isAlive(foreignPid)).toBe(true);
  expect(
    await git(runner, fixture.primary, ["branch", "--format=%(refname)"]),
  ).toBe(branchesBefore);
  expect(
    await git(runner, fixture.primary, ["worktree", "list", "--porcelain"]),
  ).toBe(worktreesBefore);
});

async function gitWorktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), "silvic-codex-integration-"));
  temporaryDirectories.push(root);
  const primary = join(root, "project");
  const worktree = join(root, "codex-worktree");
  const runner = new LocalCommandRunner();
  await git(runner, root, ["init", "-b", "main", primary]);
  await git(runner, primary, ["config", "user.email", "silvic@example.test"]);
  await git(runner, primary, ["config", "user.name", "Silvic Integration"]);
  await writeFile(join(primary, "README.md"), "fixture\n", "utf8");
  await git(runner, primary, ["add", "README.md"]);
  await git(runner, primary, ["commit", "-m", "fixture"]);
  await git(runner, primary, ["worktree", "add", "-b", "codex/e2e", worktree]);
  return {
    root: await realpath(root),
    primary: await realpath(primary),
    worktree: await realpath(worktree),
  };
}

async function git(
  runner: LocalCommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const result = await runner.run({ executable: "git", arguments: args, cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function workspace(snapshot: SilvicSnapshot, workspaceId: string) {
  const found = snapshot.projects
    .flatMap((project) => project.workspaces)
    .find((candidate) => candidate.workspaceId === workspaceId);
  if (!found) throw new Error(`Unknown Workspace ${workspaceId}`);
  return found;
}

function updateWorkspace(
  snapshot: SilvicSnapshot,
  workspaceId: string,
  update: Partial<ReturnType<typeof workspace>>,
): SilvicSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      workspaces: project.workspaces.map((candidate) =>
        candidate.workspaceId === workspaceId
          ? { ...candidate, ...update }
          : candidate,
      ),
    })),
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function childStarted(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function startForeignChild(cwd: string): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd,
    stdio: "ignore",
  });
  cleanupProcesses.push(child);
  await childStarted(child);
  if (!child.pid) throw new Error("Foreign process did not start");
  return child.pid;
}

function stopChild(child: ChildProcess): void {
  if (!child.pid || !isAlive(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function isAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCwd(
  runner: LocalCommandRunner,
  processId: number,
): Promise<string> {
  const result = await runner.run({
    executable: "lsof",
    arguments: ["-a", "-p", String(processId), "-d", "cwd", "-Fn"],
  });
  const path = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("n/"))
    ?.slice(1);
  if (!path) throw new Error(`No CWD for PID ${processId}`);
  return normalize(path);
}

async function listenerPorts(
  runner: LocalCommandRunner,
  processId: number,
): Promise<number[]> {
  const result = await runner.run({
    executable: "lsof",
    arguments: [
      "-nP",
      "-a",
      "-p",
      String(processId),
      "-iTCP",
      "-sTCP:LISTEN",
      "-Fn",
    ],
  });
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/:(\d+)(?:\s|$)/);
    return match?.[1] ? [Number(match[1])] : [];
  });
}

function emptyStatePlan() {
  return {
    planId: "state_empty",
    generatedAt: "2026-08-28T00:00:00.000Z",
    retentionDays: 30,
    totalRecords: 0,
    activeRecords: 0,
    staleRecords: [],
    prunableRecordIds: [],
    storage: [],
    boundaries: [],
  };
}

function shellCommand(executable: string, script: string): string {
  return `exec ${shellQuote(executable)} -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
