import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  GateClient,
  controlSocketPath,
  startGate,
  type Gate,
} from "@silvic/gate";

import {
  CommandSupervisor,
  type SupervisedCommand,
} from "./command-supervisor";
import {
  GateRoutePublisher,
  type GateRouteLink,
  type NamedRoutePublisher,
  type RouteProbe,
} from "./named-route";

const directories: string[] = [];
const extraPorts: number[] = [];
const execFileAsync = promisify(execFile);

let gate: Gate;
let gateState: string;
let client: GateClient;
let link: GateRouteLink;
let rootCertificate: string;

beforeAll(async () => {
  gateState = await mkdtemp(join(tmpdir(), "silvic-gate-live-"));
  directories.push(gateState);
  gate = await startGate({
    stateDirectory: gateState,
    httpsPort: 0,
    httpPort: 0,
    version: "live-test",
    launchApp: () => undefined,
  });
  client = new GateClient({ socketPath: controlSocketPath(gateState) });
  link = {
    set: (route) => client.routeSet(route),
    suspend: (name) => client.routeSuspend(name),
  };
  rootCertificate = await readFile(join(gateState, "ca", "ca.pem"), "utf8");
}, 60_000);

afterAll(async () => {
  client.close();
  await gate.close();
  // Whatever these tests started is detached, so it outlives the runner
  // unless it is ended here.
  try {
    for (const cleanupPort of [port, ...extraPorts]) {
      execFileSync(
        "sh",
        ["-lc", `lsof -ti :${cleanupPort} | xargs -r kill -9`],
        { stdio: "ignore" },
      );
    }
  } catch {
    // Nothing was listening, which is the state being asked for.
  }
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * The production probe reaches named URLs on 443 through the pf redirect.
 * These tests run without root, so named hosts are dialled straight at the
 * gate's ephemeral port while keeping SNI and Host intact.
 */
function probeViaGate(url: string): Promise<RouteProbe | undefined> {
  const target = new URL(url);
  const named = target.hostname.endsWith(".localhost");
  return new Promise((resolve) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        host: named ? "127.0.0.1" : target.hostname.replace(/^\[|\]$/g, ""),
        ...(named
          ? {
              port: gate.httpsPort,
              servername: target.hostname,
              ca: rootCertificate,
              headers: { host: target.hostname, connection: "close" },
            }
          : {
              ...(target.port ? { port: target.port } : {}),
              headers: { connection: "close" },
            }),
        path: `${target.pathname}${target.search}`,
        method: "GET",
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

const curlNamed = async (routeName: string, path = "/", headersOut = false) =>
  execFileAsync("curl", [
    "-sS",
    ...(headersOut ? ["-D", "-", "-o", "/dev/null"] : []),
    "--cacert",
    join(gateState, "ca", "ca.pem"),
    "--connect-to",
    `${routeName}.localhost:443:127.0.0.1:${gate.httpsPort}`,
    `https://${routeName}.localhost${path}`,
  ]);

const unroutedPublisher: NamedRoutePublisher = {
  publish: () => Promise.reject(new Error("This test routes nothing")),
  improve: () => Promise.resolve(undefined),
  healthy: () => Promise.resolve(false),
  remove: () => Promise.resolve(),
};

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
// A fresh port each run, so a leaked server from a previous one cannot make
// this look like a failure of the thing being tested.
const port = 4600 + Math.floor(Math.random() * 300);

it("publishes an IPv6 web server with its public origin through the gate", async () => {
  const webServer = createServer((request, response) => {
    if (request.url === "/app") {
      response.writeHead(302, {
        location: `${request.headers["x-forwarded-proto"]}://${request.headers["x-forwarded-host"]}/app/login`,
      });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>IPv6 Silvic route is live</h1>");
  });
  await new Promise<void>((resolve, reject) => {
    webServer.once("error", reject);
    webServer.listen(0, "::1", resolve);
  });
  const address = webServer.address();
  if (!address || typeof address === "string") {
    throw new Error("The IPv6 test server did not expose a TCP port.");
  }
  const routeName = `silvic-ipv6-${process.pid}-${address.port}`;
  const publisher = new GateRoutePublisher({
    link,
    probe: probeViaGate,
    inspect: async () => [{ processId: process.pid, port: address.port }],
  });

  try {
    const published = await publisher.publish({
      routeName,
      processId: process.pid,
      expectedPort: address.port + 1,
      output: () => `Local: http://localhost:${address.port}`,
      timeoutMs: 5_000,
    });

    expect(published.port).toBe(address.port);
    const served = await curlNamed(routeName);
    expect(served.stdout.trim()).toBe("<h1>IPv6 Silvic route is live</h1>");
    const redirected = await curlNamed(routeName, "/app", true);
    expect(redirected.stdout).toMatch(
      new RegExp(`location: https://${routeName}\\.localhost/app/login`, "i"),
    );
  } finally {
    await publisher.remove(routeName);
    await client.routeRemove(routeName);
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
  }
}, 30_000);

it("starts a real command, stops its whole group, and is taken back", async () => {
  const plot = await mkdtemp(join(tmpdir(), "silvic-live-"));
  const logs = await mkdtemp(join(tmpdir(), "silvic-logs-"));
  directories.push(plot, logs);
  await writeFile(join(plot, "index.html"), "<h1>plot</h1>");

  let announced: readonly SupervisedCommand[] = [];
  const supervisor = new CommandSupervisor({
    logDirectory: logs,
    onChange: (processes) => {
      announced = processes;
    },
    routePublisher: unroutedPublisher,
  });

  await supervisor.start({
    plotPath: plot,
    id: "web",
    command: {
      run: "python3 -m http.server $PORT",
      url: true,
      portless: false,
    },
    routeName: "silvic-live-check",
    environment: {
      PORT: String(port),
      SILVIC_URL: `http://localhost:${port}`,
    },
    canRoute: false,
    detached: true,
  });

  const started = supervisor.list()[0];
  expect(started?.status).toBe("running");
  expect(announced).toHaveLength(1);

  const afterPublishing = supervisor.list()[0];
  expect(afterPublishing?.status).toBe("running");
  expect(afterPublishing?.advice).toBeUndefined();
  expect(afterPublishing?.url).toBe(`http://localhost:${port}`);
  let served = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      served = execFileSync(
        "curl",
        [
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `http://127.0.0.1:${port}/`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      served = "";
    }
    if (served.trim() === "200") break;
    await settle(100);
  }
  expect(served.trim()).toBe("200");

  // A second supervisor, as a new window would be: it should take the running
  // command back rather than offering to start it again.
  let adoptedAnnounce: readonly SupervisedCommand[] = [];
  const reopened = new CommandSupervisor({
    logDirectory: logs,
    onChange: (processes) => {
      adoptedAnnounce = processes;
    },
    routePublisher: unroutedPublisher,
  });
  await reopened.adopt(supervisor.list());
  expect(reopened.list()[0]?.status).toBe("running");
  expect(adoptedAnnounce).toHaveLength(1);

  // And it must refuse an id that is not the process it was.
  const stale = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => {},
    routePublisher: unroutedPublisher,
  });
  await stale.adopt([
    {
      ...(supervisor.list()[0] as SupervisedCommand),
      // The same id, but claiming to have begun last week.
      startedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    },
  ]);
  expect(stale.list()).toHaveLength(0);

  // Stopping reaches the group: the shell and the server it forked.
  const groupLeader = supervisor.list()[0]?.processId as number;
  expect(groupLeader).toBeGreaterThan(0);
  supervisor.stop(plot, "web");
  await settle(2_500);
  expect(() => process.kill(groupLeader, 0)).toThrow();
  expect(supervisor.list()[0]?.status).not.toBe("running");
  // Nothing is listening on the plot's port any more: the shell, and the
  // server it turned into, went together.
  const listeners = execFileSync("sh", ["-lc", `lsof -ti :${port} | wc -l`], {
    encoding: "utf8",
  });
  expect(listeners.trim()).toBe("0");
}, 60_000);

it("publishes the real web listener when a monorepo sidecar claims PORT", async () => {
  const plot = await mkdtemp(join(tmpdir(), "silvic-routed-live-"));
  const logs = await mkdtemp(join(tmpdir(), "silvic-routed-logs-"));
  directories.push(plot, logs);
  const actualPort = 5_200 + Math.floor(Math.random() * 200);
  const offeredPort = actualPort + 1_000;
  extraPorts.push(actualPort, offeredPort);
  const routeName = `silvic-solid-${process.pid}-${actualPort}`;
  const supervisor = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => undefined,
    routeHealthIntervalMs: 60_000,
    routePublisher: new GateRoutePublisher({ link, probe: probeViaGate }),
  });

  await supervisor.start({
    plotPath: plot,
    id: "web",
    command: {
      run: [
        "node -e",
        '\'const http = require("http");',
        "http.createServer((request, response) => {",
        'response.writeHead(200, {"content-type": "text/html"});',
        'response.end("<h1>Silvic route is live</h1>");',
        '}).listen(Number(process.env.ACTUAL_PORT), "127.0.0.1");',
        "http.createServer((request, response) => {",
        'response.writeHead(200, {"content-type": "text/plain"});',
        'response.end("OK");',
        '}).listen(Number(process.env.PORT), "127.0.0.1")\'',
      ].join(" "),
      url: true,
    },
    routeName,
    environment: {
      PORT: String(offeredPort),
      ACTUAL_PORT: String(actualPort),
    },
    canRoute: true,
    detached: true,
  });

  expect(supervisor.list()[0]?.status).toBe("starting");
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (supervisor.list()[0]?.status === "running") break;
    await settle(100);
  }
  expect(supervisor.list()[0]).toMatchObject({
    status: "running",
    expectedPort: offeredPort,
    targetPort: actualPort,
    url: `https://${routeName}.localhost`,
  });

  const served = await curlNamed(routeName);
  expect(served.stdout.trim()).toBe("<h1>Silvic route is live</h1>");

  // Reproduce an older Silvic persisting the responding but wrong sidecar as
  // the route target. Both direct and named probes say `OK`, so checking only
  // that the persisted route is reachable cannot discover the mistake.
  await client.routeSet({
    name: routeName,
    host: "127.0.0.1",
    port: offeredPort,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await curlNamed(routeName)).stdout.trim() === "OK") break;
    await settle(50);
  }
  expect((await curlNamed(routeName)).stdout.trim()).toBe("OK");

  const reopened = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => undefined,
    routeHealthIntervalMs: 500,
    routePublisher: new GateRoutePublisher({ link, probe: probeViaGate }),
  });
  await reopened.adopt([
    {
      ...(supervisor.list()[0] as SupervisedCommand),
      targetPort: offeredPort,
    },
  ]);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (reopened.list()[0]?.targetPort === actualPort) break;
    await settle(100);
  }
  expect(reopened.list()[0]).toMatchObject({
    status: "running",
    targetPort: actualPort,
  });
  expect((await curlNamed(routeName)).stdout.trim()).toBe(
    "<h1>Silvic route is live</h1>",
  );

  reopened.stop(plot, "web");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (supervisor.list().length === 0) break;
    await settle(100);
  }
  expect(supervisor.list()).toEqual([]);
  // Stopping suspends the route: its identity survives so the URL can wake
  // the plot later, but no upstream is registered any more.
  const status = await client.status();
  const suspended = status?.routes.find((route) => route.name === routeName);
  expect(suspended).toBeDefined();
  expect(suspended?.port).toBeUndefined();
  await client.routeRemove(routeName);
}, 60_000);
