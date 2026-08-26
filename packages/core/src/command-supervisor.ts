import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { PlotCommand } from "@silvic/contracts";

import { resolvedCommandPath } from "./command-runner";
import {
  internalPort,
  type NamedRoutePublisher,
  type RouteDiagnosis,
} from "./named-route";
import { routes } from "./plot-address";

const executeFile = promisify(execFile);

export interface SupervisedCommand {
  /** The plot this runs in. */
  plotPath: string;
  /** The command's id in the recipe, `web` or `convex`. */
  id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  processId?: number;
  /** Where a serving command can be reached. */
  url?: string;
  /** The Portless name Silvic owns independently from the runtime process. */
  routeName?: string;
  /** The responding listener currently published under the named URL. */
  targetPort?: number;
  /** The responding listener is not part of a process group Silvic owns. */
  ownership?: "external";
  /** The stable plot port offered to commands that honour PORT. */
  expectedPort?: number;
  startedAt?: string;
  exitCode?: number;
  /** Why this is not what was asked for, when Silvic had to settle. */
  advice?: string;
  /** A short local lifecycle note, such as a completed automatic recovery. */
  notice?: string;
  /** Restarts already spent in the current recoverable failure episode. */
  recoveryAttempts?: number;
}

export interface StartRequest {
  plotPath: string;
  id: string;
  command: PlotCommand;
  /** `{command}-{plot}-{project}`, the name a routed command is published as. */
  routeName: string;
  environment: Record<string, string>;
  /** Whether the gate is ready when the recipe opted into publishing. */
  canRoute: boolean;
  /** Why it is not, in place of the generic advice. */
  routeAdvice?: string;
  /** Left running when Silvic quits, rather than ending with it. */
  detached: boolean;
}

/**
 * A plot's address is a promise: this is what keeps it. Silvic starts the
 * commands a recipe declares, publishes the ones that serve, and can stop what
 * it started — which is what turns an address from a number into somewhere to
 * go.
 *
 * Every command gets its own process group, so stopping one takes the shell
 * and everything it forked with it rather than orphaning a dev server.
 */
export class CommandSupervisor {
  private readonly running = new Map<string, SupervisedCommand>();
  private readonly logs = new Map<string, WriteStream>();
  private readonly stopping = new Set<string>();
  private readonly forcedFailures = new Map<string, string>();
  private readonly startRequests = new Map<string, StartRequest>();
  private readonly recoveries = new Map<
    string,
    { request: StartRequest; routed: boolean }
  >();
  private readonly routeHealthTimers = new Map<string, NodeJS.Timeout>();
  /** Nonzero exits waiting for their in-flight route discovery to settle. */
  private readonly pendingRouteExits = new Map<
    string,
    { exitCode: number; processId: number }
  >();
  private readonly routePublisher: NamedRoutePublisher;

  constructor(
    private readonly options: {
      logDirectory: string;
      onChange: (commands: readonly SupervisedCommand[]) => void;
      /** How many 100ms glances Stop allows before reaching for SIGKILL. */
      stopPatience?: number;
      routePublisher?: NamedRoutePublisher;
      routeHealthIntervalMs?: number;
    },
  ) {
    // Routing without a publisher is a wiring mistake, not a runtime state:
    // fail the route loudly instead of pretending portless-era defaults.
    this.routePublisher = options.routePublisher ?? {
      publish: () =>
        Promise.reject(
          new Error("No route publisher is wired to this supervisor."),
        ),
      improve: () => Promise.resolve(undefined),
      healthy: () => Promise.resolve(false),
      remove: () => Promise.resolve(),
    };
  }

  list(): readonly SupervisedCommand[] {
    return [...this.running.values()];
  }

  /** A failure observed on any path through the named HTTPS gate. */
  reportRouteFailure(
    routeName: string,
    failure: "vite-stale-optimized-dependency",
  ): void {
    if (failure !== "vite-stale-optimized-dependency") return;
    const found = [...this.running.entries()].find(
      ([, entry]) =>
        entry.routeName === routeName &&
        entry.status === "running" &&
        entry.processId !== undefined &&
        entry.targetPort !== undefined,
    );
    if (!found) return;
    const [key, entry] = found;
    this.recoverStaleViteRoute(key, entry.processId!, {
      ...entry,
      routeName,
      targetPort: entry.targetPort!,
    });
  }

