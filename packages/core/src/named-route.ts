import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { resolvedCommandPath } from "./command-runner";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessListener {
  processId: number;
  port: number;
}

export interface RouteProbe {
  status: number;
  contentType?: string;
}

export interface PublishNamedRouteRequest {
  routeName: string;
  processId: number;
  expectedPort: number;
  /** Recent command output helps distinguish the app from monorepo sidecars. */
  output(): string;
  timeoutMs?: number;
  /** Who owns the route, so the gate can wake it from a URL visit. */
  plotPath?: string;
  commandId?: string;
}

export interface PublishedNamedRoute {
  port: number;
}

export interface NamedRoutePublisher {
  publish(request: PublishNamedRouteRequest): Promise<PublishedNamedRoute>;
  /**
   * Looks once for a listener worth preferring over the one already published.
   * A route that had to settle for an internal port keeps asking, because the
   * dev server people are meant to visit may only be binding now.
   */
  improve(
    request: PublishNamedRouteRequest,
  ): Promise<PublishedNamedRoute | undefined>;
  healthy(request: { routeName: string; port: number }): Promise<boolean>;
  remove(routeName: string): Promise<void>;
}

interface ListenerSelection {
  listener: ProcessListener;
  hostname: "127.0.0.1" | "::1";
  response: RouteProbe;
  /**
   * Whether this is the kind of listener a person is meant to visit. An
   * OS-assigned port belongs to an internal runtime — Cloudflare's workerd,
   * an inspector bridge — which can serve the app's HTML while the dev
   * server that owns the assets has yet to bind its own port.
   */
  settled: boolean;
}

/**
 * The gate daemon could not be told about the route. Distinct from "no web
 * server appeared", because the command itself is fine: an app update swaps
 * the daemon's file under a running Silvic, and launchd can stop it at any
 * time. Only the address is missing, so nothing should be killed over it.
 */
export class GateUnreachable extends Error {}

/** macOS hands these out to whoever asks; nobody configures one. */
const firstEphemeralPort = 49_152;

/** Whether a port was assigned by the OS rather than chosen by a dev server. */
export function internalPort(port: number): boolean {
  return port >= firstEphemeralPort;
}

/**
 * The gate's control socket, as the publisher needs it. `set` points a named
 * host at a live upstream; `suspend` drops the upstream while keeping the
 * route's identity so a later visit to the URL can wake the plot.
 */
export interface GateRouteLink {
  set(route: {
    name: string;
    host: "127.0.0.1" | "::1";
    port: number;
    plotPath?: string;
    commandId?: string;
  }): Promise<void>;
  suspend(name: string): Promise<void>;
}

interface RoutePublisherOptions {
  link: GateRouteLink;
  inspect?(rootProcessId: number): Promise<readonly ProcessListener[]>;
  probe?(url: string): Promise<RouteProbe | undefined>;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
  /** How long an internal listener is held back before it is settled for. */
  settleMs?: number;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Publishes the listener that actually came out of a supervised command.
 *
 * A monorepo's root `dev` script often ignores PORT and starts several
 * services. Publishing that script's port blindly would register a healthy
 * name against an empty or wrong listener. Silvic instead owns the two
 * lifecycles separately: it supervises the command tree, finds its responding
 * HTTP listener, and tells the gate daemon which concrete port serves it.
 */
export class GateRoutePublisher implements NamedRoutePublisher {
  private readonly link: GateRouteLink;
  private readonly inspect: NonNullable<RoutePublisherOptions["inspect"]>;
  private readonly probe: NonNullable<RoutePublisherOptions["probe"]>;
  private readonly wait: NonNullable<RoutePublisherOptions["wait"]>;
  private readonly now: NonNullable<RoutePublisherOptions["now"]>;
  private readonly settleMs: number;
  /** Which loopback family each route's upstream answered on. */
  private readonly families = new Map<string, "127.0.0.1" | "::1">();

