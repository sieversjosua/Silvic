import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as connectTcp, type Socket } from "node:net";

import { GATE_HOST } from "./constants";
import {
  holdingPage,
  recoveryPage,
  unknownRoutePage,
  upstreamFailedPage,
} from "./pages";
import type { GateRoute, RouteStore } from "./route-store";

export interface ProxyContext {
  store: RouteStore;
  version: string;
  wake(route: GateRoute): void;
  recover(route: GateRoute, failure: "vite-stale-optimized-dependency"): void;
}

/**
 * One handler serves every named host. The browser already addresses the
 * public origin, so unlike the old in-app bridge nothing needs to be
 * disguised — only the forwarding headers and upstream Location headers that
 * mention the loopback port are adjusted.
 */
export function createRequestHandler(context: ProxyContext) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const host = requestHost(request);
    if (host === GATE_HOST) {
      respondJson(response, 200, {
        gate: "silvic",
        version: context.version,
        routes: context.store.list().length,
      });
      return;
    }
    const route = context.store.find(routeName(host));
    if (!route) {
      respondHtml(response, 404, unknownRoutePage(host, context.store.list()));
      return;
    }
    if (request.url === "/__silvic/route-status") {
      void upstreamReady(route).then((ready) => {
        if (!ready) context.wake(route);
        respondJson(response, 200, { ready });
      });
      return;
    }
    if (route.port === undefined) {
      context.wake(route);
      respondHtml(response, 503, holdingPage(route));
      return;
    }
    forward(route, route.port, request, response, context);
  };
}

function forward(
  route: GateRoute,
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
  context: ProxyContext,
): void {
  const publicHost = `${route.name}.localhost`;
  const upstream = httpRequest(
    {
      host: route.host ?? "127.0.0.1",
      port,
      method: request.method,
      path: request.url,
      headers: {
        ...forwardedHeaders(request.headers, publicHost),
        // Hop-by-hop connection state belongs to the browser↔gate hop. A
        // pooled upstream socket survived desktop restarts and could leave a
        // warm Next dev server spinning forever after the client vanished.
        connection: "close",
      },
      agent: false,
    },
    (upstreamResponse) => {
      forwardResponse(
        route,
        port,
        publicHost,
        upstreamResponse,
        response,
        context,
      );
    },
  );
  upstream.once("error", (error: NodeJS.ErrnoException) => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    // A refused connection means the dev server is gone: hold the page open
    // and wake the plot instead of showing the browser a bare error.
    if (error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT") {
      context.wake(route);
      respondHtml(response, 503, holdingPage(route));
      return;
    }
    respondHtml(response, 502, upstreamFailedPage(route));
  });
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

const failurePrefixLimit = 16 * 1_024;

/** Buffers only candidate errors so a known broken page never reaches users. */
function forwardResponse(
  route: GateRoute,
  port: number,
  publicHost: string,
  upstream: IncomingMessage,
  response: ServerResponse,
  context: ProxyContext,
): void {
  const status = upstream.statusCode ?? 0;
  if (status < 500 || status >= 600) {
    writeUpstreamHead(response, upstream, publicHost, port);
    upstream.pipe(response);
    return;
  }

  const chunks: Buffer[] = [];
  let length = 0;
  let decided = false;
  const decide = (ended: boolean) => {
    if (decided) return;
    decided = true;
    const buffered = Buffer.concat(chunks, length);
    const prefix = buffered.subarray(0, failurePrefixLimit).toString("utf8");
    if (viteOptimizerFailure(prefix)) {
      context.recover(route, "vite-stale-optimized-dependency");
      upstream.destroy();
      respondHtml(response, 503, recoveryPage(route));
      return;
    }
    writeUpstreamHead(response, upstream, publicHost, port);
    if (ended) {
      response.end(buffered);
      return;
    }
    response.write(buffered);
    upstream.pipe(response);
  };
  upstream.on("data", (chunk: Buffer) => {
    if (decided) return;
    chunks.push(chunk);
    length += chunk.length;
    if (length >= failurePrefixLimit) decide(false);
  });
  upstream.once("end", () => decide(true));
  upstream.once("error", () => decide(true));
}

function writeUpstreamHead(
  response: ServerResponse,
  upstream: IncomingMessage,
  publicHost: string,
  port: number,
): void {
  response.writeHead(
    upstream.statusCode ?? 502,
    upstream.statusMessage,
    rewriteLocation(upstream.headers, publicHost, port),
  );
}

function viteOptimizerFailure(prefix: string): boolean {
  const normalized = prefix.toLowerCase();
  return (
    normalized.includes("the file does not exist at") &&
    /node_modules\/(?:\.vite|\.cache\/vite)\/(?:deps|deps_ssr)\//.test(
      normalized,
    ) &&
    normalized.includes("which is in the optimize deps directory")
  );
}

/** WebSocket upgrades pass through as raw TCP once the handshake is sent. */
export function createUpgradeHandler(context: ProxyContext) {
  return (request: IncomingMessage, client: Socket, head: Buffer): void => {
    const route = context.store.find(routeName(requestHost(request)));
    if (!route || route.port === undefined) {
      client.destroy();
      return;
    }
    const upstream = connectTcp({
      host: route.host ?? "127.0.0.1",
      port: route.port,
    });
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
    upstream.once("connect", () => {
      const headers = forwardedHeaders(
        request.headers,
        `${route.name}.localhost`,
      );
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
  };
}

/** Everything on plain HTTP moves to the named HTTPS origin. */
export function createRedirectHandler() {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const host = requestHost(request);
    response.writeHead(308, {
      location: `https://${host}${request.url ?? "/"}`,
    });
    response.end();
  };
}

/** Whether a TCP connection to the upstream currently succeeds. */
export function upstreamReady(route: GateRoute): Promise<boolean> {
  if (route.port === undefined) return Promise.resolve(false);
  const port = route.port;
  return new Promise((resolve) => {
    const socket = connectTcp({ host: route.host ?? "127.0.0.1", port });
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function requestHost(request: IncomingMessage): string {
  const raw = request.headers.host ?? "";
  const withoutPort = raw.startsWith("[")
    ? raw.replace(/\].*$/, "]")
    : (raw.split(":", 1)[0] ?? "");
  return withoutPort.toLowerCase();
}

function routeName(host: string): string {
  return host.endsWith(".localhost")
    ? host.slice(0, -".localhost".length)
    : host;
}

function forwardedHeaders(
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
      (target.hostname === "127.0.0.1" ||
        target.hostname === "localhost" ||
        target.hostname === "[::1]") &&
      Number(target.port) === targetPort
    ) {
      target.protocol = "https:";
      target.hostname = publicHost;
      // Assigning host alone keeps the old port; the public origin has none.
      target.port = "";
      return { ...headers, location: target.toString() };
    }
  } catch {
    // Relative and malformed locations pass through untouched.
  }
  return headers;
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function respondHtml(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}
