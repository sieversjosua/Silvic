import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

import { AutomationClient } from "./client";
import { AutomationError } from "./protocol";
import { startAutomationServer, type AutomationServer } from "./server";

const directories: string[] = [];
let server: AutomationServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("shares the default socket path between server and client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-automation-"));
  directories.push(directory);
  vi.stubEnv("SILVIC_AUTOMATION_DIR", directory);
  server = await startAutomationServer({
    handle: async (request) => ({ method: request.method }),
  });

  const client = new AutomationClient();
  await expect(client.call("status")).resolves.toEqual({ method: "status" });
});

it("round-trips structured requests over a user-local socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-automation-"));
  directories.push(directory);
  const socketPath = join(directory, "automation.sock");
  server = await startAutomationServer({
    socketPath,
    handle: async (request) => ({
      method: request.method,
      params: request.params,
    }),
  });

  const client = new AutomationClient({ socketPath });
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  await expect(client.call("status", { plot: "stable-id" })).resolves.toEqual({
    method: "status",
    params: { plot: "stable-id" },
  });
});

it("accepts a plugin only when its explicit release matches the server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-automation-"));
  directories.push(directory);
  const socketPath = join(directory, "automation.sock");
  server = await startAutomationServer({
    socketPath,
    serverVersion: "0.1.53",
    handle: async (request) => ({ client: request.client }),
  });

  const client = new AutomationClient({
    socketPath,
    client: { name: "silvic-codex-plugin", version: "0.1.53" },
  });
  await expect(client.call("snapshot")).resolves.toEqual({
    client: { name: "silvic-codex-plugin", version: "0.1.53" },
  });
});

it("preserves machine-readable server errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-automation-"));
  directories.push(directory);
  const socketPath = join(directory, "automation.sock");
  server = await startAutomationServer({
    socketPath,
    handle: async () => {
      throw new AutomationError("PLOT_NOT_FOUND", "No such Plot", {
        selector: "missing",
      });
    },
  });

  const client = new AutomationClient({ socketPath });
  await expect(client.call("status", { plot: "missing" })).rejects.toEqual(
    expect.objectContaining({
      code: "PLOT_NOT_FOUND",
      message: "No such Plot",
      details: { selector: "missing" },
    }),
  );
});

it("rejects a version-skewed plugin with an actionable structured error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-automation-"));
  directories.push(directory);
  const socketPath = join(directory, "automation.sock");
  server = await startAutomationServer({
    socketPath,
    serverVersion: "0.1.53",
    handle: async () => ({ shouldNotRun: true }),
  });

  const client = new AutomationClient({
    socketPath,
    client: { name: "silvic-codex-plugin", version: "0.1.46" },
  });
  await expect(client.call("snapshot")).rejects.toEqual(
    expect.objectContaining({
      code: "INCOMPATIBLE_CLIENT",
      details: expect.objectContaining({
        client: { name: "silvic-codex-plugin", version: "0.1.46" },
        server: { name: "silvic-desktop", version: "0.1.53" },
        action: expect.stringContaining("Silvic 0.1.53"),
      }),
    }),
  );
});

it("answers a legacy protocol in its own envelope so old clients see the remedy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-automation-"));
  directories.push(directory);
  const socketPath = join(directory, "automation.sock");
  server = await startAutomationServer({
    socketPath,
    serverVersion: "0.1.53",
    handle: async () => ({ shouldNotRun: true }),
  });

  const reply = await rawCall(socketPath, {
    jsonrpc: "2.0",
    protocolVersion: 1,
    id: "legacy-request",
    method: "snapshot",
    params: {},
  });

  expect(reply).toMatchObject({
    protocolVersion: 1,
    id: "legacy-request",
    ok: false,
    error: {
      code: "UNSUPPORTED_PROTOCOL",
      details: { supported: [2] },
    },
  });
});

function rawCall(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: socketPath });
    socket.setEncoding("utf8");
    let output = "";
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => (output += chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(JSON.parse(output)));
  });
}
