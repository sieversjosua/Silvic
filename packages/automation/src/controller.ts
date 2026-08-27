import { normalize } from "node:path";

import type {
  PlotCommand,
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";
import type { SupervisedCommand } from "@silvic/core";

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
  state: PlotLifecycleState;
  previewUrl?: string;
  runtimes: readonly AutomationRuntime[];
  diagnostics: readonly string[];
}

export interface AutomationProject {
  id: string;
  name: string;
  rootPath: string;
  plots: readonly AutomationPlot[];
}

interface PlotDefinition {
  commands: Readonly<Record<string, PlotCommand>>;
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
    return {
      id: plot.workspaceId,
      projectId: project.id,
      name: plot.name,
      path: plot.path,
      branch: plot.git.branch,
      isPrimary: plot.isPrimary,
      state: lifecycleState(runtimes),
      ...(definition.previewUrl ? { previewUrl: definition.previewUrl } : {}),
      runtimes,
      diagnostics: runtimes.flatMap((runtime) =>
        runtime.advice
          ? [`${runtime.id}: ${runtime.advice}`]
          : runtime.status === "failed"
            ? [`${runtime.id}: exited with code ${runtime.exitCode ?? 1}`]
            : [],
      ),
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
          ? "Retry adoption in Silvic"
          : adoptionStatus === "adopting"
            ? "Wait for adoption to finish in Silvic"
            : "Adopt this Plot in Silvic";
      throw new AutomationError(
        "ADOPTION_REQUIRED",
        `${remedy} before starting runtimes. Adoption keeps provider provisioning explicit and isolated.`,
        { plotId: plot.workspaceId, adoptionStatus },
      );
    }

    if (
      definition.requiresProvisioning &&
      plot.provisioning?.status !== "complete"
    ) {
      const provisioningStatus = plot.provisioning?.status ?? "not-run";
      throw new AutomationError(
        "PROVISIONING_REQUIRED",
        `${provisioningStatus === "failed" ? "Retry" : "Run"} provisioning in Silvic before starting runtimes for this Plot.`,
        { plotId: plot.workspaceId, provisioningStatus },
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
