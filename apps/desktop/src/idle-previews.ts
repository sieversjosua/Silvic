import { normalize, relative } from "node:path";

import type { CommandRunner, SupervisedCommand } from "@silvic/core";
import type { GateRoute } from "@silvic/gate";

interface IdlePreviewOptions {
  minutes(): number;
  commands(): readonly SupervisedCommand[];
  routes(): Promise<readonly GateRoute[] | undefined>;
  protectedPaths(): Promise<ReadonlySet<string>>;
  runner: CommandRunner;
  stop(command: SupervisedCommand): void;
}

/** Auto-stop only owned, routed previews; their suspended URLs can wake them. */
export class IdlePreviews {
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private checking = false;
  private readonly openedAt = Date.now();
  private readonly lastBusyAt = new Map<string, number>();

  constructor(private readonly options: IdlePreviewOptions) {}

  synchronize(): void {
    if (this.closed) return;
    const commands = this.previews();
    const live = new Set(commands.map((command) => this.key(command)));
    for (const key of this.lastBusyAt.keys()) {
      if (!live.has(key)) this.lastBusyAt.delete(key);
    }
    if (this.options.minutes() === 0 || commands.length === 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    if (this.timer || this.checking) return;
    // Usage lives in the gate, including while the desktop window is hidden.
    // No timer or process scans remain once the last preview stops.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.checking = true;
      void this.check()
        .catch((error: unknown) =>
          console.error("Silvic could not check idle previews", error),
        )
        .finally(() => {
          this.checking = false;
          this.synchronize();
        });
    }, 60_000);
    this.timer.unref();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private previews(): readonly SupervisedCommand[] {
    return this.options
      .commands()
      .filter(
        (command) =>
          command.status === "running" &&
          command.ownership !== "external" &&
          command.processId !== undefined &&
          command.routeName !== undefined &&
          command.targetPort !== undefined,
      );
  }

  private key(command: SupervisedCommand): string {
    return `${normalize(command.plotPath)}::${command.id}::${command.processId}`;
  }

  private idle(command: SupervisedCommand, route: GateRoute): boolean {
    if (
      route.port !== command.targetPort ||
      route.lastActivityAt === undefined ||
      route.activeConnections !== 0
    ) {
      return false;
    }
    const since = Math.max(
      this.openedAt,
      Date.parse(command.startedAt ?? "") || this.openedAt,
      route.lastActivityAt,
      this.lastBusyAt.get(this.key(command)) ?? 0,
    );
    return Date.now() - since >= this.options.minutes() * 60_000;
  }

  private async check(): Promise<void> {
    if (this.options.minutes() === 0 || this.closed) return;
    const routes = await this.options.routes();
    // An unavailable or older gate cannot establish that a preview is unused.
    if (!routes) return;
    const candidates = this.previews().filter((command) => {
      const route = routes.find((entry) => entry.name === command.routeName);
      // Observe local work throughout the idle period, including jobs that
      // finish before the browser's initial timeout expires.
      return (
        route !== undefined &&
        route.port === command.targetPort &&
        route.lastActivityAt !== undefined &&
        route.activeConnections === 0
      );
    });
    if (candidates.length === 0) return;
    const protectedPaths = await this.options.protectedPaths();
    const jobs = await this.activeJobPaths(candidates);
    // A browser request may have arrived while the session/job scan ran.
    const currentRoutes = await this.options.routes();
    if (!currentRoutes || this.closed || this.options.minutes() === 0) return;
    for (const command of candidates) {
      const path = normalize(command.plotPath);
      if (protectedPaths.has(path) || jobs.has(path)) {
        this.lastBusyAt.set(this.key(command), Date.now());
        continue;
      }
      const current = this.previews().find(
        (entry) => this.key(entry) === this.key(command),
      );
      const route = currentRoutes.find(
        (entry) => entry.name === command.routeName,
      );
      if (current && route && this.idle(current, route)) {
        this.options.stop(current);
      }
    }
  }

  private async activeJobPaths(
    candidates: readonly SupervisedCommand[],
  ): Promise<ReadonlySet<string>> {
    const paths = new Set(candidates.map((entry) => normalize(entry.plotPath)));
    const processes = await this.options.runner.run({
      executable: "ps",
      arguments: ["-axo", "pid=,command="],
    });
    if (processes.exitCode !== 0) return paths;
    const jobs = processes.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match?.[1] || !match[2]) return [];
      // These jobs can spend minutes building before they visit the preview.
      const isJob =
        /(?:^|[ /])(?:vitest|playwright|jest|tsc)(?:\.[cm]?js)?(?:\s|$)/.test(
          match[2],
        ) ||
        /\b(?:astro|next)\s+build\b/.test(match[2]) ||
        /(?:playwright|@playwright\/test)\/cli\.[cm]?js(?:\s|$)/.test(
          match[2],
        ) ||
        /\b(?:bun|pnpm(?:\.[cm]?js)?|npm(?:-cli\.js)?|yarn(?:\.js)?)\s+(?:run\s+)?(?:ci(?:[-:]\S*)?|test(?:[-:]\S*)?|build|check|typecheck)\b/.test(
          match[2],
        );
      return isJob ? [match[1]] : [];
    });
    if (jobs.length === 0) return new Set();
    const directories = await this.options.runner.run({
      executable: "lsof",
      arguments: ["-a", "-p", jobs.join(","), "-d", "cwd", "-Fn"],
    });
    if (directories.exitCode !== 0) return paths;
    const workingDirectories = directories.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("n/"))
      .map((line) => normalize(line.slice(1)));
    return new Set(
      [...paths].filter((path) =>
        workingDirectories.some((cwd) => {
          const child = relative(path, cwd);
          return (
            child === "" || (!child.startsWith("..") && !child.startsWith("/"))
          );
        }),
      ),
    );
  }
}
