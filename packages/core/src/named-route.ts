import { execFile } from "node:child_process";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";

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
}

export interface PublishedNamedRoute {
  port: number;
}

export interface NamedRoutePublisher {
  publish(request: PublishNamedRouteRequest): Promise<PublishedNamedRoute>;
  healthy(request: { routeName: string; port: number }): Promise<boolean>;
  remove(routeName: string): Promise<void>;
}

interface ListenerSelection {
  listener: ProcessListener;
  hostname: "127.0.0.1" | "::1";
  response: RouteProbe;
}

interface LoopbackBridge {
  hostname: "127.0.0.1" | "::1";
  targetPort: number;
  port: number;
  close(): Promise<void>;
}

interface RoutePublisherOptions {
  execute?(
    executable: string,
    arguments_: readonly string[],
  ): Promise<CommandResult>;
  inspect?(rootProcessId: number): Promise<readonly ProcessListener[]>;
  probe?(url: string): Promise<RouteProbe | undefined>;
  bridge?(
    routeName: string,
    selected: ListenerSelection,
  ): Promise<LoopbackBridge>;
  wait?(milliseconds: number): Promise<void>;
  now?(): number;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Publishes the listener that actually came out of a supervised command.
 *
 * A monorepo's root `dev` script often ignores PORT and starts several
 * services. Wrapping that script in portless therefore registers a healthy
 * wrapper against an empty port. Silvic instead owns the two lifecycles
 * separately: it supervises the command tree, finds its responding HTTP
 * listener, and points a Portless alias at that concrete port.
 */
export class PortlessRoutePublisher implements NamedRoutePublisher {
  private readonly execute: NonNullable<RoutePublisherOptions["execute"]>;
  private readonly inspect: NonNullable<RoutePublisherOptions["inspect"]>;
  private readonly probe: NonNullable<RoutePublisherOptions["probe"]>;
  private readonly bridge: NonNullable<RoutePublisherOptions["bridge"]>;
  private readonly wait: NonNullable<RoutePublisherOptions["wait"]>;
  private readonly now: NonNullable<RoutePublisherOptions["now"]>;
  private readonly bridges = new Map<string, LoopbackBridge>();

  constructor(options: RoutePublisherOptions = {}) {
    this.execute = options.execute ?? executeCommand;
    this.inspect = options.inspect ?? inspectProcessListeners;
    this.probe = options.probe ?? probeUrl;
    this.bridge = options.bridge ?? createPreviewBridge;
    this.wait = options.wait ?? pause;
    this.now = options.now ?? Date.now;
  }

  async publish(
    request: PublishNamedRouteRequest,
  ): Promise<PublishedNamedRoute> {
    const deadline = this.now() + (request.timeoutMs ?? 45_000);
    let latest =
      "No browser-facing HTML listener appeared in the runtime output or process tree.";

    while (true) {
      const listeners = await this.inspect(request.processId);
      const selected = await selectListener({
        listeners,
        expectedPort: request.expectedPort,
        output: request.output(),
        probe: this.probe,
      });
      if (selected) {
        const targetPort = await this.targetPort(request.routeName, selected);
        const result = await this.execute("portless", [
          "alias",
          request.routeName,
          String(targetPort),
          "--force",
        ]);
        if (result.exitCode !== 0) {
          await this.closeBridge(request.routeName);
          throw new Error(
            cleanFailure(result) ||
              "Portless could not publish the preview route.",
          );
        }

        while (this.now() < deadline) {
          if (
            await this.healthy({
              routeName: request.routeName,
              port: selected.listener.port,
            })
          ) {
            return { port: selected.listener.port };
          }
          latest = `Portless registered ${request.routeName}.localhost, but it did not reach localhost:${targetPort}.`;
          await this.wait(Math.min(150, Math.max(0, deadline - this.now())));
        }
      }

      if (this.now() >= deadline) {
        await this.closeBridge(request.routeName);
        throw new Error(latest);
      }
      await this.wait(Math.min(250, Math.max(0, deadline - this.now())));
    }
  }

  private async targetPort(
    routeName: string,
    selected: ListenerSelection,
  ): Promise<number> {
    const existing = this.bridges.get(routeName);
    if (
      existing?.hostname === selected.hostname &&
      existing.targetPort === selected.listener.port
    ) {
      return existing.port;
    }
    await this.closeBridge(routeName);
    const bridge = await this.bridge(routeName, selected);
    this.bridges.set(routeName, bridge);
    return bridge.port;
  }

  private async closeBridge(routeName: string): Promise<void> {
    const bridge = this.bridges.get(routeName);
    if (!bridge) return;
    this.bridges.delete(routeName);
    await bridge.close();
  }

  async healthy({
    routeName,
    port,
  }: {
    routeName: string;
    port: number;
  }): Promise<boolean> {
    const directPort = this.bridges.get(routeName)?.port ?? port;
    const [direct, named] = await Promise.all([
      this.probe(`http://127.0.0.1:${directPort}/`),
      this.probe(`https://${routeName}.localhost/`),
    ]);
    if (!direct || !named) return false;
    if (!browserFacing(direct) || !browserFacing(named)) return false;
    // Portless preserves the upstream content type. A different type means the
    // alias reached another listener even when both listeners answered 200 —
    // commonly a monorepo health sidecar whose entire response is `OK`.
    if (mediaType(direct.contentType) !== mediaType(named.contentType)) {
      return false;
    }
    // Portless preserves the upstream status. Exact agreement lets a real
    // browser error overlay through while rejecting Portless's own 404/502.
    if (direct.status !== named.status) return false;
    return true;
  }

