import { spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlotCommand } from "@silvic/contracts";

import { resolvedCommandPath } from "./command-runner";

export interface SupervisedCommand {
  /** The plot this runs in. */
  plotPath: string;
  /** The command's id in the recipe, `web` or `convex`. */
  id: string;
  status: "running" | "stopped" | "failed";
  processId?: number;
  /** Where it can be reached, when it was published under a name. */
  url?: string;
  startedAt?: string;
  exitCode?: number;
}

export interface StartRequest {
  plotPath: string;
  id: string;
  command: PlotCommand;
  /** `{command}-{plot}-{project}`, the name a routed command is published as. */
  routeName: string;
  environment: Record<string, string>;
  /** Whether portless is on PATH to publish it. */
  canRoute: boolean;
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

  constructor(
    private readonly options: {
      logDirectory: string;
      onChange: (commands: readonly SupervisedCommand[]) => void;
    },
  ) {}

  list(): readonly SupervisedCommand[] {
    return [...this.running.values()];
  }

  async start(request: StartRequest): Promise<void> {
    const key = keyFor(request.plotPath, request.id);
    if (this.running.get(key)?.status === "running") return;

    const routed = request.canRoute && routes(request.command);
    const log = await this.openLog(key);
    const child = spawn(
      routed ? "portless" : "sh",
      routed
        ? [request.routeName, "sh", "-lc", request.command.run]
        : ["-lc", request.command.run],
      {
        cwd: request.plotPath,
        env: {
          ...process.env,
          PATH: resolvedCommandPath(),
          ...request.environment,
        },
        // Its own group, so stopping reaches everything it started.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const entry: SupervisedCommand = {
      plotPath: request.plotPath,
      id: request.id,
      status: "running",
      startedAt: new Date().toISOString(),
      ...(child.pid === undefined ? {} : { processId: child.pid }),
      ...(routed ? { url: `https://${request.routeName}.localhost` } : {}),
    };
    this.running.set(key, entry);
    this.announce();

    child.stdout?.on("data", (chunk: Buffer) => log.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
    child.once("error", (error) => {
      log.write(`\n${error.message}\n`);
      this.settle(key, 1);
    });
    child.once("close", (exitCode) => this.settle(key, exitCode ?? 0));
    if (request.detached) child.unref();
  }

  /**
   * Ends the whole group. A dev server is usually a shell that forked a
   * bundler that forked a watcher; killing only what was spawned leaves the
   * rest holding the port.
   */
  stop(plotPath: string, id: string): void {
    const entry = this.running.get(keyFor(plotPath, id));
    if (!entry?.processId) return;
    try {
      process.kill(-entry.processId, "SIGTERM");
    } catch {
      // Already gone, which is the state being asked for.
    }
  }

  stopAll(): void {
    for (const entry of this.running.values()) {
      if (entry.status === "running") this.stop(entry.plotPath, entry.id);
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

  private settle(key: string, exitCode: number): void {
    const entry = this.running.get(key);
    if (!entry) return;
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

  private announce(): void {
    this.options.onChange(this.list());
  }

  private logPath(key: string): string {
    return join(this.options.logDirectory, `${key.replaceAll("/", "-")}.log`);
  }

  private async openLog(key: string): Promise<WriteStream> {
    await mkdir(this.options.logDirectory, { recursive: true });
    this.logs.get(key)?.end();
    const stream = createWriteStream(this.logPath(key), { flags: "w" });
    this.logs.set(key, stream);
    return stream;
  }
}

/**
 * A command is published under a name when it serves the plot's address and
 * has not said otherwise. Everything else runs where it is.
 */
export function routes(command: PlotCommand): boolean {
  return command.url === true && command.portless !== false;
}

/**
 * The shape `work` established and this machine already reads:
 * `{command}-{plot}-{project}.localhost`. One label, not a subdomain of a
 * subdomain, since a wildcard certificate covers only one level.
 */
export function routeNameFor(
  command: { id: string; routeName?: string | undefined },
  plot: string,
  project: string,
): string {
  return [command.routeName ?? command.id, plot, project]
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function keyFor(plotPath: string, id: string): string {
  return `${plotPath}::${id}`;
}
