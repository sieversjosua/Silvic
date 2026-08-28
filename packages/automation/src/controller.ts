import { normalize } from "node:path";

import type {
  PlotAdoptionPlan,
  PlotAdoptionRunRequest,
  PlotAdoptionRunResult,
  PlotCommand,
  PlotResourceDefinition,
  PlotProvisionRequest,
  PlotProvisionRunResult,
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";
import { assessResourceIsolation } from "@silvic/contracts";
import type { SupervisedCommand, WorkspaceStatePlan } from "@silvic/core";

import { AutomationError, type AutomationRequest } from "./protocol";

export type PlotLifecycleState =
  | "stopped"
  | "starting"
  | "ready"
  | "failed"
  | "partially-running"
  | "stopping";

export interface AutomationRuntime {
  id: string;
  status: SupervisedCommand["status"];
  servesPreview: boolean;
  ownership: "silvic" | "external";
  url?: string;
  routeName?: string;
  targetPort?: number;
  expectedPort?: number;
  inspectorPort?: number;
  identity?: string;
  processId?: number;
  exitCode?: number;
  advice?: string;
  notice?: string;
}

export interface AutomationPlot {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch: string;
  isPrimary: boolean;
  adoption?: WorkspaceSnapshot["adoption"];
  provisioning?: WorkspaceSnapshot["provisioning"];
  state: PlotLifecycleState;
  previewUrl?: string;
  runtimes: readonly AutomationRuntime[];
  resources: readonly AutomationResource[];
  diagnostics: readonly string[];
}

export interface AutomationResource {
  id: string;
  provider: PlotResourceDefinition["provider"];
  kind: PlotResourceDefinition["kind"];
  isolation: PlotResourceDefinition["isolation"];
  commandId?: string;
  /** Local runtime identity is namespaced; the provider itself remains shared. */
  runtimeIdentity?: "namespaced";
}

export interface AutomationProject {
  id: string;
  name: string;
  rootPath: string;
  plots: readonly AutomationPlot[];
}

interface PlotDefinition {
  commands: Readonly<Record<string, PlotCommand>>;
  resources: Readonly<Record<string, PlotResourceDefinition>>;
  requiresProvisioning: boolean;
  previewUrl?: string;
}

export interface AutomationControllerOptions {
  snapshot(): SilvicSnapshot;
  roots(): readonly string[];
  definition(
    project: ProjectSnapshot,
    plot: WorkspaceSnapshot,
  ): Promise<PlotDefinition>;
  planAdoption(request: {
    workspaceId: string;
    scope: "single" | "family";
  }): Promise<PlotAdoptionPlan>;
  adopt(request: PlotAdoptionRunRequest): Promise<PlotAdoptionRunResult>;
  provision(request: PlotProvisionRequest): Promise<PlotProvisionRunResult>;
  inspectWorkspaceState(): Promise<WorkspaceStatePlan>;
  pruneWorkspaceState(confirmPlanId: string): Promise<{
    plan: WorkspaceStatePlan;
    removedRecordIds: readonly string[];
  }>;
  processes(): readonly SupervisedCommand[];
  start(plotPath: string, runtimeId: string): Promise<void>;
  stop(plotPath: string, runtimeId: string): void;
  output(plotPath: string, runtimeId: string, limit: number): Promise<string>;
  probe(url: string): Promise<boolean>;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
}

export class AutomationController {
  private readonly runtimeLocks = new Map<string, Promise<void>>();
  private recoveryLock: Promise<void> = Promise.resolve();

  constructor(private readonly options: AutomationControllerOptions) {}

  async handle(
    request: AutomationRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<unknown> {
    switch (request.method) {
      case "snapshot":
        return this.snapshot(request.params);
      case "status":
        return this.status(request.params);
      case "adoptionPlan":
        return this.adoptionPlan(request.params);
      case "adopt":
        return this.adopt(request.params);
      case "provision":
        return this.provision(request.params);
      case "workspaceStatePlan":
        return this.workspaceStatePlan(request.params);
      case "pruneWorkspaceState":
        return this.pruneWorkspaceState(request.params);
      case "start":
        return this.start(request.params, signal);
      case "stop":
        return this.stop(request.params, signal);
      case "wait":
        return this.wait(request.params, signal);
      case "logs":
        return this.logs(request.params);
    }
  }

  private async snapshot(params: Record<string, unknown>) {
    assertOnly(params, ["projectId"]);
    const projectId = optionalString(params, "projectId");
    const projects = await Promise.all(
      this.options
        .snapshot()
        .projects.filter((project) => !projectId || project.id === projectId)
        .map(async (project) => ({
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
          plots: await Promise.all(
            project.workspaces.map((plot) => this.describe(project, plot)),
          ),
        })),
    );
    return {
      roots: [...this.options.roots()],
      projects,
      refreshedAt: this.options.snapshot().refreshedAt,
    };
  }

  private async status(params: Record<string, unknown>) {
    assertOnly(params, ["plot"]);
    const found = this.findPlot(requiredString(params, "plot"));
    return this.describe(found.project, found.plot);
  }

  private async adoptionPlan(params: Record<string, unknown>) {
    assertOnly(params, ["plot", "scope"]);
    const found = this.findPlot(requiredString(params, "plot"));
    this.assertExternalPlot(found.plot);
    const plan = await this.options.planAdoption({
      workspaceId: found.plot.workspaceId,
      scope: optionalScope(params),
    });
    return { ...plan, selectedPlotId: found.plot.workspaceId };
  }

  private async adopt(params: Record<string, unknown>) {
    assertOnly(params, ["plot", "scope", "confirmPlotId"]);
    const found = this.findPlot(requiredString(params, "plot"));
    this.assertExternalPlot(found.plot);
    this.assertStableConfirmation(found.plot, params);
    return this.withRecoveryLock(async () => {
      const result = await this.options.adopt({
        workspaceId: found.plot.workspaceId,
        scope: optionalScope(params),
        confirmProviderChanges: true,
      });
      const failed = result.members.some(
        (member) => member.status === "failed",
      );
      const succeeded = result.members.some(
        (member) => member.status !== "failed",
      );
      return {
        ...result,
        failed,
        partialFailure: failed && succeeded,
      };
    });
  }

  private async provision(params: Record<string, unknown>) {
    assertOnly(params, ["plot", "confirmPlotId", "remedy"]);
    const found = this.findPlot(requiredString(params, "plot"));
    this.assertExternalPlot(found.plot);
    this.assertStableConfirmation(found.plot, params);
    if (found.plot.adoption?.status !== "adopted") {
      throw new AutomationError(
        "ADOPTION_REQUIRED",
        "Adopt this Plot before retrying its provisioning.",
        {
          plotId: found.plot.workspaceId,
          adoptionStatus: found.plot.adoption?.status ?? "not-adopted",
        },
      );
    }
    return this.withRecoveryLock(async () => {
      const current = this.findPlot(found.plot.workspaceId).plot;
      if (current.provisioning?.status === "complete") {
        return {
          provision: current.provisioning.steps,
          runtime: { status: "not-required" as const, durationMs: 0 },
          readiness: { status: "not-required" as const, durationMs: 0 },
          alreadyProvisioned: true,
          failed: false,
          partialFailure: false,
        };
      }
      const remedy = optionalRemedy(params);
      const result = await this.options.provision({
        path: current.path,
        ...(remedy ? { remedy } : {}),
      });
      const failed =
        result.provision.some((step) => step.exitCode !== 0) ||
        result.runtime.status === "failed" ||
        result.readiness.status === "failed";
      const succeeded =
        result.provision.some((step) => step.exitCode === 0) ||
        result.runtime.status === "started" ||
        result.readiness.status === "ready";
      return {
        ...result,
        alreadyProvisioned: false,
        failed,
        partialFailure: failed && succeeded,
      };
    });
  }

  private async workspaceStatePlan(params: Record<string, unknown>) {
    assertOnly(params, []);
    return this.options.inspectWorkspaceState();
  }

  private async pruneWorkspaceState(params: Record<string, unknown>) {
    assertOnly(params, ["confirmPlanId"]);
    return this.options.pruneWorkspaceState(
      requiredString(params, "confirmPlanId"),
    );
  }

  private async start(params: Record<string, unknown>, signal: AbortSignal) {
    assertOnly(params, ["plot", "runtime"]);
    const found = this.findPlot(requiredString(params, "plot"));
    const definition = await this.options.definition(found.project, found.plot);
    this.assertStartable(found.plot, definition);
    const requested = optionalString(params, "runtime");
    const ids = selectRuntimeIds(definition.commands, requested);
    const results: Array<{
      runtimeId: string;
      action: "started" | "already-running" | "failed";
      message?: string;
    }> = [];
    for (const id of ids) {
      results.push(
        await this.withRuntimeLock(found.plot.path, id, async () => {
          await this.waitWhileStopping(found.plot.path, id, signal);
          const before = this.process(found.plot.path, id);
          if (before?.status === "starting" || before?.status === "running") {
            return { runtimeId: id, action: "already-running" as const };
          }
          if (before?.status === "stopping") {
            return {
              runtimeId: id,
              action: "failed" as const,
              message: "The runtime did not finish stopping within 10 seconds.",
            };
          }
          try {
            await this.options.start(found.plot.path, id);
            return { runtimeId: id, action: "started" as const };
          } catch (error) {
            return {
              runtimeId: id,
              action: "failed" as const,
              message: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
    }
    return {
      results,
      plot: await this.describe(found.project, found.plot),
      partialFailure: results.some((result) => result.action === "failed"),
    };
  }

  private async stop(params: Record<string, unknown>, signal: AbortSignal) {
    assertOnly(params, ["plot", "runtime"]);
    const found = this.findPlot(requiredString(params, "plot"));
    const definition = await this.options.definition(found.project, found.plot);
    const requested = optionalString(params, "runtime");
    const ids = selectRuntimeIds(definition.commands, requested);
    const results = [];
    for (const id of ids) {
      results.push(
        await this.withRuntimeLock(found.plot.path, id, async () => {
          const before = this.process(found.plot.path, id);
          if (
            !before ||
            before.status === "stopped" ||
            before.status === "failed"
          ) {
            return { runtimeId: id, action: "already-stopped" as const };
          }
          if (before.status === "stopping") {
            const stopped = await this.waitUntilStopped(
              found.plot.path,
              id,
              signal,
            );
            return stopped
              ? { runtimeId: id, action: "already-stopped" as const }
              : {
                  runtimeId: id,
                  action: "failed" as const,
                  message: "The runtime did not stop within 10 seconds.",
                };
          }
          const external = before.ownership === "external";
          this.options.stop(found.plot.path, id);
          if (external) {
            return {
              runtimeId: id,
              action: "detached" as const,
              ownership: "external" as const,
            };
          }
          const stopped = await this.waitUntilStopped(
            found.plot.path,
            id,
            signal,
          );
          return stopped
            ? {
                runtimeId: id,
                action: "stopped" as const,
                ownership: "silvic" as const,
              }
            : {
                runtimeId: id,
                action: "failed" as const,
                ownership: "silvic" as const,
                message: "The runtime did not stop within 10 seconds.",
              };
        }),
      );
    }
    return {
      results,
      plot: await this.describe(found.project, found.plot),
      partialFailure: results.some((result) => result.action === "failed"),
    };
  }

  private async wait(params: Record<string, unknown>, signal: AbortSignal) {
    assertOnly(params, ["plot", "timeoutMs"]);
    const found = this.findPlot(requiredString(params, "plot"));
    const timeoutMs = optionalInteger(params, "timeoutMs", 60_000, 1, 600_000);
    const definition = await this.options.definition(found.project, found.plot);
    if (!definition.previewUrl) {
      throw new AutomationError(
        "NO_PREVIEW",
        "This Plot declares no preview runtime.",
      );
    }
    const serving = Object.entries(definition.commands)
      .filter(([, command]) => command.url === true)
      .map(([id]) => id);
    if (serving.length === 0) {
      throw new AutomationError(
        "NO_PREVIEW",
        "This Plot declares no preview runtime.",
      );
    }
    const now = this.options.now ?? Date.now;
    const pause =
      this.options.wait ??
      ((milliseconds: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const startedAt = now();
    let latest = await this.describe(found.project, found.plot);
    while (true) {
      if (signal.aborted) {
        throw new AutomationError("CANCELLED", "Operation was cancelled.");
      }
      const byId = new Map(
        latest.runtimes.map((runtime) => [runtime.id, runtime]),
      );
      const failed = serving
        .map((id) => byId.get(id))
        .find((runtime) => runtime?.status === "failed");
      if (failed) {
        throw new AutomationError(
          "RUNTIME_FAILED",
          failed.advice ??
            `Preview runtime ${failed.id} exited with code ${failed.exitCode ?? 1}.`,
          latest,
        );
      }
      if (
        serving.every((id) => byId.get(id)?.status === "running") &&
        (await this.options.probe(definition.previewUrl))
      ) {
        return {
          ready: true,
          url: definition.previewUrl,
          durationMs: now() - startedAt,
          plot: latest,
        };
      }
      if (now() - startedAt >= timeoutMs) {
        throw new AutomationError(
          "READINESS_TIMEOUT",
          `Preview did not become ready within ${timeoutMs} ms.`,
          latest,
        );
      }
      await abortiblePause(
        pause,
        Math.min(500, timeoutMs - (now() - startedAt)),
        signal,
      );
      latest = await this.describe(found.project, found.plot);
    }
  }

  private async logs(params: Record<string, unknown>) {
    assertOnly(params, ["plot", "runtime", "limit"]);
    const found = this.findPlot(requiredString(params, "plot"));
    const definition = await this.options.definition(found.project, found.plot);
    const requested = optionalString(params, "runtime");
    const ids = selectRuntimeIds(definition.commands, requested);
    const limit = optionalInteger(params, "limit", 20_000, 1, 200_000);
    const plot = await this.describe(found.project, found.plot);
    return {
      plotId: found.plot.workspaceId,
      entries: await Promise.all(
        ids.map(async (runtimeId) => ({
          runtimeId,
          output: await this.options.output(found.plot.path, runtimeId, limit),
        })),
      ),
      diagnostics: plot.diagnostics,
    };
  }

  private async describe(
    project: ProjectSnapshot,
    plot: WorkspaceSnapshot,
  ): Promise<AutomationPlot> {
    const definition = await this.options.definition(project, plot);
    const runtimes = Object.entries(definition.commands).map(
      ([id, command]): AutomationRuntime => {
        const process = this.process(plot.path, id);
        return {
          id,
          status: process?.status ?? "stopped",
          servesPreview: command.url === true,
          ownership: process?.ownership === "external" ? "external" : "silvic",
          ...(process?.url ? { url: process.url } : {}),
          ...(process?.routeName ? { routeName: process.routeName } : {}),
          ...(process?.targetPort === undefined
            ? {}
            : { targetPort: process.targetPort }),
          ...(process?.expectedPort === undefined
            ? {}
            : { expectedPort: process.expectedPort }),
          ...(process?.inspectorPort === undefined
            ? {}
            : { inspectorPort: process.inspectorPort }),
          ...(process?.identity ? { identity: process.identity } : {}),
          ...(process?.processId === undefined
            ? {}
            : { processId: process.processId }),
          ...(process?.exitCode === undefined
            ? {}
            : { exitCode: process.exitCode }),
          ...(process?.advice ? { advice: process.advice } : {}),
          ...(process?.notice ? { notice: process.notice } : {}),
        };
      },
    );
    const resourceAssessments = Object.entries(definition.resources).map(
      ([id, resource]) => ({
        id,
        resource,
        assessment: assessResourceIsolation(resource),
      }),
    );
    const resources = resourceAssessments.map(
      ({ id, resource, assessment }): AutomationResource => ({
        id,
        provider: resource.provider,
        kind: resource.kind,
        isolation: resource.isolation,
        ...(resource.command ? { commandId: resource.command } : {}),
        ...(assessment.runtimeIdentity
          ? { runtimeIdentity: assessment.runtimeIdentity }
          : {}),
      }),
    );
    const isolationDiagnostics = resourceAssessments.flatMap(
      ({ id, assessment }) =>
        assessment.warning ? [`${id}: ${assessment.warning}`] : [],
    );
    return {
      id: plot.workspaceId,
      projectId: project.id,
      name: plot.name,
      path: plot.path,
      branch: plot.git.branch,
      isPrimary: plot.isPrimary,
      ...(plot.adoption ? { adoption: plot.adoption } : {}),
      ...(plot.provisioning ? { provisioning: plot.provisioning } : {}),
      state: lifecycleState(runtimes),
      ...(definition.previewUrl ? { previewUrl: definition.previewUrl } : {}),
      runtimes,
      resources,
      diagnostics: [
        ...runtimes.flatMap((runtime) =>
          runtime.advice
            ? [`${runtime.id}: ${runtime.advice}`]
            : runtime.status === "failed"
              ? [`${runtime.id}: exited with code ${runtime.exitCode ?? 1}`]
              : [],
        ),
        ...isolationDiagnostics,
      ],
    };
  }

  private findPlot(selector: string): {
    project: ProjectSnapshot;
    plot: WorkspaceSnapshot;
  } {
    const targetPath = normalize(selector);
    for (const project of this.options.snapshot().projects) {
      const plot = project.workspaces.find(
        (candidate) =>
          candidate.workspaceId === selector ||
          normalize(candidate.path) === targetPath,
      );
      if (plot) return { project, plot };
    }
    throw new AutomationError(
      "PLOT_NOT_FOUND",
      `No watched Plot matches ${selector}.`,
    );
  }

  private process(plotPath: string, id: string): SupervisedCommand | undefined {
    const target = normalize(plotPath);
    return this.options
      .processes()
      .find(
        (process) =>
          normalize(process.plotPath) === target && process.id === id,
      );
  }

  private assertStartable(
    plot: WorkspaceSnapshot,
    definition: PlotDefinition,
  ): void {
    if (plot.isPrimary) return;

    const adoptionStatus = plot.adoption?.status ?? "not-adopted";
    if (adoptionStatus !== "adopted") {
      const remedy =
        adoptionStatus === "failed"
          ? "Retry this Plot's adoption"
          : adoptionStatus === "adopting"
            ? "Wait for this Plot's adoption to finish"
            : "Adopt this Plot";
      throw new AutomationError(
        "ADOPTION_REQUIRED",
        `${remedy} before starting runtimes. Inspect the adoption plan, then explicitly confirm the stable Plot ID.`,
        {
          plotId: plot.workspaceId,
          adoptionStatus,
          recovery: {
            cli: `silvic adoption-plan --plot ${plot.workspaceId}`,
            mcp: "plan_plot_adoption",
          },
        },
      );
    }

    if (
      definition.requiresProvisioning &&
      plot.provisioning?.status !== "complete"
    ) {
      const provisioningStatus = plot.provisioning?.status ?? "not-run";
      throw new AutomationError(
        "PROVISIONING_REQUIRED",
        `${provisioningStatus === "failed" ? "Retry" : "Run"} provisioning before starting runtimes for this Plot. Inspect the plan, then explicitly confirm the stable Plot ID.`,
        {
          plotId: plot.workspaceId,
          provisioningStatus,
          recovery: {
            cli: `silvic adoption-plan --plot ${plot.workspaceId}`,
            mcp: "plan_plot_adoption",
          },
        },
      );
    }
  }

  private assertStableConfirmation(
    plot: WorkspaceSnapshot,
    params: Record<string, unknown>,
  ): void {
    const confirmation = optionalString(params, "confirmPlotId");
    if (confirmation !== plot.workspaceId) {
      throw new AutomationError(
        "CONFIRMATION_REQUIRED",
        `Confirm this operation with stable Plot ID ${plot.workspaceId}.`,
        { plotId: plot.workspaceId },
      );
    }
  }

  private assertExternalPlot(plot: WorkspaceSnapshot): void {
    if (plot.isPrimary) {
      throw new AutomationError(
        "INVALID_ARGUMENT",
        "The primary checkout does not use external Plot recovery.",
        { plotId: plot.workspaceId },
      );
    }
  }

  private async waitWhileStopping(
    plotPath: string,
    id: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = (this.options.now ?? Date.now)() + 10_000;
    while (
      this.process(plotPath, id)?.status === "stopping" &&
      (this.options.now ?? Date.now)() < deadline
    ) {
      await this.pause(100, signal);
    }
  }

  private async waitUntilStopped(
    plotPath: string,
    id: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const deadline = (this.options.now ?? Date.now)() + 10_000;
    while ((this.options.now ?? Date.now)() < deadline) {
      const process = this.process(plotPath, id);
      if (
        !process ||
        process.status === "stopped" ||
        process.status === "failed"
      ) {
        return true;
      }
      await this.pause(100, signal);
    }
    return false;
  }

  private pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    const pause =
      this.options.wait ??
      ((duration: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, duration)));
    return abortiblePause(pause, milliseconds, signal);
  }

  private async withRuntimeLock<T>(
    plotPath: string,
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${normalize(plotPath)}::${id}`;
    const previous = this.runtimeLocks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.runtimeLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.runtimeLocks.get(key) === queued) this.runtimeLocks.delete(key);
    }
  }

  private async withRecoveryLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.recoveryLock;
    let release = () => {};
    this.recoveryLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function abortiblePause(
  pause: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new AutomationError("CANCELLED", "Operation was cancelled.");
  }
  let listener: (() => void) | undefined;
  try {
    await Promise.race([
      pause(milliseconds),
      new Promise<never>((_resolve, reject) => {
        listener = () =>
          reject(new AutomationError("CANCELLED", "Operation was cancelled."));
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

export function lifecycleState(
  runtimes: readonly AutomationRuntime[],
): PlotLifecycleState {
  if (
    runtimes.length === 0 ||
    runtimes.every((runtime) => runtime.status === "stopped")
  ) {
    return "stopped";
  }
  const running = runtimes.filter(
    (runtime) => runtime.status === "running",
  ).length;
  const starting = runtimes.filter(
    (runtime) => runtime.status === "starting",
  ).length;
  const failed = runtimes.filter(
    (runtime) => runtime.status === "failed",
  ).length;
  const stopping = runtimes.filter(
    (runtime) => runtime.status === "stopping",
  ).length;
  if (failed === runtimes.length) return "failed";
  if (starting === runtimes.length) return "starting";
  if (stopping === runtimes.length) return "stopping";
  if (running === runtimes.length) return "ready";
  if (running > 0 || starting > 0 || stopping > 0) return "partially-running";
  return failed > 0 ? "failed" : "stopped";
}

function selectRuntimeIds(
  commands: Readonly<Record<string, PlotCommand>>,
  requested: string | undefined,
): string[] {
  if (!requested) return Object.keys(commands);
  if (!commands[requested]) {
    throw new AutomationError(
      "RUNTIME_NOT_FOUND",
      `This Plot declares no runtime called ${requested}.`,
    );
  }
  return [requested];
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 4_000) {
    throw new AutomationError("INVALID_ARGUMENT", `${key} must be a string.`);
  }
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  if (params[key] === undefined) return undefined;
  return requiredString(params, key);
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = params[key];
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new AutomationError(
      "INVALID_ARGUMENT",
      `${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function optionalScope(params: Record<string, unknown>): "single" | "family" {
  const value = params["scope"];
  if (value === undefined) return "single";
  if (value !== "single" && value !== "family") {
    throw new AutomationError(
      "INVALID_ARGUMENT",
      "scope must be single or family.",
    );
  }
  return value;
}

function optionalRemedy(
  params: Record<string, unknown>,
): "convex-cli" | "convex-recreate" | undefined {
  const value = params["remedy"];
  if (value === undefined) return undefined;
  if (value !== "convex-cli" && value !== "convex-recreate") {
    throw new AutomationError(
      "INVALID_ARGUMENT",
      "remedy must be convex-cli or convex-recreate.",
    );
  }
  return value;
}

function assertOnly(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(params).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new AutomationError(
      "INVALID_ARGUMENT",
      `Unexpected argument ${unexpected}.`,
    );
  }
}
