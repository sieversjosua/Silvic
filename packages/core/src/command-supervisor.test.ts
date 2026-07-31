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

import {
  CommandSupervisor,
  needsProxy,
} from "./command-supervisor";

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

  it("forgets a routed command stopped while its publisher is failing", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const portless = join(logDirectory, "portless");
    await writeFile(
      portless,
      [
        "#!/bin/sh",
        "trap 'exit 9' TERM",
        "echo 'proxy is not running' >&2",
        "sleep 10",
      ].join("\n"),
    );
    await chmod(portless, 0o755);
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
      command: { run: "sleep 10", url: true, portless: true },
      routeName: "web-test",
      environment: { PATH: `${logDirectory}:/bin:/usr/bin` },
      canRoute: true,
      detached: false,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await supervisor.output(logDirectory, "web")).includes("proxy")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await supervisor.output(logDirectory, "web")).toContain(
      "proxy is not running",
    );
    supervisor.stopAll();
    await stopped;

    expect(supervisor.list()).toEqual([]);
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
    reopened.adopt(original.list());

    reopened.stopAll();
    await stopped;

    expect(reopened.list()).toEqual([]);
  });
});