  constructor(options: RoutePublisherOptions) {
    this.link = options.link;
    this.inspect = options.inspect ?? inspectProcessListeners;
    this.probe = options.probe ?? probeUrl;
    this.wait = options.wait ?? pause;
    this.now = options.now ?? Date.now;
    this.settleMs = options.settleMs ?? 10_000;
  }

  async publish(
    request: PublishNamedRouteRequest,
  ): Promise<PublishedNamedRoute> {
    // Generous by design: a first-ever dev server on a fresh machine spends
    // a long time compiling before it serves HTML, and the named URL shows
    // the gate's holding page in the meantime. Killing the process early
    // made slow starts look like brokenness.
    const deadline = this.now() + (request.timeoutMs ?? 120_000);
    let latest = `${request.routeName} has not served a page yet — nothing in this command's process tree answers with HTML. Silvic keeps looking; its output says what it is doing.`;

    /** When an internal listener first offered itself in place of a real one. */
    let settlingSince: number | undefined;
    /** Why the gate refused the route, while it keeps refusing it. */
    let unreachable: string | undefined;

    while (true) {
      const selected = await this.choose(request);
      if (selected && !selected.settled) {
        // Cloudflare's Vite plugin has workerd serving the app's SSR HTML a
        // second or two before Astro binds the port that serves the assets.
        // Publishing that first sighting pins the name to the sandbox: pages
        // render and every module, style and font 404s.
        settlingSince ??= this.now();
        const holdUntil = Math.min(settlingSince + this.settleMs, deadline);
        if (this.now() < holdUntil) {
          latest = `Only an internal listener on port ${selected.listener.port} answered for ${request.routeName}.`;
          await this.wait(Math.min(250, Math.max(0, holdUntil - this.now())));
          continue;
        }
      }
      if (selected) {
        const targetPort = selected.listener.port;
        try {
          await this.link.set({
            name: request.routeName,
            host: selected.hostname,
            port: targetPort,
            ...(request.plotPath ? { plotPath: request.plotPath } : {}),
            ...(request.commandId ? { commandId: request.commandId } : {}),
          });
        } catch (error) {
          // The daemon may be restarting: keep asking rather than giving the
          // dev server's listener up over a socket that is coming back.
          unreachable = `${request.routeName}.localhost has no address yet: ${describe(error)}`;
          if (this.now() >= deadline) throw new GateUnreachable(unreachable);
          await this.wait(Math.min(250, Math.max(0, deadline - this.now())));
          continue;
        }
        unreachable = undefined;
        this.families.set(request.routeName, selected.hostname);

        while (this.now() < deadline) {
          if (
            await this.healthy({
              routeName: request.routeName,
              port: targetPort,
            })
          ) {
            return { port: targetPort };
          }
          latest = `The Silvic gate registered ${request.routeName}.localhost, but it did not reach localhost:${targetPort}.`;
          await this.wait(Math.min(150, Math.max(0, deadline - this.now())));
        }
      }

      if (this.now() >= deadline) {
        if (unreachable) throw new GateUnreachable(unreachable);
        throw new Error(latest);
      }
      await this.wait(Math.min(250, Math.max(0, deadline - this.now())));
    }
  }

  async healthy({
    routeName,
    port,
  }: {
    routeName: string;
    port: number;
  }): Promise<boolean> {
    const family = this.families.get(routeName) ?? "127.0.0.1";
    const directHost = family === "::1" ? "[::1]" : family;
    const [direct, named] = await Promise.all([
      this.probe(`http://${directHost}:${port}/`),
      this.probe(`https://${routeName}.localhost/`),
    ]);
    if (!direct || !named) return false;
    if (!browserFacing(direct) || !browserFacing(named)) return false;
    // The gate preserves the upstream content type. A different type means
    // the name reached another listener even when both answered 200 —
    // commonly a monorepo health sidecar whose entire response is `OK`.
    if (mediaType(direct.contentType) !== mediaType(named.contentType)) {
      return false;
    }
    // The gate preserves the upstream status. Exact agreement lets a real
    // browser error overlay through while rejecting the gate's own 404/503.
    if (direct.status !== named.status) return false;
    return true;
  }

