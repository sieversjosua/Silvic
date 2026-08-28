import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { resolvedCommandPath } from "./command-runner";
import {
  astroDuplicateServerEvidence,
  identifyExternalServer,
  type ExternalServerEvidence,
  type ExternalServerIdentity,
  type LoopbackFamily,
} from "./external-runtime";

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
  /** A narrowly recognised failure found in a bounded 5xx response prefix. */
  failure?: "vite-stale-optimized-dependency";
}

export type RouteDiagnosis =
  | { status: "healthy"; httpStatus?: number }
  | { status: "unavailable" }
  | { status: "recoverable"; failure: "vite-stale-optimized-dependency" };

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
  /**
   * Whether the launched command has already exited without serving. While it
   * is alive, discovery keeps waiting for it; once it is gone, a duplicate
   * server whose identity cannot be proven is a final answer, not a phase.
   */
  abandoned?(): boolean;
}

export interface PublishedNamedRoute {
  port: number;
  /** The listener came from an announced URL outside the launched process tree. */
  ownership?: "external";
  /** The verified process serving an externally managed route. */
  externalProcessId?: number;
  /**
   * What the attach-time probe answered on an external route; 0 when the
   * listener accepted the connection but never answered HTTP. Attachment and
   * application readiness are separate facts: a verified runtime is routed
   * even while its application currently fails.
   */
  httpStatus?: number;
  /** The listener answered, but only with a failure Silvic can identify. */
  failure?: "vite-stale-optimized-dependency";
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
  /** Revalidates that a persisted listener still belongs to this process tree. */
  verify?(request: { processId: number; port: number }): Promise<boolean>;
  /**
   * Distinguishes a routed application error Silvic knows how to repair from
   * an unavailable route. Optional so non-HTTP publishers can remain simple.
   */
  diagnose?(request: {
    routeName: string;
    port: number;
  }): Promise<RouteDiagnosis>;
  remove(routeName: string): Promise<void>;
}

interface ListenerSelection {
  listener: ProcessListener;
  hostname: LoopbackFamily;
  /** Absent only on a verified external listener that ignored the probe. */
  response: RouteProbe | undefined;
  /**
   * Whether this is the kind of listener a person is meant to visit. An
   * OS-assigned port belongs to an internal runtime — Cloudflare's workerd,
   * an inspector bridge — which can serve the app's HTML while the dev
   * server that owns the assets has yet to bind its own port.
   */
  settled: boolean;
  /** Set when the listener is a verified externally managed server. */
  external?: { processId: number };
}

/**
 * The gate daemon could not be told about the route. Distinct from "no web
 * server appeared", because the command itself is fine: an app update swaps
 * the daemon's file under a running Silvic, and launchd can stop it at any
 * time. Only the address is missing, so nothing should be killed over it.
 */
export class GateUnreachable extends Error {}

/**
 * A launcher reported an already-running server, and its identity could not
 * be verified for this plot: the process is gone, holds a different port, or
 * runs another worktree's code. Routing it anyway would publish the wrong
 * application under the plot's canonical URL, so this failure carries the
 * explicit remedies instead. Replacement stays a human decision.
 */
export class ExternalRuntimeConflict extends Error {}

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
  /** Reads the daemon's route table without touching the upstream server. */
  inspect?(
    name: string,
  ): Promise<{ host: "127.0.0.1" | "::1"; port: number } | undefined>;
}

interface RoutePublisherOptions {
  link: GateRouteLink;
  inspect?(rootProcessId: number): Promise<readonly ProcessListener[]>;
  probe?(url: string): Promise<RouteProbe | undefined>;
  /** Proves whether a reported duplicate server belongs to the plot. */
  identify?(
    evidence: ExternalServerEvidence,
    plotPath: string,
  ): Promise<ExternalServerIdentity>;
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
  private readonly identify: NonNullable<RoutePublisherOptions["identify"]>;
  private readonly wait: NonNullable<RoutePublisherOptions["wait"]>;
  private readonly now: NonNullable<RoutePublisherOptions["now"]>;
  private readonly settleMs: number;
  /** Which loopback family each route's upstream answered on. */
  private readonly families = new Map<string, "127.0.0.1" | "::1">();

