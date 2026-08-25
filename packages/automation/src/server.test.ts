import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