  /**
   * The dev server may still have been binding when the route had to settle
   * for an internal listener. Whoever visits meanwhile is stuck with an app
   * whose assets 404, so a settled-for route keeps looking for the real one
   * rather than staying wrong until the next restart.
   */
  async improve(
    request: PublishNamedRouteRequest,
  ): Promise<PublishedNamedRoute | undefined> {
    const selected = await this.choose(request);
    if (!selected?.settled) return undefined;
    try {
      await this.link.set({
        name: request.routeName,
        host: selected.hostname,
        port: selected.listener.port,
        ...(request.plotPath ? { plotPath: request.plotPath } : {}),
        ...(request.commandId ? { commandId: request.commandId } : {}),
      });
    } catch {
      // An improvement is an offer, never a demand: the next tick asks again.
      return undefined;
    }
    this.families.set(request.routeName, selected.hostname);
    return { port: selected.listener.port };
  }

  /** The best listener the command tree offers right now, if any. */
  private async choose(
    request: PublishNamedRouteRequest,
  ): Promise<ListenerSelection | undefined> {
    return selectListener({
      listeners: await this.inspect(request.processId),
      expectedPort: request.expectedPort,
      output: request.output(),
      probe: this.probe,
    });
  }

  /** Stopping suspends rather than deletes: the URL keeps waking the plot. */
  async remove(routeName: string): Promise<void> {
    this.families.delete(routeName);
    // A gate that cannot be told has nothing to suspend: it publishes no
    // route at all until it reads its store again.
    await this.link.suspend(routeName).catch(() => undefined);
  }
}

async function selectListener({
  listeners,
  expectedPort,
  output,
  probe,
}: {
  listeners: readonly ProcessListener[];
  expectedPort: number;
  output: string;
  probe(url: string): Promise<RouteProbe | undefined>;
}): Promise<ListenerSelection | undefined> {
  const announced = new Set(
    [
      ...output.matchAll(
        /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/gi,
      ),
    ]
      .map((match) => Number(match[1]))
      .filter((port) => port > 0 && port <= 65_535),
  );
  // A dev server may report that another instance already owns its port and
  // then exit. Keep explicit localhost URLs as fallback candidates, but mark
  // them as synthetic: a browser listener that actually belongs to the newly
  // supervised process tree is stronger evidence than retained console text.
  const listenersByPort = new Map(
    listeners.map((listener) => [listener.port, listener]),
  );
  for (const port of announced) {
    if (!listenersByPort.has(port)) {
      listenersByPort.set(port, { processId: 0, port });
    }
  }
  const candidates = await Promise.all(
    [...listenersByPort.values()].flatMap((listener) =>
      (["127.0.0.1", "::1"] as const).map(async (hostname) => ({
        listener,
        hostname,
        response: await probe(
          `http://${hostname === "::1" ? `[${hostname}]` : hostname}:${listener.port}/`,
        ),
        settled: !internalPort(listener.port),
      })),
    ),
  );

  return (
    candidates
      .filter(
        (candidate): candidate is ListenerSelection =>
          candidate.response !== undefined,
      )
      // A route marked as a web preview must actually render in a browser.
      // Health checks and API sidecars commonly answer 200 with `OK` or JSON;
      // publishing either would make a broken web runtime look successful.
      .filter((candidate) => browserFacing(candidate.response))
      .sort((left, right) => {
        const score = (candidate: ListenerSelection) =>
          // PORT is an offered address, not proof of identity. A monorepo can
          // hand it to a health/API sidecar while its browser app chooses another
          // listener, so browser-facing and announced listeners rank above it.
          (candidate.response.contentType?.toLowerCase().includes("text/html")
            ? 10_000
            : 0) +
          (candidate.listener.processId !== 0 ? 2_000 : 0) +
          (announced.has(candidate.listener.port) ? 1_000 : 0) +
          // Internal runtimes (Cloudflare's workerd, inspector bridges)
          // bind OS-assigned ephemeral ports and can still serve HTML; a
          // dev server people are meant to visit sits on a configured port.
          (candidate.settled ? 500 : 0) +
          (candidate.listener.port === expectedPort ? 100 : 0) +
          (candidate.response.status >= 200 && candidate.response.status < 400
            ? 10
            : 0) +
          // Avoid an unnecessary bridge when both loopback families serve the
          // same browser app.
          (candidate.hostname === "127.0.0.1" ? 1 : 0);
        return (
          score(right) - score(left) || left.listener.port - right.listener.port
        );
      })[0]
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserFacing(response: RouteProbe): boolean {
  const type = mediaType(response.contentType);
  return (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    (response.status >= 300 && response.status < 400)
  );
}

function mediaType(contentType: string | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/**
 * Which listeners belong to a supervised command. Ancestry is the first
 * answer, the process group the second: a command runs detached in its own
 * group, and when its shell dies the dev server it started keeps serving with
 * `launchd` as its parent. Asking only about ancestry made such a server
 * invisible, so Silvic reported that nothing was listening and started a
 * second one beside it.
 */
export function descendantListenerPorts({
  rootProcessId,
  processes,
  listeners,
  groups,
}: {
  rootProcessId: number;
  processes: readonly (readonly [number, number])[];
  listeners: readonly ProcessListener[];
  groups?: ReadonlyMap<number, number>;
}): readonly ProcessListener[] {
  const parents = new Map(processes);
  const belongsToTree = (processId: number) => {
    if (groups?.get(processId) === rootProcessId) return true;
    const seen = new Set<number>();
    let current: number | undefined = processId;
    while (current !== undefined && !seen.has(current)) {
      if (current === rootProcessId) return true;
      seen.add(current);
      current = parents.get(current);
    }
    return false;
  };
  return listeners.filter((listener) => belongsToTree(listener.processId));
}

async function inspectProcessListeners(
  rootProcessId: number,
): Promise<readonly ProcessListener[]> {
  const [processes, sockets] = await Promise.all([
    executeCommand("ps", ["-axo", "pid=,ppid=,pgid="]),
    executeCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]),
  ]);
  const rows = processes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (row): row is [number, number, number] =>
        row.length === 3 && row.every(Number.isSafeInteger),
    );
  const processPairs = rows.map(
    ([processId, parentId]) => [processId, parentId] as const,
  );
  const groups = new Map(
    rows.map(([processId, , groupId]) => [processId, groupId]),
  );
  const listeners: ProcessListener[] = [];
  let processId: number | undefined;
  for (const line of sockets.stdout.split(/\r?\n/)) {
    if (line.startsWith("p")) processId = Number(line.slice(1));
    else if (line.startsWith("n") && processId) {
      const port = Number(line.match(/:(\d+)(?:\s|$)/)?.[1]);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) {
        listeners.push({ processId, port });
      }
    }
  }
  return descendantListenerPorts({
    rootProcessId,
    processes: processPairs,
    groups,
    listeners: [
      ...new Map(
        listeners.map((listener) => [
          `${listener.processId}:${listener.port}`,
          listener,
        ]),
      ).values(),
    ],
  });
}

function probeUrl(url: string): Promise<RouteProbe | undefined> {
  const target = new URL(url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        protocol: target.protocol,
        hostname,
        ...(target.port ? { port: target.port } : {}),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { connection: "close", "accept-encoding": "identity" },
        ...(target.protocol === "https:" && hostname.endsWith(".localhost")
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        response.resume();
        const contentType = response.headers["content-type"];
        resolve({
          status: response.statusCode ?? 0,
          ...(typeof contentType === "string" ? { contentType } : {}),
        });
      },
    );
    request.setTimeout(2_000, () => request.destroy());
    request.once("error", () => resolve(undefined));
    request.end();
  });
}

function executeCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...arguments_],
      {
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 1_000_000,
        env: { ...process.env, PATH: resolvedCommandPath() },
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && "code" in error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}
