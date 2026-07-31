import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { PlotCommand } from "@silvic/contracts";

import { resolvedCommandPath } from "./command-runner";
import { routes } from "./plot-address";

export interface SupervisedCommand {
  /** The plot this runs in. */
  plotPath: string;
  /** The command's id in the recipe, `web` or `convex`. */
  id: string;
  status: "running" | "stopped" | "failed";
  processId?: number;
  /** Where a serving command can be reached. */
  url?: string;
  startedAt?: string;
  exitCode?: number;
  /** Why this is not what was asked for, when Silvic had to settle. */
  advice?: string;
}

export interface StartRequest {
  plotPath: string;
  id: string;
  command: PlotCommand;
  /** `{command}-{plot}-{project}`, the name a routed command is published as. */
  routeName: string;
  environment: Record<string, string>;
  /** Whether portless is on PATH when the recipe opted into publishing. */
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
  private readonly stopping = new Set<string>();
  private readonly adopted = new Set<string>();

  constructor(
    private readonly options: {
      logDirectory: string;
      onChange: (commands: readonly SupervisedCommand[]) => void;
    },
  ) {}

  list(): readonly SupervisedCommand[] {
    return [...this.running.values()];
  }

  /**
   * Takes back the commands a previous window left running. Without this they
   * would hold their ports and their published names while Silvic offered to
   * start them again — the worst of both, since it neither owns them nor says
   * they exist.
   */
  adopt(entries: readonly SupervisedCommand[]): void {
    for (const entry of entries) {
      if (entry.status !== "running" || entry.processId === undefined) continue;
      if (!stillRunning(entry.processId, entry.startedAt)) continue;
      const key = keyFor(entry.plotPath, entry.id);
      this.running.set(key, entry);
      this.adopted.add(key);
    }
    if (this.running.size > 0) this.announce();
  }

  async start(request: StartRequest): Promise<void> {
    const key = keyFor(request.plotPath, request.id);
    if (this.running.get(key)?.status === "running") return;
    const named = routes(request.command);
    if (named && !request.canRoute) {
      this.refuse(request, proxyAdvice);
      return;
    }
    await this.spawn(request, named);
  }

  private async spawn(
    request: StartRequest,
    routed: boolean,
    advice?: string,
  ): Promise<void> {
    const key = keyFor(request.plotPath, request.id);
    this.adopted.delete(key);
    const log = await this.openLog(key, advice !== undefined);
    const startedAt = Date.now();
    let recent = "";
    const child = spawn(
      routed ? "portless" : "sh",
      routed
        ? [request.routeName, "sh", "-lc", request.command.run]
        : ["-lc", request.command.run],
      {
        cwd: commandWorkingDirectory(request.plotPath, request.command.cwd),
        env: {
          ...process.env,
          PATH: resolvedCommandPath(),
          ...request.environment,
          ...request.command.env,
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
      ...(routed
        ? { url: `https://${request.routeName}.localhost` }
        : request.command.url === true && request.environment["SILVIC_URL"]
          ? { url: request.environment["SILVIC_URL"] }
          : {}),
      ...(advice ? { advice } : {}),
    };
    this.running.set(key, entry);
    this.announce();

    const note = (chunk: Buffer) => {
      log.write(chunk);
      recent = `${recent}${chunk.toString("utf8")}`.slice(-2_000);
    };
    child.stdout?.on("data", note);
    child.stderr?.on("data", note);
    child.once("error", (error) => {
      log.write(`\n${error.message}\n`);
      this.settle(key, 1);
    });
    child.once("close", (exitCode) => {
      // A publisher that cannot reach its proxy quits at once and says so.
      // Running the command anyway, on the port the plot was given, is better
      // than a plot with nothing in it — as long as it says what it settled
      // for and what would fix it.
      if (routed && Date.now() - startedAt < 8_000 && needsProxy(recent)) {
        const entry = this.running.get(key);
        if (entry) {
          this.running.set(key, { ...entry, advice: proxyAdvice });
          this.announce();
        }
        this.settle(key, exitCode || 1);
        return;
      }
      this.settle(key, exitCode ?? 0);
    });
    if (request.detached) child.unref();
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
    if (!entry?.processId) return;
    this.stopping.add(key);
    try {
      process.kill(-entry.processId, "SIGTERM");
      if (this.adopted.has(key)) {
        this.observeAdoptedStop(key, entry.processId);
      }
    } catch {
      // Already gone, which is the state being asked for.
      this.settle(key, 0);
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
    const wasStopped = this.stopping.delete(key);
    if (exitCode === 0 || wasStopped) {
      this.running.delete(key);
      this.adopted.delete(key);
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

  private observeAdoptedStop(
    key: string,
    processId: number,
    attempt = 0,
  ): void {
    setTimeout(() => {
      const entry = this.running.get(key);
      if (!entry || entry.processId !== processId) return;
      if (!stillRunning(processId, entry.startedAt)) {
        this.settle(key, 0);
        return;
      }
      if (attempt >= 49) {
        try {
          process.kill(-processId, "SIGKILL");
        } catch {
          // It exited between the observation and the escalation.
        }
        this.settle(key, 0);
        return;
      }
      this.observeAdoptedStop(key, processId, attempt + 1);
    }, 100);
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
    this.logs.set(key, stream);
    return stream;
  }
}

export const proxyAdvice =
  "The named HTTPS URL needs portless and its proxy on port 443. Install portless, then run `portless service install` once and try again. Or disable Named HTTPS URL in the recipe to use the stable localhost port.";

/** portless says this, in these words, when it has no proxy to publish to. */
export function needsProxy(output: string): boolean {
  return /proxy is not running|port 443 requires elevated privileges|sudo: (?:a password|a terminal) is required/i.test(
    output,
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
function stillRunning(
  processId: number,
  startedAt: string | undefined,
): boolean {
  try {
    const elapsed = execFileSync(
      "ps",
      ["-p", String(processId), "-o", "etime="],
      { encoding: "utf8", timeout: 2_000 },
    ).trim();
    if (!elapsed) return false;
    if (!startedAt) return true;
    const began = Date.now() - elapsedSeconds(elapsed) * 1_000;
    return Math.abs(began - Date.parse(startedAt)) < 15_000;
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
