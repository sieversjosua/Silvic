import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CertificateAuthority } from "./certificates";
import { GateClient } from "./client";
import { parseControlRequest } from "./control-protocol";
import { startGate, type Gate } from "./daemon";
import { RouteStore } from "./route-store";
import {
  adminSetupScript,
  installLaunchAgent,
  installPrivileged,
  installUserTrust,
  launchAgentPlist,
  pfAnchorRules,
  stopOrphanGate,
} from "./setup";
import { controlSocketPath } from "./state-dir";

const temporary = () => mkdtempSync(join(tmpdir(), "silvic-gate-test-"));

describe("RouteStore", () => {
  it("persists routes across instances and tolerates garbage", () => {
    const directory = temporary();
    try {
      const store = new RouteStore(directory);
      store.set({ name: "web-checkout-shop", host: "127.0.0.1", port: 4321 });
      store.set({ name: "web-other-shop", port: 5000, plotPath: "/tmp/x" });
      store.clearUpstream("web-other-shop");
      store.remove("never-there");

      const reloaded = new RouteStore(directory);
      expect(reloaded.find("web-checkout-shop")?.port).toBe(4321);
      const suspended = reloaded.find("web-other-shop");
      expect(suspended?.port).toBeUndefined();
      expect(suspended?.plotPath).toBe("/tmp/x");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces a plot command's stale route name on re-publish", () => {
    const directory = temporary();
    try {
      const store = new RouteStore(directory);
      store.set({
        name: "web-mono-mono",
        port: 4322,
        plotPath: "/w/65e0/mono",
        commandId: "web",
      });
      store.set({
        name: "web-feature-billing-foundation-mono",
        port: 4322,
        plotPath: "/w/65e0/mono",
        commandId: "web",
      });
      expect(store.list().map((route) => route.name)).toEqual([
        "web-feature-billing-foundation-mono",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drops entries that are not routes", () => {
    const directory = temporary();
    try {
      const store = new RouteStore(directory);
      store.set({ name: "good-route", port: 3000 });
      const file = join(directory, "routes.json");
      const routes: unknown[] = JSON.parse(readFileSync(file, "utf8"));
      routes.push({ name: "UPPER CASE", port: "nope" });
      writeFileSync(file, JSON.stringify(routes));
      expect(
        new RouteStore(directory).list().map((route) => route.name),
      ).toEqual(["good-route"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("control protocol", () => {
  it("accepts well-formed requests and rejects the rest", () => {
    expect(
      parseControlRequest(
        JSON.stringify({
          id: 1,
          type: "route-set",
          name: "web-a-b",
          host: "127.0.0.1",
          port: 4321,
        }),
      ),
    ).toMatchObject({ type: "route-set", port: 4321 });
    expect(
      parseControlRequest(
        JSON.stringify({ id: 2, type: "route-set", name: "Bad Name", port: 1 }),
      ),
    ).toBeUndefined();
    expect(parseControlRequest("not json")).toBeUndefined();
    expect(
      parseControlRequest(
        JSON.stringify({ id: 3, type: "route-remove", name: "a" }),
      ),
    ).toMatchObject({ type: "route-remove" });
  });
});

describe("setup artefacts", () => {
  it("redirects only loopback 443 and 80", () => {
    const rules = pfAnchorRules();
    expect(rules).toContain("on lo0");
    expect(rules).not.toContain("en0");
    expect(rules).toContain("port 443 -> 127.0.0.1");
  });

  it("runs the gate as plain Node from the app binary", () => {
    const contents = launchAgentPlist({
      nodeExecutable: "/Applications/Silvic.app/Contents/MacOS/Silvic",
      gateScript: "/Applications/Silvic.app/…/gate.js",
      stateDirectory: "/tmp/state",
    });
    expect(contents).toContain("ELECTRON_RUN_AS_NODE");
    expect(contents).toContain("<key>KeepAlive</key>");
  });

  it("keeps trust out of the admin script — root cannot grant it there", () => {
    const script = adminSetupScript();
    expect(script).not.toContain("add-trusted-cert");
    expect(script).toContain("pfctl");
    expect(script).toContain("launchctl bootstrap system");
  });

  it("grants certificate trust in the user domain", async () => {
    const calls: string[][] = [];
    await installUserTrust({
      execute: async (executable, arguments_) => {
        calls.push([executable, ...arguments_]);
        return { stdout: "", stderr: "" };
      },
    });
    expect(calls[0]?.slice(0, 4)).toEqual([
      "security",
      "add-trusted-cert",
      "-r",
      "trustRoot",
    ]);
    expect(calls[0]).not.toContain("-d");
  });

  it("waits out launchd's unload window before loading the agent", async () => {
    // `bootout` returns before the service is gone; a bootstrap sent into
    // that window fails with EIO and leaves the machine with no gate at all.
    let unloading = 2;
    const calls: string[][] = [];
    await inTemporaryHome(async () => {
      await installLaunchAgent({
        nodeExecutable: "/Applications/Silvic.app/Contents/MacOS/Silvic",
        gateScript: "/Applications/Silvic.app/…/gate.mjs",
        wait: async () => undefined,
        execute: async (executable, arguments_) => {
          calls.push([executable, ...arguments_]);
          if (arguments_[0] === "print" && unloading-- > 0) {
            return { stdout: "state = running", stderr: "" };
          }
          if (arguments_[0] === "print") throw new Error("Bad request.");
          if (arguments_[0] === "bootstrap" && unloading > -1) {
            throw new Error("Bootstrap failed: 5: Input/output error");
          }
          return { stdout: "", stderr: "" };
        },
      });
    });
    const verbs = calls.map((call) => call[1]);
    expect(verbs).toEqual(["bootout", "print", "print", "print", "bootstrap"]);
  });

  it("reports a launch agent that launchd never loads", async () => {
    await expect(
      inTemporaryHome(() =>
        installLaunchAgent({
          nodeExecutable: "/Applications/Silvic.app/Contents/MacOS/Silvic",
          gateScript: "/Applications/Silvic.app/…/gate.mjs",
          wait: async () => undefined,
          execute: async (_executable, arguments_) => {
            if (arguments_[0] === "bootstrap") {
              throw new Error("Bootstrap failed: 5: Input/output error");
            }
            throw new Error("Bad request.");
          },
        }),
      ),
    ).rejects.toThrow(/would not load/);
  });

  it("ends a gate that holds the ports but answers nobody", async () => {
    const signals: [number, string][] = [];
    let alive = true;
    const stopped = await stopOrphanGate({
      wait: async () => undefined,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        alive = false;
      },
      execute: async (executable) => {
        if (executable === "lsof") {
          if (!alive) throw new Error("nothing listens");
          return { stdout: "17201\n", stderr: "" };
        }
        return {
          stdout:
            "/Applications/Silvic.app/Contents/MacOS/Silvic /Applications/Silvic.app/…/gate.mjs\n",
          stderr: "",
        };
      },
    });
    expect(stopped).toEqual([17201]);
    expect(signals).toEqual([[17201, "SIGTERM"]]);
  });

  it("leaves a program that is not the gate on the port alone", async () => {
    const signals: number[] = [];
    const stopped = await stopOrphanGate({
      wait: async () => undefined,
      kill: (pid) => signals.push(pid),
      execute: async (executable) =>
        executable === "lsof"
          ? { stdout: "4242\n", stderr: "" }
          : { stdout: "/opt/homebrew/bin/caddy run\n", stderr: "" },
    });
    expect(stopped).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("shell-quotes the admin script path for osascript", async () => {
    // The state directory lives under "Application Support"; an unquoted
    // space here once broke setup right after the password was typed.
    const directory = mkdtempSync(join(tmpdir(), "silvic gate spaced "));
    const previous = process.env["SILVIC_GATE_STATE_DIR"];
    process.env["SILVIC_GATE_STATE_DIR"] = directory;
    const calls: string[][] = [];
    try {
      await installPrivileged({
        execute: async (executable, arguments_) => {
          calls.push([executable, ...arguments_]);
          return { stdout: "", stderr: "" };
        },
      });
    } finally {
      if (previous === undefined) delete process.env["SILVIC_GATE_STATE_DIR"];
      else process.env["SILVIC_GATE_STATE_DIR"] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
    const [call] = calls;
    expect(call?.[0]).toBe("osascript");
    expect(call?.[2]).toContain('quoted form of "');
    expect(call?.[2]).toContain("silvic gate spaced");
  });
});

describe("CertificateAuthority", () => {
  it("issues a leaf for a host, signed by its root, with the right SAN", async () => {
    const directory = temporary();
    try {
      const authority = new CertificateAuthority(directory);
      const issued = await authority.certificateFor("web-a-b.localhost");
      const leaf = new X509Certificate(issued.cert);
      expect(leaf.subjectAltName).toContain("web-a-b.localhost");
      const root = new X509Certificate(
        readFileSync(authority.rootCertificatePath),
      );
      expect(leaf.verify(root.publicKey)).toBe(true);
      // Cached and re-read instances agree.
      const again = await new CertificateAuthority(directory).certificateFor(
        "web-a-b.localhost",
      );
      expect(new X509Certificate(again.cert).fingerprint256).toBe(
        leaf.fingerprint256,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("gate daemon", () => {
  let directory: string;
  let gate: Gate;
  let upstream: HttpServer;
  let upstreamPort: number;
  let seenByUpstream: IncomingHttpHeaders | undefined;
  let rootCertificate: string;
  const launchApp = vi.fn();

  beforeAll(async () => {
    directory = temporary();
    upstream = createHttpServer((request, response) => {
      seenByUpstream = request.headers;
      if (request.url === "/redirect") {
        response.writeHead(302, {
          location: `http://127.0.0.1:${upstreamPort}/after`,
        });
        response.end();
        return;
      }
      if (request.url === "/vite-stale") {
        response.writeHead(500, { "content-type": "text/html" });
        response.end(
          `The file does not exist at "/tmp/plot/node_modules/.vite/deps_ssr/clsx.js?v=123" which is in the optimize deps directory.`,
        );
        return;
      }
      if (request.url === "/application-error") {
        response.writeHead(500, { "content-type": "text/html" });
        response.end("<h1>The application failed</h1>");
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>plot</h1>");
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("no port");
    upstreamPort = address.port;

    gate = await startGate({
      stateDirectory: directory,
      httpsPort: 0,
      httpPort: 0,
      version: "test",
      launchApp,
    });
    rootCertificate = readFileSync(join(directory, "ca", "ca.pem"), "utf8");
  }, 60_000);

  afterAll(async () => {
    await gate.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  const get = (host: string, path = "/", port = gate.httpsPort) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const request = httpsRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            servername: host,
            headers: { host },
            ca: rootCertificate,
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => (body += chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body,
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      },
    );

  it("keeps the running gate reachable when a second one cannot bind", async () => {
    // The state a work machine sat in for a day: an orphan held the ports
    // while its crash-looping successor kept replacing the control socket,
    // so nothing on the machine could see the gate that was actually there.
    await expect(
      startGate({
        stateDirectory: directory,
        httpsPort: gate.httpsPort,
        httpPort: gate.httpPort,
        version: "intruder",
      }),
    ).rejects.toThrow(/EADDRINUSE/);
    const client = new GateClient({
      socketPath: controlSocketPath(directory),
    });
    try {
      expect((await client.status())?.version).toBe("test");
    } finally {
      // A client left connected counts as an app for the wake tests below.
      client.close();
    }
  });

  it("proxies a registered route with forwarding headers", async () => {
    const client = new GateClient({
      socketPath: controlSocketPath(directory),
    });
    await client.routeSet({
      name: "web-live-shop",
      host: "127.0.0.1",
      port: upstreamPort,
      plotPath: "/tmp/plot",
      commandId: "web",
    });
    const reply = await get("web-live-shop.localhost");
    expect(reply.status).toBe(200);
    expect(reply.body).toContain("plot");
    expect(seenByUpstream?.["x-forwarded-proto"]).toBe("https");
    expect(seenByUpstream?.["x-forwarded-host"]).toBe(
      "web-live-shop.localhost",
    );
    expect(seenByUpstream?.host).toBe("web-live-shop.localhost");
    client.close();
  }, 30_000);

  it("rewrites upstream Location headers to the public origin", async () => {
    const reply = await get("web-live-shop.localhost", "/redirect");
    expect(reply.status).toBe(302);
    expect(reply.headers.location).toBe(
      "https://web-live-shop.localhost/after",
    );
  });

  it("reports only the known Vite failure while preserving the response", async () => {
    const failed = vi.fn();
    const listener = new GateClient({
      socketPath: controlSocketPath(directory),
      onFailure: failed,
    });
    await listener.status();

    const stale = await get("web-live-shop.localhost", "/vite-stale");
    expect(stale.status).toBe(500);
    expect(stale.body).toContain("node_modules/.vite/deps_ssr/clsx.js");
    await vi.waitFor(() =>
      expect(failed).toHaveBeenCalledWith({
        route: "web-live-shop",
        plotPath: "/tmp/plot",
        commandId: "web",
        failure: "vite-stale-optimized-dependency",
      }),
    );

    failed.mockClear();
    const unrelated = await get(
      "web-live-shop.localhost",
      "/application-error",
    );
    expect(unrelated.status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(failed).not.toHaveBeenCalled();
    listener.close();
  });

  it("answers its own host with gate health", async () => {
    const reply = await get("silvic-gate.localhost");
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ gate: "silvic" });
  });

  it("wakes a connected app instead of launching one", async () => {
    const woken = vi.fn();
    const listener = new GateClient({
      socketPath: controlSocketPath(directory),
      onWake: woken,
    });
    await listener.routeSet({
      name: "web-sleepy-shop",
      host: "127.0.0.1",
      port: 1,
      plotPath: "/tmp/sleepy",
      commandId: "web",
    });
    const reply = await get("web-sleepy-shop.localhost");
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("Waking");
    await vi.waitFor(() =>
      expect(woken).toHaveBeenCalledWith(
        expect.objectContaining({ route: "web-sleepy-shop" }),
      ),
    );
    expect(launchApp).not.toHaveBeenCalled();
    listener.close();
  }, 30_000);

  it("launches the app when nothing is connected", async () => {
    const client = new GateClient({
      socketPath: controlSocketPath(directory),
    });
    await client.routeSet({
      name: "web-alone-shop",
      host: "127.0.0.1",
      port: 1,
    });
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reply = await get("web-alone-shop.localhost");
    expect(reply.status).toBe(503);
    await vi.waitFor(() =>
      expect(launchApp).toHaveBeenCalledWith("web-alone-shop"),
    );
  }, 30_000);

  it("reports upstream readiness for the holding page", async () => {
    const ready = await get(
      "web-live-shop.localhost",
      "/__silvic/route-status",
    );
    expect(JSON.parse(ready.body)).toEqual({ ready: true });
    const asleep = await get(
      "web-sleepy-shop.localhost",
      "/__silvic/route-status",
    );
    expect(JSON.parse(asleep.body)).toEqual({ ready: false });
  });

  it("redirects plain http to the named https origin", async () => {
    const reply = await new Promise<{ status: number; location?: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: gate.httpPort,
            path: "/somewhere?x=1",
            headers: { host: "web-live-shop.localhost" },
          },
          (response) => {
            response.resume();
            resolve({
              status: response.statusCode ?? 0,
              ...(response.headers.location
                ? { location: response.headers.location }
                : {}),
            });
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
    expect(reply.status).toBe(308);
    expect(reply.location).toBe(
      "https://web-live-shop.localhost/somewhere?x=1",
    );
  });
});

/** installLaunchAgent writes into ~/Library/LaunchAgents; keep that in /tmp. */
async function inTemporaryHome(act: () => Promise<void>): Promise<void> {
  const home = temporary();
  const previous = {
    home: process.env["HOME"],
    state: process.env["SILVIC_GATE_STATE_DIR"],
  };
  process.env["HOME"] = home;
  process.env["SILVIC_GATE_STATE_DIR"] = join(home, "state");
  try {
    await act();
  } finally {
    restore("HOME", previous.home);
    restore("SILVIC_GATE_STATE_DIR", previous.state);
    rmSync(home, { recursive: true, force: true });
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