  constructor(options: RoutePublisherOptions) {
    this.link = options.link;
    this.inspect = options.inspect ?? inspectProcessListeners;
    this.probe = options.probe ?? probeUrl;
    this.identify = options.identify ?? identifyExternalServer;
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
      const { selection: selected, conflict } = await this.choose(request);
      if (conflict && !selected) {
        latest = conflict;
        // While the launched command is alive it may still bind a listener of
        // its own; once it has exited, an unverifiable duplicate server is a
        // final answer, and waiting out the deadline would only delay it.
        if (request.abandoned?.()) throw new ExternalRuntimeConflict(conflict);
      }
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

        if (selected.external) {
          // Identity, not content, authorised this attachment: the verified
          // runtime keeps its route even while the application answers
          // 4xx/5xx or nothing at all. Whether the page is healthy is
          // reported alongside the attachment, never in place of it.
          return {
            port: targetPort,
            ownership: "external" as const,
            externalProcessId: selected.external.processId,
            httpStatus: selected.response?.status ?? 0,
            ...(selected.response?.failure
              ? { failure: selected.response.failure }
              : {}),
          };
        }

        while (this.now() < deadline) {
          if (
            await this.healthy({
              routeName: request.routeName,
              port: targetPort,
            })
          ) {
            return {
              port: targetPort,
              ...(selected.response?.failure
                ? { failure: selected.response.failure }
                : {}),
            };
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
    return (await this.diagnose({ routeName, port })).status !== "unavailable";
  }

  async verify({
    processId,
    port,
  }: {
    processId: number;
    port: number;
  }): Promise<boolean> {
    return (await this.inspect(processId)).some(
      (listener) => listener.port === port,
    );
  }

  async diagnose({
    routeName,
    port,
  }: {
    routeName: string;
    port: number;
  }): Promise<RouteDiagnosis> {
    if (this.link.inspect) {
      const route = await this.link.inspect(routeName);
      if (!route || route.port !== port) return { status: "unavailable" };
      this.families.set(routeName, route.host);
      return { status: "healthy" };
    }

    const family = this.families.get(routeName) ?? "127.0.0.1";
    const directHost = family === "::1" ? "[::1]" : family;
    // These URLs terminate at the same application. Probing them together
    // makes an SSR dev server render its root twice at once, which is
    // needlessly invasive for a health check and can wedge a warm renderer.
    const direct = await this.probe(`http://${directHost}:${port}/`);
    if (!direct) return { status: "unavailable" };
    const named = await this.probe(`https://${routeName}.localhost/`);
    if (!named) return { status: "unavailable" };
    // The gate replaces this known broken upstream with its recovery page, so
    // its status and media type intentionally differ from the direct response.
    // The direct listener was selected and registered immediately above; its
    // narrow failure signature is enough to begin recovery.
    if (direct.failure === "vite-stale-optimized-dependency") {
      return { status: "recoverable", failure: direct.failure };
    }
    if (!browserFacing(direct) || !browserFacing(named)) {
      return { status: "unavailable" };
    }
    // The gate preserves the upstream content type. A different type means
    // the name reached another listener even when both answered 200 —
    // commonly a monorepo health sidecar whose entire response is `OK`.
    if (mediaType(direct.contentType) !== mediaType(named.contentType)) {
      return { status: "unavailable" };
    }
    // The gate preserves the upstream status. Exact agreement lets a real
    // browser error overlay through while rejecting the gate's own 404/503.
    if (direct.status !== named.status) return { status: "unavailable" };
    return { status: "healthy", httpStatus: direct.status };
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
    const { selection: selected } = await this.choose(request);
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
    return {
      port: selected.listener.port,
      ...(selected.external
        ? {
            ownership: "external" as const,
            externalProcessId: selected.external.processId,
          }
        : {}),
    };
  }

  /**
   * The best listener the command tree offers right now, if any — plus the
   * reason no external one was eligible, when a launcher reported a duplicate
   * server whose identity could not be verified for this plot.
   */
  private async choose(request: PublishNamedRouteRequest): Promise<{
    selection?: ListenerSelection;
    conflict?: string;
  }> {
    const output = request.output();
    const listeners = await this.inspect(request.processId);
    const evidence = astroDuplicateServerEvidence(output);
    let external: ExternalListenerCandidate | undefined;
    let conflict: string | undefined;
    // A reported port the supervised tree itself holds needs no external
    // evidence: the tree listener is the stronger identity and attaches as
    // Silvic's own.
    if (
      evidence &&
      !listeners.some((listener) => listener.port === evidence.port)
    ) {
      if (request.plotPath) {
        const identity = await this.identify(evidence, request.plotPath);
        if (identity.verdict === "verified") {
          external = { ...evidence, families: identity.families };
        } else {
          conflict = conflictAdvice(evidence, identity, request.routeName);
        }
      } else {
        conflict = conflictAdvice(
          evidence,
          {
            verdict: "foreign",
            detail: "Silvic has no plot to verify it against",
          },
          request.routeName,
        );
      }
    }
    const selection = await selectListener({
      listeners,
      expectedPort: request.expectedPort,
      output,
      probe: this.probe,
      ...(external ? { external } : {}),
    });
    return {
      ...(selection ? { selection } : {}),
      ...(conflict ? { conflict } : {}),
    };
  }

  /** Stopping suspends rather than deletes: the URL keeps waking the plot. */
  async remove(routeName: string): Promise<void> {
    this.families.delete(routeName);
    // A gate that cannot be told has nothing to suspend: it publishes no
    // route at all until it reads its store again.
    await this.link.suspend(routeName).catch(() => undefined);
  }
}

interface ExternalListenerCandidate extends ExternalServerEvidence {
  /** Loopback families the verified process actually listens on. */
  families: readonly LoopbackFamily[];
}

async function selectListener({
  listeners,
  expectedPort,
  output,
  probe,
  external,
}: {
  listeners: readonly ProcessListener[];
  expectedPort: number;
  output: string;
  probe(url: string): Promise<RouteProbe | undefined>;
  /** An already-identity-verified duplicate server, when a launcher named one. */
  external?: ExternalListenerCandidate;
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
  // Retained console text stays a ranking signal for the tree's own
  // listeners — never a listener by itself. A bare URL in a log tail can
  // point at a port that another worktree's server has since taken; only a
  // launcher's verified duplicate-server evidence may add a candidate from
  // outside the supervised process tree.
  const listenersByPort = new Map(
    listeners.map((listener) => [listener.port, listener]),
  );
  const candidates: ListenerSelection[] = [];
  for (const listener of listenersByPort.values()) {
    for (const hostname of ["127.0.0.1", "::1"] as const) {
      candidates.push({
        listener,
        hostname,
        response: await probe(
          `http://${hostname === "::1" ? `[${hostname}]` : hostname}:${listener.port}/`,
        ),
        settled: !internalPort(listener.port),
      });
    }
  }
  if (external) {
    const families: readonly LoopbackFamily[] = external.families.length
      ? external.families
      : ["127.0.0.1"];
    let answered = false;
    for (const hostname of families) {
      const response = await probe(
        `http://${hostname === "::1" ? `[${hostname}]` : hostname}:${external.port}/`,
      );
      if (!response) continue;
      candidates.push({
        listener: { processId: external.processId, port: external.port },
        hostname,
        response,
        settled: !internalPort(external.port),
        external: { processId: external.processId },
      });
      answered = true;
      break;
    }
    if (!answered) {
      // Identity was proven even though HTTP never answered; the attachment
      // stands so the route shows the real server's state, not a fresh race.
      candidates.push({
        listener: { processId: external.processId, port: external.port },
        hostname: families[0] ?? "127.0.0.1",
        response: undefined,
        settled: !internalPort(external.port),
        external: { processId: external.processId },
      });
    }
  }

  return (
    candidates
      // A route marked as a web preview must actually render in a browser.
      // Health checks and API sidecars commonly answer 200 with `OK` or JSON;
      // publishing either would make a broken web runtime look successful.
      // A verified external server is exempt: its identity is the proof, and
      // its current answer — even a 500 without a Content-Type — is exactly
      // what the route must show.
      .filter(
        (candidate) =>
          candidate.external !== undefined ||
          (candidate.response !== undefined &&
            browserFacing(candidate.response)),
      )
      .sort((left, right) => {
        const score = (candidate: ListenerSelection) =>
          // PORT is an offered address, not proof of identity. A monorepo can
          // hand it to a health/API sidecar while its browser app chooses another
          // listener, so browser-facing and announced listeners rank above it.
          (candidate.response?.contentType?.toLowerCase().includes("text/html")
            ? 10_000
            : 0) +
          // The tree's own listener outranks even a verified external one:
          // when the supervised command did manage to serve, that is the
          // runtime that was asked for.
          (candidate.external === undefined ? 2_000 : 0) +
          (announced.has(candidate.listener.port) ? 1_000 : 0) +
          // Internal runtimes (Cloudflare's workerd, inspector bridges)
          // bind OS-assigned ephemeral ports and can still serve HTML; a
          // dev server people are meant to visit sits on a configured port.
          (candidate.settled ? 500 : 0) +
          (candidate.listener.port === expectedPort ? 100 : 0) +
          (candidate.response !== undefined &&
          candidate.response.status >= 200 &&
          candidate.response.status < 400
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

/**
 * The explicit remedies the issue demands when identity cannot be proven.
 * Silvic never kills or replaces a process it has not verified as this
 * plot's own; both remain deliberate human actions.
 */
function conflictAdvice(
  evidence: ExternalServerEvidence,
  identity: { verdict: "gone" | "foreign"; detail: string },
  routeName: string,
): string {
  const reported = `The launcher reported an already-running dev server at http://${evidence.hostname}:${evidence.port} (PID ${evidence.processId})`;
  if (identity.verdict === "gone") {
    return `${reported}, but ${identity.detail}. That report is stale; press Start to launch a fresh preview.`;
  }
  return `${reported}, but ${identity.detail}, so Silvic refused to give it ${routeName}.localhost. Open http://${evidence.hostname}:${evidence.port} to see what it serves, stop that process if it is yours, or run \`astro dev --force\` in this plot to replace it — then press Start.`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function browserFacing(response: RouteProbe): boolean {
  const type = mediaType(response.contentType);
  return (
    response.failure === "vite-stale-optimized-dependency" ||
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

const responsePrefixLimit = 16 * 1_024;

/** @internal Exported so the real HTTP probe remains regression-testable. */
export async function probeUrl(url: string): Promise<RouteProbe | undefined> {
  const headers = await requestProbe(url, "HEAD", false);
  if (!headers) return undefined;
  if (headers.status < 500 || headers.status >= 600) return headers;

  // A successful health check only needs status and media type. Fetch a body
  // solely for the narrow infrastructure failure whose signature lives in
  // the response text; normal probes must not render an SSR page just to see
  // whether its listener and gate route are alive.
  return (await requestProbe(url, "GET", true)) ?? headers;
}

function requestProbe(
  url: string,
  method: "HEAD" | "GET",
  inspectFailureBody: boolean,
): Promise<RouteProbe | undefined> {
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
        method,
        headers: { connection: "close", "accept-encoding": "identity" },
        ...(target.protocol === "https:" && hostname.endsWith(".localhost")
          ? { rejectUnauthorized: false }
          : {}),
      },
      (response) => {
        const contentType = response.headers["content-type"];
        const result: RouteProbe = {
          status: response.statusCode ?? 0,
          ...(typeof contentType === "string" ? { contentType } : {}),
        };
        if (!inspectFailureBody) {
          response.resume();
          response.once("end", () => resolve(result));
          response.once("error", () => resolve(undefined));
          return;
        }

        const chunks: Buffer[] = [];
        let length = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const prefix = Buffer.concat(chunks, length).toString("utf8");
          resolve({
            ...result,
            ...(viteOptimizerFailure(prefix)
              ? { failure: "vite-stale-optimized-dependency" as const }
              : {}),
          });
        };
        response.on("data", (chunk: Buffer) => {
          const remaining = responsePrefixLimit - length;
          if (remaining <= 0) return;
          const bounded = chunk.subarray(0, remaining);
          chunks.push(bounded);
          length += bounded.length;
          if (length >= responsePrefixLimit) {
            finish();
            response.destroy();
          }
        });
        response.once("end", finish);
        response.once("error", finish);
      },
    );
    request.setTimeout(2_000, () => request.destroy());
    request.once("error", () => resolve(undefined));
    request.end();
  });
}

/** Exact enough to avoid treating an application's own 500 as infrastructure. */
export function viteOptimizerFailure(prefix: string): boolean {
  const normalized = prefix.toLowerCase();
  return (
    normalized.includes("the file does not exist at") &&
    /node_modules\/(?:\.vite|\.cache\/vite)\/(?:deps|deps_ssr)\//.test(
      normalized,
    ) &&
    normalized.includes("which is in the optimize deps directory")
  );
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
