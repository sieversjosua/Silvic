import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandSupervisor } from "./command-supervisor";
import { GateUnreachable, type NamedRoutePublisher } from "./named-route";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
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
      improve: vi.fn().mockResolvedValue(undefined),
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

  it("attaches a healthy external URL after its launcher has exited nonzero", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    let finishPublishing: (() => void) | undefined;
    let announcedOutput: (() => string) | undefined;
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn(
        ({ output }) =>
          new Promise<{ port: number; ownership: "external" }>((resolve) => {
            announcedOutput = output;
            finishPublishing = () =>
              resolve({ port: 4060, ownership: "external" });
          }),
      ),
      improve: vi.fn().mockResolvedValue(undefined),
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
      command: {
        run: 'printf "Another server is already running. URL: http://127.0.0.1:4060\\n"; exit 1',
        url: true,
      },
      routeName: "web-external",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });
    const launcherPid = supervisor.list()[0]?.processId;

    await vi.waitFor(() =>
      expect(announcedOutput?.()).toContain("http://127.0.0.1:4060"),
    );
    await vi.waitFor(() =>
      expect(() => process.kill(launcherPid!, 0)).toThrow(),
    );
    expect(supervisor.list()[0]?.status).toBe("starting");

    finishPublishing?.();
    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "running",
        targetPort: 4060,
        ownership: "external",
        notice: expect.stringContaining("externally managed"),
      }),
    );
    expect(supervisor.list()[0]).not.toHaveProperty("processId");
    expect(supervisor.list()[0]).not.toHaveProperty("exitCode");

    const kill = vi.spyOn(process, "kill");
    try {
      supervisor.stop(logDirectory, "web");
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
    expect(supervisor.list()).toEqual([]);
    expect(routePublisher.remove).toHaveBeenCalledWith("web-external");
  });

  it("fails a nonzero launcher when its announced URL is unhealthy", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn(async ({ output }) => {
        await vi.waitFor(() =>
          expect(output()).toContain("http://127.0.0.1:4061"),
        );
        throw new Error("The announced URL did not serve a browser page.");
      }),
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(false),
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
      command: {
        run: 'printf "URL: http://127.0.0.1:4061\\n"; exit 1',
        url: true,
      },
      routeName: "web-unhealthy",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });

    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "failed",
        exitCode: 1,
      }),
    );
    expect(supervisor.list()[0]).not.toHaveProperty("ownership");
    expect(routePublisher.remove).toHaveBeenCalledWith("web-unhealthy");
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
      improve: vi.fn().mockResolvedValue(undefined),
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
      improve: vi.fn().mockResolvedValue(undefined),
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
      improve: vi.fn().mockResolvedValue(undefined),
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

  it("restarts once and returns to running after a stale Vite failure", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const onChange = vi.fn();
    const publish = vi.fn().mockResolvedValue({ port: 4321 });
    const diagnose = vi
      .fn<NonNullable<NamedRoutePublisher["diagnose"]>>()
      .mockResolvedValue({ status: "healthy", httpStatus: 200 });
    const routePublisher: NamedRoutePublisher = {
      publish,
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(true),
      diagnose,
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange,
      routePublisher,
      routeHealthIntervalMs: 5,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-vite-recovery",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });
    await vi.waitFor(() =>
      expect(supervisor.list()[0]?.status).toBe("running"),
    );
    const originalProcessId = supervisor.list()[0]?.processId;
    supervisor.reportRouteFailure(
      "web-vite-recovery",
      "vite-stale-optimized-dependency",
    );

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () =>
        expect(supervisor.list()[0]).toMatchObject({
          status: "running",
          notice: expect.stringContaining("recovered the preview"),
        }),
      { timeout: 5_000 },
    );
    expect(supervisor.list()[0]?.processId).not.toBe(originalProcessId);
    expect(supervisor.list()[0]).not.toHaveProperty("recoveryAttempts");
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ recoveryAttempts: 1 }),
    ]);
    supervisor.stopAll();
  });

  it("degrades after the restarted preview repeats the Vite failure", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const publish = vi.fn().mockResolvedValue({ port: 4321 });
    const routePublisher: NamedRoutePublisher = {
      publish,
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(true),
      diagnose: vi
        .fn()
        .mockResolvedValue({ status: "healthy", httpStatus: 200 }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher,
      routeHealthIntervalMs: 10_000,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-vite-loop",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });
    await vi.waitFor(() =>
      expect(supervisor.list()[0]?.status).toBe("running"),
    );
    supervisor.reportRouteFailure(
      "web-vite-loop",
      "vite-stale-optimized-dependency",
    );
    await vi.waitFor(
      () =>
        expect(supervisor.list()[0]).toMatchObject({
          status: "running",
          recoveryAttempts: 1,
        }),
      { timeout: 5_000 },
    );
    supervisor.reportRouteFailure(
      "web-vite-loop",
      "vite-stale-optimized-dependency",
    );

    await vi.waitFor(
      () =>
        expect(supervisor.list()[0]).toMatchObject({
          status: "failed",
          advice: expect.stringContaining("Rebuild the Vite cache"),
        }),
      { timeout: 5_000 },
    );
    expect(supervisor.list()[0]).not.toHaveProperty("processId");
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("leaves an unrelated application 500 running", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const publish = vi.fn().mockResolvedValue({ port: 4321 });
    const diagnose = vi
      .fn()
      .mockResolvedValue({ status: "healthy", httpStatus: 500 });
    const routePublisher: NamedRoutePublisher = {
      publish,
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(true),
      diagnose,
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
      routeName: "web-app-error",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });
    const processId = supervisor.list()[0]?.processId;
    await vi.waitFor(() => expect(diagnose).toHaveBeenCalled());

    expect(supervisor.list()[0]).toMatchObject({
      status: "running",
      processId,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    supervisor.stopAll();
  });

  it("keeps a slow dev server running instead of killing what works", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const publish = vi
      .fn<NamedRoutePublisher["publish"]>()
      .mockRejectedValueOnce(new Error("web-slow has not served a page yet"))
      .mockResolvedValue({ port: 4321 });
    const routePublisher: NamedRoutePublisher = {
      publish,
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(true),
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
      routeName: "web-slow",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });

    // A dev server that has not compiled yet is a slow start, not a failure:
    // the process must survive to become the thing Silvic was waiting for.
    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "running",
        advice: expect.stringContaining("has not served a page yet"),
      }),
    );
    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({ targetPort: 4321 }),
    );
    expect(supervisor.list()[0]).not.toHaveProperty("advice");
    supervisor.stopAll();
  });

  it("keeps a running command when only the gate is missing", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const publish = vi
      .fn<NamedRoutePublisher["publish"]>()
      .mockRejectedValueOnce(
        new GateUnreachable("web-lost-gate.localhost has no address yet"),
      )
      .mockResolvedValue({ port: 4321 });
    const routePublisher: NamedRoutePublisher = {
      publish,
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(false),
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
      routeName: "web-lost-gate",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });

    // The dev server survives the outage, says why, and is republished as
    // soon as the daemon answers again.
    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "running",
        advice: expect.stringContaining("no address yet"),
      }),
    );
    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "running",
        targetPort: 4321,
      }),
    );
    expect(supervisor.list()[0]).not.toHaveProperty("advice");
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
      advice: expect.stringMatching(/one-time HTTPS setup/),
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
      improve: vi.fn().mockResolvedValue(undefined),
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