  async remove(routeName: string): Promise<void> {
    try {
      await this.execute("portless", ["alias", "--remove", routeName]);
    } finally {
      await this.closeBridge(routeName);
    }
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
  // then exit. That existing server is no longer a descendant of the newly
  // supervised command, but its explicit localhost URL is still the strongest
  // available signal that it is the browser app this command intended to run.
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
      })),
    ),
  );

  return (
    candidates
      .filter(
        (
          candidate,
        ): candidate is {
          listener: ProcessListener;
          hostname: "127.0.0.1" | "::1";
          response: RouteProbe;
        } => candidate.response !== undefined,
      )
      // A route marked as a web preview must actually render in a browser.
      // Health checks and API sidecars commonly answer 200 with `OK` or JSON;
      // publishing either would make a broken web runtime look successful.
      .filter((candidate) => browserFacing(candidate.response))
      .sort((left, right) => {
        const score = (candidate: {
          listener: ProcessListener;
          hostname: "127.0.0.1" | "::1";
          response: RouteProbe;
        }) =>
          // PORT is an offered address, not proof of identity. A monorepo can
          // hand it to a health/API sidecar while its browser app chooses another
          // listener, so browser-facing and announced listeners rank above it.
          (candidate.response.contentType?.toLowerCase().includes("text/html")
            ? 10_000
            : 0) +
          (announced.has(candidate.listener.port) ? 1_000 : 0) +
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

function browserFacing(response: RouteProbe): boolean {
  const type = mediaType(response.contentType);
  return (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    (response.status >= 300 && response.status < 400)
  );
}

function createPreviewBridge(
  routeName: string,
  selected: ListenerSelection,
): Promise<LoopbackBridge> {
  const hostname = selected.hostname;
  const targetPort = selected.listener.port;
  const publicHost = `${routeName}.localhost`;
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createHttpServer((request, response) => {
      const upstream = httpRequest(
        {
          host: hostname,
          port: targetPort,
          method: request.method,
          path: request.url,
          headers: previewHeaders(request.headers, publicHost),
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage,
            rewriteLocation(upstreamResponse.headers, publicHost, targetPort),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("socket", (socket) => trackSocket(sockets, socket));
      upstream.once("error", () => {
        if (!response.headersSent) {
          response.writeHead(502, { "content-type": "text/plain" });
        }
        response.end("Preview server unavailable");
      });
      request.once("aborted", () => upstream.destroy());
      request.pipe(upstream);
    });
    server.on("connection", (socket) => trackSocket(sockets, socket));
    server.on("upgrade", (request, client, head) => {
      const upstream = connectTcp({ host: hostname, port: targetPort });
      trackSocket(sockets, upstream);
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      upstream.once("connect", () => {
        const headers = previewHeaders(request.headers, publicHost);
        const lines = Object.entries(headers).flatMap(([name, value]) =>
          Array.isArray(value)
            ? value.map((entry) => `${name}: ${entry}`)
            : value === undefined
              ? []
              : [`${name}: ${value}`],
        );
        upstream.write(
          `${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${lines.join("\r\n")}\r\n\r\n`,
        );
        if (head.length > 0) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    });
    const failed = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      // A bridge failure makes the route health check fail and triggers normal
      // rediscovery. It must not crash the Electron main process.
      server.on("error", () => undefined);
      server.unref();
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Silvic could not allocate an IPv4 preview bridge."));
        return;
      }
      resolve({
        hostname,
        targetPort,
        port: address.port,
        close: () => closePreviewBridge(server, sockets),
      });
    });
  });
}

function previewHeaders(
  headers: IncomingHttpHeaders,
  publicHost: string,
): IncomingHttpHeaders {
  return {
    ...headers,
    host: publicHost,
    "x-forwarded-host": publicHost,
    "x-forwarded-port": "443",
    "x-forwarded-proto": "https",
  };
}

function rewriteLocation(
  headers: IncomingHttpHeaders,
  publicHost: string,
  targetPort: number,
): IncomingHttpHeaders {
  const location = headers.location;
  if (!location) return headers;
  try {
    const target = new URL(location);
    if (
      (target.hostname === "127.0.0.1" || target.hostname === "[::1]") &&
      Number(target.port) === targetPort
    ) {
      target.protocol = "https:";
      target.host = publicHost;
      return { ...headers, location: target.toString() };
    }
  } catch {
    // Relative and malformed locations pass through untouched.
  }
  return headers;
}

function trackSocket(sockets: Set<Socket>, socket: Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function closePreviewBridge(
  server: HttpServer,
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

function mediaType(contentType: string | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function descendantListenerPorts({
  rootProcessId,
  processes,
  listeners,
}: {
  rootProcessId: number;
  processes: readonly (readonly [number, number])[];
  listeners: readonly ProcessListener[];
}): readonly ProcessListener[] {
  const parents = new Map(processes);
  const belongsToTree = (processId: number) => {
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
    executeCommand("ps", ["-axo", "pid=,ppid="]),
    executeCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]),
  ]);
  const processPairs = processes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(
      (pair): pair is [number, number] =>
        pair.length === 2 && pair.every(Number.isSafeInteger),
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
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: resolvedCommandPath(),
    };
    if (executable === "portless") {
      // Silvic invokes the resolved CLI directly. Inheriting these markers
      // from a pnpm-started parent makes Portless mistake that direct call for
      // `pnpm dlx` / `npx` and refuse even a globally installed binary.
      delete environment.npm_command;
      delete environment.PNPM_SCRIPT_SRC_DIR;
    }
    execFile(
      executable,
      [...arguments_],
      {
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 1_000_000,
        env: environment,
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

function cleanFailure(result: CommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /^error\b/i.test(line)) ?? lines.at(-1) ?? "";
}
