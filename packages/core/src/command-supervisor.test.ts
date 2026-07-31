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

import { CommandSupervisor, routeNameFor, routes } from "./command-supervisor";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("routes", () => {
  it("only publishes when a recipe explicitly opts into portless", () => {
    expect(routes({ run: "npm run dev", url: true })).toBe(false);
    expect(routes({ run: "npm run dev", url: true, portless: true })).toBe(
      true,
    );
  });

  it("leaves everything else where it is", () => {
    expect(routes({ run: "npm run test:watch" })).toBe(false);
    // Serving, but the project asked for the port it was given instead.
    expect(routes({ run: "npm run dev", url: true, portless: false })).toBe(
      false,
    );
  });
});

describe("CommandSupervisor", () => {
  it("exposes the stable plot URL when a serving command runs directly", async () => {
    const logDirectory = await mkdtemp(join(tmpdir(), "silvic-supervisor-"));
    temporaryDirectories.push(logDirectory);
    const onChange = vi.fn();
    const supervisor = new CommandSupervisor({ logDirectory, onChange });

    await supervisor.start({
      plotPath: logDirectory,
      id: "web",
      command: { run: "sleep 10", url: true },
      routeName: "web-test",
      environment: { SILVIC_URL: "http://localhost:3456" },
      canRoute: false,
      detached: false,
    });

    expect(supervisor.list()[0]?.url).toBe("http://localhost:3456");
    supervisor.stopAll();
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

  it("does not launch the direct fallback after a routed command was stopped", async () => {
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

describe("routeNameFor", () => {
  it("names a command the way work already does on this machine", () => {
    expect(routeNameFor({ id: "web" }, "feature-x", "tilly")).toBe(
      "web-feature-x-tilly",
    );
  });

  it("takes the recipe's own segment when it gives one", () => {
    expect(
      routeNameFor({ id: "web", routeName: "app" }, "feature-x", "tilly"),
    ).toBe("app-feature-x-tilly");
  });

  it("keeps a single label, since a wildcard certificate covers one level", () => {
    const name = routeNameFor({ id: "web" }, "feat/Slashed", "My Project");

    expect(name).toBe("web-feat-slashed-my-project");
    expect(name).not.toContain(".");
  });
});
