import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandSupervisor, type StartRequest } from "./command-supervisor";
import {
  ExternalRuntimeConflict,
  GateUnreachable,
  type NamedRoutePublisher,
  type PublishNamedRouteRequest,
} from "./named-route";

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

  it("gives persistent commands file-backed output instead of app-owned pipes", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const supervisor = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
    });
    const inspectDescriptors = [
      'const fs = require("node:fs")',
      'console.log("stdout-file=" + fs.fstatSync(1).isFile())',
      'console.error("stderr-file=" + fs.fstatSync(2).isFile())',
      "setInterval(() => {}, 1000)",
    ].join(";");

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: {
        run: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(inspectDescriptors)}`,
      },
      routeName: "web-persistent-log",
      environment: {},
      canRoute: false,
      detached: true,
    });

    try {
      await vi.waitFor(async () => {
        const output = await supervisor.output(logDirectory, "web");
        expect(output).toContain("stdout-file=true");
        expect(output).toContain("stderr-file=true");
      });
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

  it("attaches a degraded external server and keeps Start idempotent", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    let finishPublishing: (() => void) | undefined;
    let publishRequest: PublishNamedRouteRequest | undefined;
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn(
        (request: PublishNamedRouteRequest) =>
          new Promise<{
            port: number;
            ownership: "external";
            externalProcessId: number;
            httpStatus: number;
          }>((resolve) => {
            publishRequest = request;
            finishPublishing = () =>
              resolve({
                port: 4375,
                ownership: "external",
                externalProcessId: 16056,
                httpStatus: 500,
              });
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
    const request: StartRequest = {
      plotPath: logDirectory,
      id: "web",
      command: {
        run: 'printf "Another astro dev server is already running.\\nURL: http://127.0.0.1:4375\\nPID: 16056\\n"; exit 1',
        url: true,
      },
      routeName: "web-degraded",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    };

    await supervisor.start(request);
    // The regression's exact race: the launcher exits nonzero while route
    // discovery is still deciding. `abandoned` observing the pending exit is
    // the supervisor's own signal that the exit has been parked.
    await vi.waitFor(() => expect(publishRequest?.abandoned?.()).toBe(true));
    finishPublishing?.();

    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "running",
        ownership: "external",
        externalProcessId: 16056,
        targetPort: 4375,
        // Attachment and readiness are separate: the runtime is attached
        // while the HTTP 500 stays visible as a diagnostic.
        advice: expect.stringContaining("HTTP 500"),
        notice: expect.stringContaining("externally managed"),
      }),
    );
    expect(supervisor.list()[0]).not.toHaveProperty("processId");

    // Start again: an attached runtime is already running, so nothing may
    // launch a second, competing process.
    await supervisor.start(request);
    expect(routePublisher.publish).toHaveBeenCalledTimes(1);
    expect(supervisor.list()).toHaveLength(1);

    supervisor.stop(logDirectory, "web");
    expect(supervisor.list()).toEqual([]);
    expect(routePublisher.remove).toHaveBeenCalledWith("web-degraded");
  });

  it("turns an unverifiable duplicate server into an actionable failure", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    let refusePublishing: ((error: Error) => void) | undefined;
    let publishRequest: PublishNamedRouteRequest | undefined;
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn(
        (request: PublishNamedRouteRequest) =>
          new Promise<never>((_resolve, reject) => {
            publishRequest = request;
            refusePublishing = reject;
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
        run: 'printf "Another astro dev server is already running.\\nURL: http://[::1]:4328\\nPID: 90210\\n"; exit 1',
        url: true,
      },
      routeName: "web-foreign",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });
    await vi.waitFor(() => expect(publishRequest?.abandoned?.()).toBe(true));
    refusePublishing?.(
      new ExternalRuntimeConflict(
        "The launcher reported an already-running dev server at http://[::1]:4328 (PID 90210), but process 90210 runs in /worktrees/prototype-grow-v1-owner-flow, which is not inside this plot, so Silvic refused to give it web-foreign.localhost.",
      ),
    );

    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "failed",
        exitCode: 1,
        advice: expect.stringContaining("refused to give it"),
      }),
    );
    expect(supervisor.list()[0]).not.toHaveProperty("ownership");
    expect(supervisor.list()[0]).not.toHaveProperty("processId");
  });

  it("settles an adopted preview whose process died instead of rerouting it", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn().mockResolvedValue({ port: 4321 }),
      improve: vi.fn().mockResolvedValue(undefined),
      healthy: vi.fn().mockResolvedValue(true),
      diagnose: vi.fn().mockResolvedValue({ status: "healthy" }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const original = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher,
    });
    await original.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 30", url: true },
      routeName: "web-adopted-dead",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: true,
    });
    await vi.waitFor(() =>
      expect(original.list()[0]).toMatchObject({
        status: "running",
        targetPort: 4321,
      }),
    );
    const entries = original.list();
    const processId = entries[0]!.processId!;

    const reopened = new CommandSupervisor({
      logDirectory,
      onChange: () => {},
      routePublisher,
      routeHealthIntervalMs: 50,
    });
    await reopened.adopt(entries);
    await vi.waitFor(() => expect(reopened.list()[0]?.status).toBe("running"));

    process.kill(-processId, "SIGKILL");

    // An adopted process has no close event; only the health check can see
    // its death. It must settle the runtime — never go hunting for whatever
    // now sits on the old port with a stale log tail.
    await vi.waitFor(
      () =>
        expect(reopened.list()[0]).toMatchObject({
          status: "failed",
          advice: expect.stringContaining("gone"),
        }),
      { timeout: 5_000 },
    );
    expect(routePublisher.publish).toHaveBeenCalledTimes(1);
    expect(routePublisher.remove).toHaveBeenCalledWith("web-adopted-dead");
  });

  it("stops a stale external Astro server, rebuilds, and starts again", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const astro = join(logDirectory, "node_modules", ".bin", "astro");
    const stopped = join(logDirectory, "external-astro-stopped");
    const cache = join(logDirectory, "node_modules", ".vite", "deps_ssr");
    await mkdir(join(logDirectory, "node_modules", ".bin"), {
      recursive: true,
    });
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "astro-entry.js"), "stale");
    await writeFile(astro, `#!/bin/sh\ntouch ${JSON.stringify(stopped)}\n`);
    await chmod(astro, 0o755);
    const publish = vi
      .fn<NamedRoutePublisher["publish"]>()
      .mockImplementationOnce(async ({ output }) => {
        await vi.waitFor(() =>
          expect(output()).toContain(
            "Another astro dev server is already running",
          ),
        );
        return {
          port: 4060,
          ownership: "external",
          failure: "vite-stale-optimized-dependency",
        };
      })
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
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: {
        run: [
          `if test -f ${JSON.stringify(stopped)}; then sleep 10; else`,
          "printf 'Another astro dev server is already running.\\n\\n  URL:  http://127.0.0.1:4060\\n  PID:  12345\\n\\nRun `astro dev stop` to stop it.\\n'",
          "exit 1",
          "fi",
        ].join("\n"),
        url: true,
      },
      routeName: "web-stale-external",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () =>
        expect(supervisor.list()[0]).toMatchObject({
          status: "running",
          targetPort: 4321,
          notice: expect.stringContaining(
            "stopped the stale external Astro server",
          ),
        }),
      { timeout: 5_000 },
    );
    expect(existsSync(stopped)).toBe(true);
    expect(existsSync(join(logDirectory, "node_modules", ".vite"))).toBe(false);
    expect(routePublisher.remove).toHaveBeenCalledWith("web-stale-external");
    supervisor.stopAll();
  });

  it("does not stop an unrecognized external server automatically", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const routePublisher: NamedRoutePublisher = {
      publish: vi.fn().mockResolvedValue({
        port: 4060,
        ownership: "external",
        failure: "vite-stale-optimized-dependency",
      }),
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
        run: 'printf "URL: http://127.0.0.1:4060\\n"; exit 1',
        url: true,
      },
      routeName: "web-stale-unknown",
      environment: { PORT: "8691" },
      canRoute: true,
      detached: false,
    });

    await vi.waitFor(() =>
      expect(supervisor.list()[0]).toMatchObject({
        status: "failed",
        ownership: "external",
        advice: expect.stringContaining("could not stop"),
      }),
    );
    expect(routePublisher.remove).toHaveBeenCalledWith("web-stale-unknown");
  });

  it("rebuilds immediately when initial route discovery finds stale Vite", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const cache = join(logDirectory, "node_modules", ".vite", "deps_ssr");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "astro-entry.js"), "stale");
    const publish = vi
      .fn()
      .mockResolvedValueOnce({
        port: 4321,
        failure: "vite-stale-optimized-dependency",
      })
      .mockResolvedValue({ port: 4321 });
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
      routeHealthIntervalMs: 60_000,
    });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-stale-initial",
      environment: { PORT: "4321" },
      canRoute: true,
      detached: false,
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () =>
        expect(supervisor.list()[0]).toMatchObject({
          status: "running",
          notice: expect.stringContaining("rebuilt the Vite cache"),
        }),
      { timeout: 5_000 },
    );
    expect(existsSync(join(logDirectory, "node_modules", ".vite"))).toBe(false);
    supervisor.stopAll();
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

  it("keeps a healthy persisted named route untouched when Silvic reopens", async () => {
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
      expect(reopenedPublisher.healthy).toHaveBeenCalledWith({
        routeName: "web-persisted",
        port: 4321,
      }),
    );
    expect(reopenedPublisher.publish).not.toHaveBeenCalled();
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

  it("clears Vite caches before restarting after a stale dependency failure", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const commandDirectory = join(logDirectory, "apps", "web");
    const rootViteCache = join(logDirectory, "node_modules", ".vite");
    const commandViteCache = join(
      commandDirectory,
      "node_modules",
      ".cache",
      "vite",
    );
    const dependencyMarker = join(
      logDirectory,
      "node_modules",
      "kept-package.txt",
    );
    await Promise.all([
      mkdir(join(rootViteCache, "deps_ssr"), { recursive: true }),
      mkdir(join(commandViteCache, "deps"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(rootViteCache, "deps_ssr", "astro-entry.js"), "stale"),
      writeFile(join(commandViteCache, "deps", "react.js"), "stale"),
      writeFile(dependencyMarker, "keep"),
    ]);
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
      command: { run: "sleep 10", cwd: "apps/web", url: true },
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
    expect(existsSync(rootViteCache)).toBe(false);
    expect(existsSync(commandViteCache)).toBe(false);
    expect(existsSync(dependencyMarker)).toBe(true);
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
          advice: expect.stringContaining("rebuilt its generated Vite cache"),
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
