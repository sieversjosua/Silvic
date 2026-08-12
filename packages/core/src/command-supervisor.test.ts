import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandSupervisor, needsProxy } from "./command-supervisor";
import type { NamedRoutePublisher } from "./named-route";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("needsProxy", () => {
  it("recognises the non-interactive macOS privilege failure", () => {
    expect(
      needsProxy(
        [
          "Starting proxy...",
          "Port 443 requires elevated privileges. Requesting sudo...",
          "sudo: a password is required",
        ].join("\n"),
      ),
    ).toBe(true);
  });
});

describe("CommandSupervisor", () => {
  it("does not report a command started before its log is open", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10" },
      routeName: "web-test",
      environment: {},
      canRoute: false,
      detached: false,
    });

    try {
      expect(readdirSync(logDirectory)).toHaveLength(1);
    } finally {
      supervisor.stopAll();
    }
  });

  it("publishes a routed command's real listener before calling it running", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    let finishPublishing: ((value: { port: number }) => void) | undefined;
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn(
        () =>
          new Promise<{ port: number }>((resolve) => {
            finishPublishing = resolve;
          }),
      ),
      healthy: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-monorepo-plot",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });

    expect(supervisor.list()[0]).toMatchObject({
      status: "starting",
      url: "https://web-monorepo-plot.localhost",
    });
    expect(routePublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        routeName: "web-monorepo-plot",
        expectedPort: 8691,
      }),
    );

    finishPublishing?.({ port: 4321 });
    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "running",
        targetPort: 4321,
      }),
    );
    supervisor.stopAll();
  });

  it("announces an empty list when persisted commands are all stale", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const onChange = vi.fn();
    const supervisor = new CommandSupervisor({ logDirectory, onChange });

    await supervisor.adopt([
      {
        plotPath: logDirectory,
        id: "web",
        status: "running",
        processId: 999_999,
        startedAt: new Date().toISOString(),
      },
    ]);

    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("rediscovers a persisted named route when Silvic reopens", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const originalPublisher: NamedRoutePublisher = {
      publish: vi.fn().mockResolvedValue({ port: 4321 }),
      healthy: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const original = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher: originalPublisher,
    });
    await original.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-persisted",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });
    await vi.waitFor(() =>
      expect(original.list()[0]).toMatchObject({
        status: "running",
        targetPort: 4321,
      }),
    );

    const reopenedPublisher: NamedRoutePublisher = {
      publish: vi.fn().mockResolvedValue({ port: 4321 }),
      // Reaching the persisted target proves only that the alias is wired to
      // that port. It can still be the old `OK` sidecar rather than the app.
      healthy: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const reopened = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher: reopenedPublisher,
    });
    await reopened.adopt(original.list());

    await vi.waitFor(() =>
      expect(reopenedPublisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          routeName: "web-persisted",
          processId: original.list()[0]?.processId,
          expectedPort: 8691,
        }),
      ),
    );
    expect(reopenedPublisher.healthy).not.toHaveBeenCalled();
    expect(reopened.list()[0]).toMatchObject({
      status: "running",
      targetPort: 4321,
    });
    expect(reopened.list()[0]).not.toHaveProperty("advice");
    reopened.stopAll();
  });

  it("republishes a named route when its healthy listener changes", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const publish = vi
      .fn<NamedRoutePublisher["publish"]>()
      .mockResolvedValueOnce({ port: 4321 })
      .mockResolvedValueOnce({ port: 4322 });
    const routePublisher: NamedRoutePublisher = {
      publish,
      healthy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher,
      routeHealthIntervalMs: 5,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-moving-listener",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });

    await vi.waitFor(() => expect(supervisor.list()[0]?.targetPort).toBe(4322));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(supervisor.list()[0]?.status).toBe("running");
    supervisor.stopAll();
  });

  it("exposes the stable port URL when named routing is disabled", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const onChange = vi.fn();
    const supervisor = new CommandSupervisor({ logDirectory, onChange });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true, portless: false },
      routeName: "web-test",
      environment: { SILVIC_URL: "http://localhost:3456" },
      canRoute: false,
      detached: false,
    });

    expect(supervisor.list()[0]?.url).toBe("http://localhost:3456");
    supervisor.stopAll();
  });

  it("refuses a named runtime when the HTTPS router is unavailable", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-test",
      environment: { SILVIC_URL: "https://web-test.localhost" },
      canRoute: false,
      detached: false,
    });

    expect(supervisor.list()[0]).toMatchObject({
      id: "web",
      status: "failed",
      exitCode: 1,
      advice: expect.stringMatching(/portless service install/),
    });
  });

  it("forgets a command after it stops cleanly", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: (commands) => {
        if (commands.length === 0) resolveStopped?.();
      },
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "check",
      command: { run: "true" },
      routeName: "check-test",
      environment: {},
      canRoute: false,
      detached: false,
    });
    await stopped;

    expect(supervisor.list()).toEqual([]);
  });

  it("honours a repository command's relative cwd and environment", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    await mkdir(join(logDirectory, "services", "convex"), {
      recursive: true,
    });
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: (commands) => {
        if (commands.length === 0) resolveStopped?.();
      },
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "convex",
      command: {
        run: 'printf "%s|%s" "$CONVEX_PROFILE" "$PWD"',
        cwd: "services/convex",
        env: { CONVEX_PROFILE: "like-photo" },
      },
      routeName: "convex-test",
      environment: {},
      canRoute: false,
      detached: false,
    });
    await stopped;

    expect(await supervisor.output(logDirectory, "convex")).toBe(
      `like-photo|${join(await realpath(logDirectory), "services", "convex")}`,
    );
  });

  it("forgets an explicitly stopped command even when its SIGTERM handler fails", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: (commands) => {
        if (commands.length === 0) resolveStopped?.();
      },
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: {
        run: "trap 'exit 7' TERM; while :; do sleep 1; done",
        url: true,
        portless: false,
      },
      routeName: "web-test",
      environment: { SILVIC_URL: "http://localhost:3456" },
      canRoute: false,
      detached: false,
    });
    supervisor.stopAll();
    await stopped;

    expect(supervisor.list()).toEqual([]);
  });

  it("forgets a routed command stopped while its route is still publishing", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn(() => new Promise<{ port: number }>(() => undefined)),
      healthy: vi.fn().mockResolvedValue(false),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: (commands) => {
        if (commands.length === 0) resolveStopped?.();
      },
      routePublisher,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true, portless: true },
      routeName: "web-test",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });
    supervisor.stopAll();
    await stopped;

    expect(supervisor.list()).toEqual([]);
    expect(routePublisher.remove).toHaveBeenCalledWith("web-test");
  });

  it("escalates to SIGKILL when a stopped command ignores SIGTERM", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const seenStatuses: string[] = [];
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: (commands) => {
        seenStatuses.push(...commands.map((command) => command.status));
        if (commands.length === 0) resolveStopped?.();
      },
      stopPatience: 3,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "trap '' TERM; while :; do sleep 1; done" },
      routeName: "web-test",
      environment: {},
      canRoute: false,
      detached: false,
    });
    supervisor.stopAll();
    await stopped;

    expect(supervisor.list()).toEqual([]);
    // The wait for SIGKILL was visible, not a silent "running" that lied.
    expect(seenStatuses).toContain("stopping");
  });

  it("observes an adopted command exiting after Stop", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const original = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
    });
    await original.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10" },
      routeName: "web-test",
      environment: {},
      canRoute: false,
      detached: false,
    });
    let resolveStopped: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const reopened = new CommandSupervisor({
      logDirectory,
      onChange: (commands) => {
        if (commands.length === 0) resolveStopped?.();
      },
    });
    await reopened.adopt(original.list());

    reopened.stopAll();
    await stopped;

    expect(reopened.list()).toEqual([]);
  });
});
