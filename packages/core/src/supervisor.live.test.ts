import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { afterAll, expect, it } from "vitest";

import {
  CommandSupervisor,
  type SupervisedCommand,
} from "./command-supervisor";
import { PortlessRoutePublisher } from "./named-route";

const directories: string[] = [];
const namedRoutes: string[] = [];
const extraPorts: number[] = [];
const execFileAsync = promisify(execFile);

function directPortlessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.npm_command;
  delete environment.PNPM_SCRIPT_SRC_DIR;
  return environment;
}

afterAll(async () => {
  // Whatever this test started is detached, so it outlives the runner unless
  // it is ended here.
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
  for (const routeName of namedRoutes) {
    try {
      execFileSync("portless", ["alias", "--remove", routeName], {
        stdio: "ignore",
        env: directPortlessEnvironment(),
      });
    } catch {
      // A successfully stopped supervisor has already removed it.
    }
  }
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
// A fresh port each run, so a leaked server from a previous one cannot make
// this look like a failure of the thing being tested.
const port = 4600 + Math.floor(Math.random() * 300);

it("publishes an IPv6-only web server through the IPv4 Portless router", async () => {
  const webServer = createServer((_request, response) => {
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
  namedRoutes.push(routeName);
  const publisher = new PortlessRoutePublisher({
    inspect: async () => [{ processId: process.pid, port: address.port }],
  });

  try {
    const published = await publisher.publish({
      routeName,
      processId: process.pid,
      expectedPort: address.port + 1,
      output: () => `Local: http://localhost:${address.port}`,
      timeoutMs: 2_000,
    });

    expect(published.port).not.toBe(address.port);
    const served = await execFileAsync("curl", [
      "-ksS",
      `https://${routeName}.localhost/`,
    ]);
    expect(served.stdout.trim()).toBe("<h1>IPv6 Silvic route is live</h1>");
  } finally {
    await publisher.remove(routeName);
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
  }
}, 10_000);

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
  });
  await reopened.adopt(supervisor.list());
  expect(reopened.list()[0]?.status).toBe("running");
  expect(adoptedAnnounce).toHaveLength(1);

  // And it must refuse an id that is not the process it was.
  const stale = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => {},
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
  namedRoutes.push(routeName);
  const supervisor = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => undefined,
    routeHealthIntervalMs: 60_000,
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

  const served = execFileSync(
    "curl",
    ["-ksS", `https://${routeName}.localhost/`],
    { encoding: "utf8" },
  );
  expect(served.trim()).toBe("<h1>Silvic route is live</h1>");

  // Reproduce an older Silvic persisting the responding but wrong sidecar as
  // the route target. Both direct and named probes say `OK`, so checking only
  // that the persisted alias is reachable cannot discover the mistake.
  execFileSync(
    "portless",
    ["alias", routeName, String(offeredPort), "--force"],
    { stdio: "ignore", env: directPortlessEnvironment() },
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const body = execFileSync(
      "curl",
      ["-ksS", `https://${routeName}.localhost/`],
      { encoding: "utf8" },
    ).trim();
    if (body === "OK") break;
    await settle(50);
  }
  expect(
    execFileSync("curl", ["-ksS", `https://${routeName}.localhost/`], {
      encoding: "utf8",
    }).trim(),
  ).toBe("OK");

  const reopened = new CommandSupervisor({
    logDirectory: logs,
    onChange: () => undefined,
    routeHealthIntervalMs: 500,
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
  expect(
    execFileSync("curl", ["-ksS", `https://${routeName}.localhost/`], {
      encoding: "utf8",
    }).trim(),
  ).toBe("<h1>Silvic route is live</h1>");

  reopened.stop(plot, "web");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (supervisor.list().length === 0) break;
    await settle(100);
  }
  expect(supervisor.list()).toEqual([]);
  expect(
    execFileSync("portless", ["list"], {
      encoding: "utf8",
      env: directPortlessEnvironment(),
    }),
  ).not.toContain(routeName);
}, 60_000);
