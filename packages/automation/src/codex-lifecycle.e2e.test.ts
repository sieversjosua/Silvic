import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, expect, it } from "vitest";

import type {
  PlotAdoption,
  PlotCommand,
  SilvicSnapshot,
} from "@silvic/contracts";
import {
  ConnectorRegistry,
  LocalCommandRunner,
  ProjectService,
  WorkspaceRegistry,
  applyWorkspaceStatePlan,
  planWorkspaceState,
  type SupervisedCommand,
  type WorkspaceRecord,
} from "@silvic/core";

import { AutomationClient } from "./client";
import { AutomationController } from "./controller";
import { startAutomationServer, type AutomationServer } from "./server";

const temporaryDirectories: string[] = [];
const cleanupProcesses: ChildProcess[] = [];
let automationServer: AutomationServer | undefined;

afterEach(async () => {
  await automationServer?.close();
  automationServer = undefined;
  for (const child of cleanupProcesses.splice(0)) stopChild(child);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("recovers a freshly discovered Codex worktree and proves PID/listener/CWD ownership", async () => {
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
  const processes = new TestRuntimeManager(fixture.worktree, port);
  const foreign = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      cwd: fixture.primary,
      stdio: "ignore",
    },
  );
  cleanupProcesses.push(foreign);
  await childStarted(foreign);
  const foreignPid = foreign.pid;
  if (!foreignPid) throw new Error("Foreign process did not start");
  const branchesBefore = await git(runner, fixture.primary, [
    "branch",
    "--format=%(refname)",
  ]);
  const worktreesBefore = await git(runner, fixture.primary, [
    "worktree",
    "list",
    "--porcelain",
  ]);

  const definition: Readonly<Record<string, PlotCommand>> = {
    web: { run: "test web runtime", url: true },
    worker: { run: "test worker runtime" },
  };
  const controller = new AutomationController({
    snapshot: () => snapshot,
    roots: () => [fixture.primary],
    definition: async () => ({
      commands: definition,
      previewUrl: canonicalUrl,
      requiresProvisioning: true,
    }),
    planAdoption: async ({ workspaceId, scope }) => ({
      projectId: discovered.projectId,
      scope,
      members: [
        {
          workspaceId,
          name: discovered.name,
          branch: discovered.branch,
          path: discovered.path,
          port,
          url: canonicalUrl,
          status:
            workspace(snapshot, workspaceId).adoption?.status ?? "not-adopted",
        },
      ],
      steps: [
        { label: "Confirm stable Plot identity", providerChanging: false },
        { label: "Provision isolated provider state", providerChanging: true },
      ],
      requiresProviderConfirmation: true,
    }),
    adopt: async ({ workspaceId }) => {
      const adoption: PlotAdoption = {
        status: "adopted",
        at: "2026-08-28T10:01:00.000Z",
        attempt: 1,
      };
      snapshot = updateWorkspace(snapshot, workspaceId, { adoption });
      return {
        members: [
          {
            workspaceId,
            name: discovered.name,
            status: "adopted",
          },
        ],
      };
    },
    provision: async ({ path }) => {
      snapshot = updateWorkspace(snapshot, stablePlotId, {
        provisioning: {
          status: "complete",
          at: "2026-08-28T10:02:00.000Z",
          steps: [provisionStep()],
        },
      });
      expect(normalize(path)).toBe(normalize(fixture.worktree));
      return {
        provision: [provisionStep()],
        runtime: { status: "not-required", durationMs: 0 },
        readiness: { status: "not-required", durationMs: 0 },
      };
    },
    inspectWorkspaceState: async () => emptyStatePlan(),
    pruneWorkspaceState: async () => ({
      plan: emptyStatePlan(),
      removedRecordIds: [],
    }),
    processes: () => processes.list(),
    start: (path, runtimeId) => processes.start(path, runtimeId),
    stop: (path, runtimeId) => processes.stop(path, runtimeId),
    output: (_path, runtimeId, limit) =>
      Promise.resolve(processes.output(runtimeId).slice(-limit)),
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
  expect(processes.list()).toEqual([]);

  const adoptionPlan = await client.call<{
    selectedPlotId: string;
    steps: { providerChanging: boolean }[];
  }>("adoptionPlan", { plot: fixture.worktree });
  expect(adoptionPlan).toMatchObject({ selectedPlotId: stablePlotId });
  expect(adoptionPlan.steps.some((step) => step.providerChanging)).toBe(true);
  await expect(
    client.call("adopt", {
      plot: fixture.worktree,
      confirmPlotId: fixture.worktree,
    }),
  ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  expect(workspace(snapshot, stablePlotId).adoption?.status).toBe(
    "not-adopted",
  );
  await client.call("adopt", {
    plot: fixture.worktree,
    confirmPlotId: stablePlotId,
  });
  await expect(
    client.call("start", { plot: stablePlotId }),
  ).rejects.toMatchObject({ code: "PROVISIONING_REQUIRED" });
  expect(processes.list()).toEqual([]);
  await expect(
    client.call("provision", {
      plot: stablePlotId,
      confirmPlotId: "not-the-stable-id",
    }),
  ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  expect(workspace(snapshot, stablePlotId).provisioning).toBeUndefined();
  await client.call("provision", {
    plot: stablePlotId,
    confirmPlotId: stablePlotId,
  });

  const started = await client.call<{
    results: { runtimeId: string; action: string }[];
  }>("start", { plot: stablePlotId });
  expect(started.results).toEqual([
    { runtimeId: "web", action: "started" },
    { runtimeId: "worker", action: "started" },
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
}, 30_000);

it("prunes stale metadata beside an active Plot without touching foreign state", async () => {
  const fixture = await gitWorktreeFixture();
  const runner = new LocalCommandRunner();
  const foreign = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      cwd: fixture.worktree,
      stdio: "ignore",
    },
  );
  cleanupProcesses.push(foreign);
  await childStarted(foreign);
  const foreignPid = foreign.pid;
  if (!foreignPid) throw new Error("Foreign process did not start");
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

class TestRuntimeManager {
  private readonly commands = new Map<string, SupervisedCommand>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly logs = new Map<string, string>();

  constructor(
    private readonly plotPath: string,
    private readonly port: number,
  ) {}

  list(): readonly SupervisedCommand[] {
    return [...this.commands.values()];
  }

  async start(plotPath: string, id: string): Promise<void> {
    expect(normalize(plotPath)).toBe(normalize(this.plotPath));
    const script =
      id === "web"
        ? `require("http").createServer((_req,res)=>res.end("ready")).listen(${this.port},"127.0.0.1",()=>console.log("web-ready"));`
        : `console.log("worker-ready"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", script], {
      cwd: this.plotPath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanupProcesses.push(child);
    this.children.set(id, child);
    this.logs.set(id, "");
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${id} did not start`)),
        5_000,
      );
      const record = (chunk: Buffer) => {
        const next = `${this.logs.get(id) ?? ""}${chunk.toString("utf8")}`;
        this.logs.set(id, next);
        if (next.includes(`${id}-ready`)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout?.on("data", record);
      child.stderr?.on("data", record);
      child.once("error", reject);
      child.once("exit", (code) => {
        const current = this.commands.get(id);
        if (current) {
          this.commands.set(id, {
            ...current,
            status: code === 0 || code === null ? "stopped" : "failed",
            ...(code === null ? {} : { exitCode: code }),
          });
        }
      });
    });
    if (!child.pid) throw new Error(`${id} has no PID`);
    this.commands.set(id, {
      plotPath: this.plotPath,
      id,
      status: "starting",
      processId: child.pid,
      ...(id === "web"
        ? {
            url: `http://127.0.0.1:${this.port}`,
            targetPort: this.port,
            expectedPort: this.port,
          }
        : {}),
    });
    await ready;
    this.commands.set(id, { ...this.commands.get(id)!, status: "running" });
  }

  stop(plotPath: string, id: string): void {
    expect(normalize(plotPath)).toBe(normalize(this.plotPath));
    const current = this.commands.get(id);
    const child = this.children.get(id);
    if (!current || !child?.pid) return;
    this.commands.set(id, { ...current, status: "stopping" });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  output(id: string): string {
    return this.logs.get(id) ?? "";
  }
}

async function gitWorktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), "silvic-codex-e2e-"));
  temporaryDirectories.push(root);
  const primary = join(root, "project");
  const worktree = join(root, "codex-worktree");
  const runner = new LocalCommandRunner();
  await git(runner, root, ["init", "-b", "main", primary]);
  await git(runner, primary, ["config", "user.email", "silvic@example.test"]);
  await git(runner, primary, ["config", "user.name", "Silvic E2E"]);
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

function provisionStep() {
  return {
    label: "Create isolated test state",
    command: "fixture-provision",
    exitCode: 0,
    output: "provisioned",
    durationMs: 1,
  };
}
