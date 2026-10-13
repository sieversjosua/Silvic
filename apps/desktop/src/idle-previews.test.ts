import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandRunner, SupervisedCommand } from "@silvic/core";
import type { GateRoute } from "@silvic/gate";

import { IdlePreviews } from "./idle-previews";

const minute = 60_000;
const openedAt = Date.parse("2026-10-12T10:00:00Z");

function fixture() {
  let minutes = 30;
  let commands: SupervisedCommand[] = [
    {
      plotPath: "/plots/shop",
      id: "web",
      processId: 42,
      status: "running",
      routeName: "web-shop",
      targetPort: 4321,
      startedAt: new Date(openedAt).toISOString(),
    },
  ];
  let routes: GateRoute[] | undefined = [
    {
      name: "web-shop",
      port: 4321,
      updatedAt: new Date(openedAt).toISOString(),
      lastActivityAt: openedAt,
      activeConnections: 0,
    },
  ];
  let protectedPaths = new Set<string>();
  const run = vi.fn<CommandRunner["run"]>().mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  const stop = vi.fn((command: SupervisedCommand) => {
    commands = commands.filter((entry) => entry !== command);
    previews.synchronize();
  });
  const readRoutes = vi.fn(async () => routes);
  const previews = new IdlePreviews({
    minutes: () => minutes,
    commands: () => commands,
    routes: readRoutes,
    protectedPaths: async () => protectedPaths,
    runner: { run },
    stop,
  });
  previews.synchronize();
  return {
    previews,
    stop,
    run,
    readRoutes,
    setMinutes: (value: number) => {
      minutes = value;
      previews.synchronize();
    },
    setCommands: (value: SupervisedCommand[]) => {
      commands = value;
      previews.synchronize();
    },
    setRoutes: (value: GateRoute[] | undefined) => {
      routes = value;
    },
    setProtected: (value: Set<string>) => {
      protectedPaths = value;
    },
    commands: () => commands,
    routes: () => routes,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(openedAt);
});
afterEach(() => vi.useRealTimers());

describe("idle previews", () => {
  it("stops an unused owned preview after the timeout and removes its timer", async () => {
    const state = fixture();
    await vi.advanceTimersByTimeAsync(29 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).toHaveBeenCalledWith(
      expect.objectContaining({ processId: 42 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps open connections alive and gives a completed request a fresh idle period", async () => {
    const state = fixture();
    const route = state.routes()?.[0];
    if (!route) throw new Error("Missing test route");
    route.activeConnections = 1;
    await vi.advanceTimersByTimeAsync(40 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    route.activeConnections = 0;
    route.lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(29 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("protects active agent work and waits a full timeout after it ends", async () => {
    const state = fixture();
    state.setProtected(new Set(["/plots/shop"]));
    await vi.advanceTimersByTimeAsync(35 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    state.setProtected(new Set());
    await vi.advanceTimersByTimeAsync(29 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("starts the idle period after a short job that finishes before the first timeout", async () => {
    const state = fixture();
    await vi.advanceTimersByTimeAsync(10 * minute);
    state.setProtected(new Set(["/plots/shop"]));
    await vi.advanceTimersByTimeAsync(19 * minute);
    state.setProtected(new Set());
    await vi.advanceTimersByTimeAsync(29 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("protects CI and test jobs running inside the preview's worktree", async () => {
    const state = fixture();
    state.run.mockImplementation(async (request) => ({
      exitCode: 0,
      stderr: "",
      stdout:
        request.executable === "ps"
          ? "101 bun run ci\n102 node /tools/playwright/cli.js test\n"
          : "p101\nn/plots/shop/packages/frontend\np102\nn/plots/other\n",
    }));
    await vi.advanceTimersByTimeAsync(35 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    state.run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("does not stop on unavailable usage, an older gate, or a failed process scan", async () => {
    const state = fixture();
    state.setRoutes(undefined);
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    state.setRoutes([
      { name: "web-shop", port: 4321, updatedAt: new Date().toISOString() },
    ]);
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).not.toHaveBeenCalled();
    state.setRoutes([
      {
        name: "web-shop",
        port: 4321,
        updatedAt: new Date().toISOString(),
        lastActivityAt: openedAt,
        activeConnections: 0,
      },
    ]);
    state.run.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Unavailable",
    });
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).not.toHaveBeenCalled();
  });

  it("rechecks browser activity that arrived during the job scan", async () => {
    const state = fixture();
    state.run.mockImplementation(async () => {
      const route = state.routes()?.[0];
      if (route) route.lastActivityAt = Date.now();
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(state.stop).not.toHaveBeenCalled();
  });

  it("leaves external servers and unrouted services alone", async () => {
    const state = fixture();
    const command = state.commands()[0];
    if (!command) throw new Error("Missing test command");
    state.setCommands([
      { ...command, ownership: "external" },
      {
        plotPath: "/plots/shop",
        id: "convex",
        status: "running",
        processId: 44,
      },
    ]);
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be disabled, re-enabled, and closed without stopping a preview", async () => {
    const state = fixture();
    state.setMinutes(0);
    await vi.advanceTimersByTimeAsync(60 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    state.setMinutes(15);
    state.previews.close();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes auto-stop when re-enabled", async () => {
    const state = fixture();
    state.setMinutes(0);
    await vi.advanceTimersByTimeAsync(20 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    state.setMinutes(30);
    await vi.advanceTimersByTimeAsync(9 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight check when disabled or closed", async () => {
    const state = fixture();
    state.run.mockImplementation(async () => {
      state.setMinutes(0);
      state.previews.close();
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await vi.advanceTimersByTimeAsync(30 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows time after app startup to reclaim previews left running before quit", async () => {
    const state = fixture();
    const command = state.commands()[0];
    if (!command) throw new Error("Missing test command");
    state.setCommands([{ ...command, startedAt: "2026-10-01T00:00:00Z" }]);
    const route = state.routes()?.[0];
    if (route) route.lastActivityAt = Date.parse("2026-10-01T00:00:00Z");
    await vi.advanceTimersByTimeAsync(29 * minute);
    expect(state.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minute);
    expect(state.stop).toHaveBeenCalledOnce();
  });
});