  /**
   * Takes back the commands a previous window left running. Without this they
   * would hold their ports and their published names while Silvic offered to
   * start them again — the worst of both, since it neither owns them nor says
   * they exist.
   */
  async adopt(entries: readonly SupervisedCommand[]): Promise<void> {
    const live = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        running:
          (entry.status === "running" || entry.status === "starting") &&
          entry.processId !== undefined &&
          (await stillRunning(entry.processId, entry.startedAt)),
      })),
    );
    for (const { entry, running } of live) {
      if (
        (entry.status !== "running" && entry.status !== "starting") ||
        entry.processId === undefined
      ) {
        continue;
      }
      if (!running) continue;
      const key = keyFor(entry.plotPath, entry.id);
      this.running.set(key, entry);
      const expectedPort = entry.expectedPort ?? entry.targetPort;
      if (entry.routeName && expectedPort) {
        void this.reconcileAdoptedRoute(
          key,
          {
            ...entry,
            processId: entry.processId,
            routeName: entry.routeName,
          },
          expectedPort,
        );
      }
    }
    // This also clears stale persisted entries when none of their processes
    // survived. Silence here would leave the same ghosts to be adopted again.
    this.announce();
  }

  async start(request: StartRequest): Promise<void> {
    const key = keyFor(request.plotPath, request.id);
    this.startRequests.set(key, request);
    const status = this.running.get(key)?.status;
    // A stopping command's group is still dying and still holds its port;
    // starting into that would race the corpse for the address.
    if (
      status === "starting" ||
      status === "running" ||
      status === "stopping"
    ) {
      return;
    }
    const named = routes(request.command);
    if (named && !request.canRoute) {
      this.refuse(request, request.routeAdvice ?? proxyAdvice);
      return;
    }
    await this.spawn(request, named);
  }

  private async spawn(
    request: StartRequest,
    routed: boolean,
    state: {
      advice?: string;
      notice?: string;
      recoveryAttempts?: number;
      appendLog?: boolean;
    } = {},
  ): Promise<void> {
    const key = keyFor(request.plotPath, request.id);
    const log = await this.openLog(key, state.appendLog ?? false);
    let recent = "";
    const namedUrl = `https://${request.routeName}.localhost`;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: resolvedCommandPath(),
      ...request.environment,
      // PORTLESS_URL stays for recipes written against the portless era.
      ...(routed
        ? {
            HOST: "127.0.0.1",
            SILVIC_GATE_URL: namedUrl,
            PORTLESS_URL: namedUrl,
          }
        : {}),
      ...request.command.env,
    };
    const child = spawn("sh", ["-lc", request.command.run], {
      cwd: commandWorkingDirectory(request.plotPath, request.command.cwd),
      env: environment,
      // Its own group, so stopping reaches everything it started.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const expectedPort = Number(environment["PORT"]);

    const entry: SupervisedCommand = {
      plotPath: request.plotPath,
      id: request.id,
      status: routed ? "starting" : "running",
      startedAt: new Date().toISOString(),
      ...(child.pid === undefined ? {} : { processId: child.pid }),
      ...(routed
        ? {
            url: namedUrl,
            routeName: request.routeName,
            ...(Number.isSafeInteger(expectedPort) && expectedPort > 0
              ? { expectedPort }
              : {}),
          }
        : request.command.url === true && request.environment["SILVIC_URL"]
          ? { url: request.environment["SILVIC_URL"] }
          : {}),
      ...(state.advice ? { advice: state.advice } : {}),
      ...(state.notice ? { notice: state.notice } : {}),
      ...(state.recoveryAttempts
        ? { recoveryAttempts: state.recoveryAttempts }
        : {}),
    };
    this.running.set(key, entry);
    this.announce();

    const note = (chunk: Buffer) => {
      log.write(chunk);
      // Generous, because the dev server announces its URL once, early —
      // a monorepo's build chatter must not scroll that anchor away before
      // listener discovery reads it.
      recent = `${recent}${chunk.toString("utf8")}`.slice(-20_000);
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);
    child.once("error", (error) => {
      log.write(`\n${error.message}\n`);
      this.settle(key, 1, child.pid);
    });
    child.once("close", (exitCode) => {
      this.settle(key, exitCode ?? 0, child.pid);
    });
    if (routed && child.pid !== undefined) {
      if (!Number.isSafeInteger(expectedPort) || expectedPort <= 0) {
        this.failRoutedCommand(
          key,
          child.pid,
          "A named preview needs a valid PORT to begin listener discovery.",
        );
      } else {
        void this.bindRoute({
          key,
          processId: child.pid,
          routeName: request.routeName,
          expectedPort,
          output: () => recent,
        });
      }
    }
    if (request.detached) child.unref();
  }

  private async bindRoute({
    key,
    processId,
    routeName,
    expectedPort,
    output,
    timeoutMs,
  }: {
    key: string;
    processId: number;
    routeName: string;
    expectedPort: number;
    output(): string;
    timeoutMs?: number;
  }): Promise<void> {
    try {
      const owner = this.running.get(key);
      const published = await this.routePublisher.publish({
        routeName,
        processId,
        expectedPort,
        output,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(owner ? { plotPath: owner.plotPath, commandId: owner.id } : {}),
      });
      const entry = this.running.get(key);
      if (
        !entry ||
        entry.processId !== processId ||
        entry.status === "stopping" ||
        entry.status === "failed"
      ) {
        return;
      }
      if (
        published.ownership === "external" &&
        published.failure === "vite-stale-optimized-dependency"
      ) {
        this.pendingRouteExits.delete(key);
        const {
          processId: _ended,
          advice: _oldAdvice,
          exitCode: _oldExitCode,
          ...failed
        } = entry;
        this.running.set(key, {
          ...failed,
          status: "failed",
          targetPort: published.port,
          ownership: "external",
          advice: externalViteRecoveryAdvice,
        });
        this.logs.get(key)?.end();
        this.logs.delete(key);
        await this.routePublisher.remove(routeName);
        this.announce();
        return;
      }
      if (published.failure === "vite-stale-optimized-dependency") {
        const {
          advice: _oldAdvice,
          exitCode: _oldExitCode,
          ...healthy
        } = entry;
        const running: SupervisedCommand & {
          routeName: string;
          targetPort: number;
        } = {
          ...healthy,
          status: "running",
          routeName,
          targetPort: published.port,
        };
        this.running.set(key, running);
        this.recoverStaleViteRoute(key, processId, running);
        return;
      }
      const pendingExit = this.pendingRouteExits.get(key);
      this.pendingRouteExits.delete(key);
      const { advice: _recovered, exitCode: _exitCode, ...healthy } = entry;
      if (published.ownership === "external") {
        const { processId: _ended, ...external } = healthy;
        this.running.set(key, {
          ...external,
          status: "running",
          targetPort: published.port,
          ownership: "external",
          notice:
            "Attached to an externally managed server. Stop detaches its Silvic route without stopping the server.",
        });
      } else {
        this.running.set(key, {
          ...healthy,
          status: "running",
          targetPort: published.port,
        });
      }
      if (pendingExit) {
        this.logs.get(key)?.end();
        this.logs.delete(key);
      }
      this.announce();
      if (published.ownership !== "external") {
        this.scheduleRouteHealth(key, processId);
      }
    } catch (error) {
      const entry = this.running.get(key);
      if (!entry || entry.processId !== processId) return;
      const pendingExit = this.pendingRouteExits.get(key);
      if (pendingExit) {
        this.pendingRouteExits.delete(key);
        this.settle(key, pendingExit.exitCode, pendingExit.processId, false);
        return;
      }
      // Whether the gate would not answer or no page was served yet, the
      // command itself is alive and doing something. Killing it would throw
      // away the only thing that works — and a dev server that needs four
      // minutes to compile is a slow start, not a broken one. It keeps
      // running, says what is missing, and Silvic asks again.
      this.running.set(key, {
        ...entry,
        status: "running",
        advice: error instanceof Error ? error.message : String(error),
      });
      this.announce();
      this.retryRoute(key, processId, () =>
        this.bindRoute({
          key,
          processId,
          routeName,
          expectedPort,
          output,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }),
      );
    }
  }

  private async reconcileAdoptedRoute(
    key: string,
    entry: SupervisedCommand & {
      processId: number;
      routeName: string;
    },
    expectedPort: number,
  ): Promise<void> {
    const current = this.running.get(key);
    if (!current || current.processId !== entry.processId) return;
    this.running.set(key, {
      ...current,
      status: "starting",
      advice: "Silvic is rediscovering the preview after reopening.",
    });
    this.announce();
    const output = await this.output(entry.plotPath, entry.id);
    await this.bindRoute({
      key,
      processId: entry.processId,
      routeName: entry.routeName,
      expectedPort,
      output: () => output,
      timeoutMs: 15_000,
    });
  }

  /** The next attempt at an address, on the same timer Stop already clears. */
  private retryRoute(
    key: string,
    processId: number,
    act: () => Promise<void>,
  ): void {
    this.clearRouteHealth(key);
    const timer = setTimeout(() => {
      const entry = this.running.get(key);
      if (!entry || entry.processId !== processId) return;
      if (entry.status === "stopping" || entry.status === "failed") return;
      void act();
    }, this.options.routeHealthIntervalMs ?? 10_000);
    timer.unref();
    this.routeHealthTimers.set(key, timer);
  }

  private scheduleRouteHealth(key: string, processId: number): void {
    this.clearRouteHealth(key);
    const timer = setTimeout(() => {
      void this.inspectRouteHealth(key, processId);
    }, this.options.routeHealthIntervalMs ?? 10_000);
    timer.unref();
    this.routeHealthTimers.set(key, timer);
  }

  private async inspectRouteHealth(
    key: string,
    processId: number,
  ): Promise<void> {
    const entry = this.running.get(key);
    if (
      !entry ||
      entry.processId !== processId ||
      entry.status !== "running" ||
      !entry.routeName ||
      !entry.targetPort
    ) {
      return;
    }
    const diagnosis = await this.routeDiagnosis({
      routeName: entry.routeName,
      port: entry.targetPort,
    });
    if (diagnosis.status === "recoverable") {
      this.recoverStaleViteRoute(key, processId, {
        ...entry,
        routeName: entry.routeName,
        targetPort: entry.targetPort,
      });
      return;
    }
    if (diagnosis.status === "healthy") {
      if (
        entry.recoveryAttempts &&
        diagnosis.httpStatus !== undefined &&
        diagnosis.httpStatus >= 200 &&
        diagnosis.httpStatus < 400
      ) {
        const { recoveryAttempts: _spent, ...recovered } = entry;
        this.running.set(key, {
          ...recovered,
          notice:
            "Silvic recovered the preview by restarting it after a stale Vite dependency failure.",
        });
        this.logs.get(key)?.write("\n[Silvic] Preview recovery verified.\n");
        this.announce();
      }
      if (internalPort(entry.targetPort)) {
        await this.upgradeRoute(key, processId, {
          ...entry,
          routeName: entry.routeName,
          targetPort: entry.targetPort,
        });
      }
      this.scheduleRouteHealth(key, processId);
      return;
    }

    this.running.set(key, {
      ...entry,
      status: "starting",
      advice: "The preview stopped responding; Silvic is repairing its route.",
    });
    this.announce();
    const output = await this.output(entry.plotPath, entry.id);
    await this.bindRoute({
      key,
      processId,
      routeName: entry.routeName,
      expectedPort: entry.expectedPort ?? entry.targetPort,
      output: () => output,
      timeoutMs: 15_000,
    });
  }

  private async routeDiagnosis(request: {
    routeName: string;
    port: number;
  }): Promise<RouteDiagnosis> {
    if (this.routePublisher.diagnose) {
      return this.routePublisher.diagnose(request);
    }
    return (await this.routePublisher.healthy(request))
      ? { status: "healthy" }
      : { status: "unavailable" };
  }

  /** One cache rebuild and automatic restart, then a human decision. */
  private recoverStaleViteRoute(
    key: string,
    processId: number,
    entry: SupervisedCommand & { routeName: string; targetPort: number },
  ): void {
    const current = this.running.get(key);
    if (
      !current ||
      current.processId !== processId ||
      current.status !== "running"
    ) {
      return;
    }
    const live = { ...entry, ...current };
    if (live.recoveryAttempts) {
      this.logs
        .get(key)
        ?.write(
          "\n[Silvic] Vite recovery failed; automatic restarts stopped.\n",
        );
      this.failRoutedCommand(key, processId, viteRecoveryAdvice);
      return;
    }
    const request = this.startRequests.get(key);
    if (!request) {
      this.failRoutedCommand(key, processId, viteRecoveryAdvice);
      return;
    }

    this.clearRouteHealth(key);
    this.recoveries.set(key, { request, routed: routes(request.command) });
    this.running.set(key, {
      ...live,
      status: "starting",
      recoveryAttempts: 1,
      notice:
        "Silvic is rebuilding the Vite cache and restarting this preview.",
    });
    this.logs
      .get(key)
      ?.write(
        "\n[Silvic] Stale Vite dependency detected; rebuilding its cache and restarting once.\n",
      );
    this.announce();
    void this.routePublisher.remove(entry.routeName);
    try {
      process.kill(-processId, "SIGTERM");
      this.ensureStopped(key, processId);
    } catch {
      this.settle(key, 0, processId);
    }
  }

  /**
   * A route serving from an internal listener answers, so the health check is
   * content — but the page it serves is missing its assets. Keep looking for
   * the dev server itself, without ever failing a command that works.
   */
  private async upgradeRoute(
    key: string,
    processId: number,
    entry: SupervisedCommand & { routeName: string; targetPort: number },
  ): Promise<void> {
    const output = await this.output(entry.plotPath, entry.id);
    const improved = await this.routePublisher.improve({
      routeName: entry.routeName,
      processId,
      expectedPort: entry.expectedPort ?? entry.targetPort,
      output: () => output,
      plotPath: entry.plotPath,
      commandId: entry.id,
    });
    if (!improved) return;
    const current = this.running.get(key);
    if (!current || current.processId !== processId) return;
    this.running.set(key, { ...current, targetPort: improved.port });
    this.announce();
  }

  private failRoutedCommand(
    key: string,
    processId: number,
    advice: string,
  ): void {
    const entry = this.running.get(key);
    if (!entry || entry.processId !== processId) return;
    this.forcedFailures.set(key, advice);
    this.clearRouteHealth(key);
    this.running.set(key, { ...entry, status: "stopping", advice });
    this.announce();
    try {
      process.kill(-processId, "SIGTERM");
      this.ensureStopped(key, processId);
    } catch {
      this.settle(key, 1, processId);
    }
  }

  private clearRouteHealth(key: string): void {
    const timer = this.routeHealthTimers.get(key);
    if (timer) clearTimeout(timer);
    this.routeHealthTimers.delete(key);
  }

  private removeRoute(key: string, entry: SupervisedCommand): void {
    this.clearRouteHealth(key);
    if (entry.routeName) void this.routePublisher.remove(entry.routeName);
  }

  private refuse(request: StartRequest, advice: string): void {
    const key = keyFor(request.plotPath, request.id);
    this.running.set(key, {
      plotPath: request.plotPath,
      id: request.id,
      status: "failed",
      exitCode: 1,
      advice,
    });
    this.announce();
  }

  /**
   * Ends the whole group. A dev server is usually a shell that forked a
   * bundler that forked a watcher; killing only what was spawned leaves the
   * rest holding the port.
   */
  stop(plotPath: string, id: string): void {
    const key = keyFor(plotPath, id);
    const entry = this.running.get(key);
    if (!entry || entry.status === "stopping") return;
    if (entry.ownership === "external") {
      this.removeRoute(key, entry);
      this.running.delete(key);
      this.logs.get(key)?.end();
      this.logs.delete(key);
      this.announce();
      return;
    }
    if (!entry.processId) return;
    this.recoveries.delete(key);
    this.stopping.add(key);
    this.removeRoute(key, entry);
    try {
      process.kill(-entry.processId, "SIGTERM");
      // Dying can take seconds. Saying "stopping" out loud is what separates
      // a stop that is working from a stop that did nothing.
      this.running.set(key, { ...entry, status: "stopping" });
      this.announce();
      // The close event settles the usual case, but not every runtime obliges:
      // one that shrugs off SIGTERM, or a fork holding the pipes open, would
      // stay "stopping" forever with nothing left to press. Watch it out.
      this.ensureStopped(key, entry.processId);
    } catch {
      // Already gone, which is the state being asked for.
      this.settle(key, 0, entry.processId);
    }
  }

  stopAll(): void {
    for (const entry of this.running.values()) {
      if (entry.status === "starting" || entry.status === "running") {
        this.stop(entry.plotPath, entry.id);
      }
    }
  }

  /** The tail of what a command has printed, for showing rather than storing. */
  async output(plotPath: string, id: string, limit = 20_000): Promise<string> {
    try {
      const contents = await readFile(
        this.logPath(keyFor(plotPath, id)),
        "utf8",
      );
      return contents.slice(-limit);
    } catch {
      return "";
    }
  }

  private settle(
    key: string,
    exitCode: number,
    processId?: number,
    deferRoutedFailure = true,
  ): void {
    const entry = this.running.get(key);
    if (!entry) return;
    // Once an announced external listener is attached, the launcher exit is
    // only the end of discovery. It does not own the server or its route.
    if (entry.ownership === "external") {
      this.logs.get(key)?.end();
      this.logs.delete(key);
      return;
    }
    // A forced-stop watcher can settle the old process before its close event.
    // That late event must never settle the replacement using the same key.
    if (processId !== undefined && entry.processId !== processId) return;
    // Duplicate-server launchers commonly exit before the asynchronous HTTP
    // probe can confirm the URL they printed. Let that single in-flight
    // decision win or fail before changing the public runtime state.
    if (
      deferRoutedFailure &&
      exitCode !== 0 &&
      processId !== undefined &&
      entry.status === "starting" &&
      entry.routeName
    ) {
      this.pendingRouteExits.set(key, { exitCode, processId });
      return;
    }
    this.pendingRouteExits.delete(key);
    this.removeRoute(key, entry);
    const recovery = this.recoveries.get(key);
    if (recovery) {
      this.recoveries.delete(key);
      this.logs.get(key)?.end();
      this.logs.delete(key);
      void this.restartAfterViteRecovery(recovery);
      return;
    }
    const forcedFailure = this.forcedFailures.get(key);
    if (forcedFailure) {
      this.forcedFailures.delete(key);
      this.stopping.delete(key);
      const { processId: _ended, ...rest } = entry;
      this.running.set(key, {
        ...rest,
        status: "failed",
        exitCode: exitCode || 1,
        advice: forcedFailure,
      });
      this.logs.get(key)?.end();
      this.logs.delete(key);
      this.announce();
      return;
    }
    const wasStopped = this.stopping.delete(key);
    if (exitCode === 0 || wasStopped) {
      this.running.delete(key);
      this.logs.get(key)?.end();
      this.logs.delete(key);
      this.announce();
      return;
    }
    // The process id goes with the process: keeping it would offer something
    // to stop that is not there any more.
    const { processId: _ended, ...rest } = entry;
    this.running.set(key, {
      ...rest,
      status: exitCode === 0 ? "stopped" : "failed",
      exitCode,
    });
    this.logs.get(key)?.end();
    this.logs.delete(key);
    this.announce();
  }

  private async restartAfterViteRecovery(recovery: {
    request: StartRequest;
    routed: boolean;
  }): Promise<void> {
    try {
      await clearViteCaches(recovery.request);
      await this.spawn(recovery.request, recovery.routed, {
        notice:
          "Silvic rebuilt the Vite cache and restarted this preview after a stale dependency failure.",
        recoveryAttempts: 1,
        appendLog: true,
      });
    } catch (error) {
      this.refuse(
        recovery.request,
        `Silvic could not rebuild the Vite cache and restart the preview: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Stands over a stopped command until it is actually gone. SIGTERM is a
   * request; after a grace period the whole group gets SIGKILL, which is not.
   * When the command died but its close event never came — a survivor is
   * holding the pipes — the group is swept for that survivor too.
   */
  private ensureStopped(key: string, processId: number, attempt = 0): void {
    const delay = Math.min(250 * 2 ** attempt, 1_000);
    setTimeout(() => {
      void this.inspectStopped(key, processId, attempt);
    }, delay);
  }

  private async inspectStopped(
    key: string,
    processId: number,
    attempt: number,
  ): Promise<void> {
    const entry = this.running.get(key);
    if (!entry || entry.processId !== processId) return;
    const patience = this.options.stopPatience ?? 4;
    if (
      !(await stillRunning(processId, entry.startedAt)) ||
      attempt >= patience - 1
    ) {
      try {
        process.kill(-processId, "SIGKILL");
      } catch {
        // The group is empty, which is the state being asked for.
      }
      this.settle(key, 0, processId);
      return;
    }
    this.ensureStopped(key, processId, attempt + 1);
  }

  private announce(): void {
    this.options.onChange(this.list());
  }

  private logPath(key: string): string {
    return join(this.options.logDirectory, `${key.replaceAll("/", "-")}.log`);
  }

  private async openLog(key: string, append = false): Promise<WriteStream> {
    await mkdir(this.options.logDirectory, { recursive: true });
    this.logs.get(key)?.end();
    const stream = createWriteStream(this.logPath(key), {
      flags: append ? "a" : "w",
    });
    stream.on("error", () => {
      // A full or detached volume must not take the whole control plane down.
      if (this.logs.get(key) === stream) this.logs.delete(key);
    });
    try {
      await once(stream, "open");
    } catch (error) {
      stream.destroy();
      throw error;
    }
    this.logs.set(key, stream);
    return stream;
  }
}

export const proxyAdvice =
  "The named HTTPS URL needs Silvic's local gate. Approve the one-time HTTPS setup prompt when it appears, then press Start again. Or disable Named HTTPS URL in the recipe to use the stable localhost port.";

export const viteRecoveryAdvice =
  "The preview still has a stale Vite optimized dependency after Silvic rebuilt its generated Vite cache and restarted it once. Check the preview log, then press Start to try again.";

export const externalViteRecoveryAdvice =
  "The externally managed preview has a stale Vite cache. Stop that external server, then press Start so Silvic can rebuild the generated cache safely.";

/** Generated Vite caches from the command directory up to the plot root. */
async function clearViteCaches(request: StartRequest): Promise<void> {
  const root = resolve(request.plotPath);
  let directory = commandWorkingDirectory(
    request.plotPath,
    request.command.cwd,
  );
  const caches = new Set<string>();
  while (true) {
    caches.add(join(directory, "node_modules", ".vite"));
    caches.add(join(directory, "node_modules", ".cache", "vite"));
    if (directory === root) break;
    directory = dirname(directory);
  }
  await Promise.all(
    [...caches].map((cache) => rm(cache, { recursive: true, force: true })),
  );
}

function keyFor(plotPath: string, id: string): string {
  return `${plotPath}::${id}`;
}

function commandWorkingDirectory(
  plotPath: string,
  configured: string | undefined,
): string {
  const root = resolve(plotPath);
  const target = resolve(root, configured ?? ".");
  const relation = relative(root, target);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("A command's working directory must stay inside its plot");
  }
  return target;
}

/**
 * Whether that process id is still the process it was. Process ids are reused,
 * so finding one alive proves nothing on its own — and stopping the wrong one
 * would end whatever inherited the number.
 *
 * The proof is when it began. A command line cannot serve: `sh -lc "npm run
 * dev"` replaces itself with what it was told to run, so what stands under the
 * id afterwards bears no resemblance to what was started.
 */
async function stillRunning(
  processId: number,
  startedAt: string | undefined,
): Promise<boolean> {
  try {
    const { stdout } = await executeFile(
      "ps",
      ["-p", String(processId), "-o", "etime="],
      { encoding: "utf8", timeout: 2_000 },
    );
    const elapsed = stdout.trim();
    if (elapsed) {
      if (!startedAt) return true;
      const began = Date.now() - elapsedSeconds(elapsed) * 1_000;
      if (Math.abs(began - Date.parse(startedAt)) < 15_000) return true;
    }
  } catch {
    // Fall through: the leader is gone, which says nothing about the group.
  }
  return groupAlive(processId);
}

/**
 * A command is started detached, so its shell leads its own process group.
 * The shell can die while the dev server it started keeps serving — orphaned
 * to launchd, invisible to a check that only asks after the leader. Reviving
 * the command then starts a second server beside the working one, and both
 * fight over the port.
 */
async function groupAlive(processGroupId: number): Promise<boolean> {
  try {
    const { stdout } = await executeFile("ps", ["-axo", "pgid="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    return stdout
      .split(/\r?\n/)
      .some((line) => Number(line.trim()) === processGroupId);
  } catch {
    return false;
  }
}

/** `ps` elapsed time: `ss`, `mm:ss`, `hh:mm:ss` or `dd-hh:mm:ss`. */
function elapsedSeconds(elapsed: string): number {
  const [days, clock] = elapsed.includes("-")
    ? elapsed.split("-")
    : ["0", elapsed];
  const parts = (clock ?? "0").split(":").map(Number).reverse();
  const [seconds = 0, minutes = 0, hours = 0] = parts;
  return Number(days) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}
