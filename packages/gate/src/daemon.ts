import { appendFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { createSecureContext, type SecureContext } from "node:tls";

import { CertificateAuthority } from "./certificates";
import { GATE_HOST, GATE_HTTP_PORT, GATE_HTTPS_PORT } from "./constants";
import { validRouteName } from "./control-protocol";
import { startControlServer, type ControlServer } from "./control";
import {
  createRedirectHandler,
  createRequestHandler,
  createUpgradeHandler,
} from "./proxy";
import { RouteStore } from "./route-store";
import { controlSocketPath, gateStateDirectory } from "./state-dir";
import { Waker } from "./wake";

export interface Gate {
  stateDirectory: string;
  httpsPort: number;
  httpPort: number;
  close(): Promise<void>;
}

export interface GateOptions {
  stateDirectory?: string;
  httpsPort?: number;
  httpPort?: number;
  version?: string;
  launchApp?(routeName: string): void;
  log?(message: string): void;
}

export async function startGate(options: GateOptions = {}): Promise<Gate> {
  const stateDirectory = options.stateDirectory ?? gateStateDirectory();
  const logFile = join(stateDirectory, "gate.log");
  const log =
    options.log ??
    ((message: string) => {
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
      } catch {
        // Logging must never take the router down.
      }
    });

  const store = new RouteStore(stateDirectory);
  const authority = new CertificateAuthority(stateDirectory);
  const fallback = await authority.certificateFor(GATE_HOST);

  // The control socket is claimed last, after the ports are held: starting
  // it replaces whatever socket file is there, and an instance that then
  // dies on EADDRINUSE would leave the gate that actually serves the ports
  // unreachable — a deadlock nothing on the machine could break.
  let control: ControlServer | undefined;
  const waker = new Waker({
    broadcast: (event) => control?.broadcast(event) ?? false,
    log,
    ...(options.launchApp ? { launchApp: options.launchApp } : {}),
  });
  const context = {
    store,
    version: options.version ?? "dev",
    wake: (route: Parameters<Waker["wake"]>[0]) => waker.wake(route),
    recover: (
      route: Parameters<Waker["wake"]>[0],
      failure: "vite-stale-optimized-dependency",
    ) => {
      // Stop new requests from reaching the known-broken process while the
      // desktop app clears its cache and replaces it. The route identity stays
      // available so the recovery page can poll until it is published again.
      store.clearUpstream(route.name);
      const event = {
        type: "route-failure" as const,
        route: route.name,
        failure,
        ...(route.plotPath ? { plotPath: route.plotPath } : {}),
        ...(route.commandId ? { commandId: route.commandId } : {}),
      };
      if (control?.broadcast(event)) {
        log(`route failure ${route.name}: ${failure}`);
      }
    },
  };

  const contexts = new Map<string, Promise<SecureContext>>();
  const secureContextFor = (servername: string): Promise<SecureContext> => {
    const existing = contexts.get(servername);
    if (existing) return existing;
    const created = authority
      .certificateFor(servername)
      .then((issued) =>
        createSecureContext({ key: issued.key, cert: issued.cert }),
      )
      .catch((error: unknown) => {
        contexts.delete(servername);
        throw error;
      });
    contexts.set(servername, created);
    return created;
  };

  const handleRequest = createRequestHandler(context);
  const handleUpgrade = createUpgradeHandler(context);
  const redirect = createRedirectHandler();

  const makeHttps = () =>
    createHttpsServer({
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (servername, callback) => {
        const name = servername.toLowerCase();
        const label = name.endsWith(".localhost")
          ? name.slice(0, -".localhost".length)
          : name;
        // Certificates are minted only for names the gate actually serves;
        // arbitrary SNI must not be able to grow the certificate directory.
        if (
          name !== GATE_HOST &&
          !(validRouteName(label) && store.find(label))
        ) {
          callback(null, undefined);
          return;
        }
        secureContextFor(name).then(
          (secureContext) => callback(null, secureContext),
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });

  // Port 0 picks an ephemeral port on the first bind (tests); the second
  // family then reuses whatever was assigned.
  let httpsPort = options.httpsPort ?? GATE_HTTPS_PORT;
  let httpPort = options.httpPort ?? GATE_HTTP_PORT;
  const servers: HttpServer[] = [];
  // Loopback only, and each family separately: binding the wildcard would
  // put the proxy on the network, which the gate must never do.
  for (const address of ["127.0.0.1", "::1"] as const) {
    const https = makeHttps();
    https.on("request", handleRequest);
    https.on("upgrade", handleUpgrade);
    https.on("error", (error) => log(`https ${address}: ${error.message}`));
    const http = createHttpServer(redirect);
    http.on("error", (error) => log(`http ${address}: ${error.message}`));
    const optional = address === "::1";
    httpsPort =
      (await listen(https, httpsPort, address, optional)) ?? httpsPort;
    httpPort = (await listen(http, httpPort, address, optional)) ?? httpPort;
    servers.push(https, http);
  }
  control = await startControlServer({
    socketPath: controlSocketPath(stateDirectory),
    store,
    version: options.version ?? "dev",
    log,
  });
  const controlServer = control;
  log(
    `gate up: https ${httpsPort}, http ${httpPort}, routes ${store.list().length}`,
  );

  return {
    stateDirectory,
    httpsPort,
    httpPort,
    close: async () => {
      await controlServer.close();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections?.();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}

function listen(
  server: HttpServer,
  port: number,
  address: string,
  optional: boolean,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      // A machine without IPv6 loopback still deserves a working gate.
      if (optional) resolve(undefined);
      else reject(error);
    });
    server.listen(port, address, () => {
      const bound = server.address();
      resolve(bound && typeof bound === "object" ? bound.port : undefined);
    });
  });
}
