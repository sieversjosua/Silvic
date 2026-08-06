import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./command-runner";
import { workosEmulatePort } from "./ports";
import { Provisioner, provisionDiagnosis } from "./provisioner";
import {
  workosEmulateCommand,
  workosEmulateVersion,
} from "./workos-provisioner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function plotRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "silvic-workos-"));
  temporaryDirectories.push(root);
  return root;
}

/** Stands in for npx, which only has to prove the emulator is fetchable. */
class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  constructor(private readonly result: Partial<CommandResult> = {}) {}

  run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return Promise.resolve({
      exitCode: 0,
      stdout: `${workosEmulateVersion}\n`,
      stderr: "",
      ...this.result,
    });
  }
}

const context = (root: string) => ({
  root,
  sourceRoot: "/repos/syntwin-mono",
  project: "syntwin-mono",
  plot: "owner-onboarding",
  branch: "feature/owner-onboarding",
  url: "https://web-owner-onboarding-syntwin-mono.localhost",
  port: 3456,
});

describe("WorkOS emulator step", () => {
  it("prepares the pinned emulator and points the app at it", async () => {
    const root = await plotRoot();
    const runner = new RecordingRunner();
    const provisioner = new Provisioner(runner);

    const [step] = await provisioner.run(
      [{ workos: { callbackPath: "/callback" } }],
      context(root),
    );

    expect(step?.label).toBe("WorkOS emulator");
    expect(step?.command).toBe("Silvic emulated WorkOS environment");
    expect(step?.exitCode).toBe(0);
    expect(runner.requests[0]?.executable).toBe("npx");
    expect(runner.requests[0]?.arguments).toEqual([
      "--yes",
      `@workos/emulate@${workosEmulateVersion}`,
      "--version",
    ]);

    const local = await readFile(join(root, ".env.local"), "utf8");
    expect(local).toContain("WORKOS_API_HOSTNAME=localhost");
    expect(local).toContain(`WORKOS_API_PORT=${workosEmulatePort(3456)}`);
    expect(local).toContain("WORKOS_API_HTTPS=false");
    expect(local).toContain("WORKOS_API_KEY=sk_test_default");
    expect(local).toContain("WORKOS_CLIENT_ID=client_emulated");
    expect(local).toContain(
      "NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://web-owner-onboarding-syntwin-mono.localhost/callback",
    );
    const cookiePassword = local.match(/WORKOS_COOKIE_PASSWORD=(\S+)/)?.[1];
    expect(cookiePassword?.length).toBeGreaterThanOrEqual(32);
    // The generated secret is announced, never printed.
    expect(step?.output).toContain("Generated WORKOS_COOKIE_PASSWORD");
    expect(step?.output).not.toContain(cookiePassword);
    expect(step?.output).toContain(
      "Nothing here reaches a real WorkOS environment",
    );
  });

  it("keeps what the app already declared, moving only the origin", async () => {
    const root = await plotRoot();
    await writeFile(
      join(root, ".env.local"),
      [
        "WORKOS_API_KEY=sk_live_very_real",
        "WORKOS_CLIENT_ID=client_from_dashboard",
        "WORKOS_COOKIE_PASSWORD=already-set-and-thirty-two-chars-long",
        "NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/auth/callback?next=1",
        "UNRELATED=kept",
        "",
      ].join("\n"),
    );
    const provisioner = new Provisioner(new RecordingRunner());

    const [step] = await provisioner.run(
      [{ workos: { callbackPath: "/callback" } }],
      context(root),
    );

    expect(step?.exitCode).toBe(0);
    const local = await readFile(join(root, ".env.local"), "utf8");
    // A real key must never point at the emulator's test surface.
    expect(local).not.toContain("sk_live_very_real");
    expect(local).toContain("WORKOS_API_KEY=sk_test_default");
    expect(local).toContain("WORKOS_CLIENT_ID=client_from_dashboard");
    expect(local).toContain(
      "WORKOS_COOKIE_PASSWORD=already-set-and-thirty-two-chars-long",
    );
    expect(local).toContain(
      "NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://web-owner-onboarding-syntwin-mono.localhost/auth/callback?next=1",
    );
    expect(local).toContain("UNRELATED=kept");
  });

  it("lets the step name its own port", async () => {
    const root = await plotRoot();
    const provisioner = new Provisioner(new RecordingRunner());

    const [step] = await provisioner.run(
      [{ workos: { port: 4100, callbackPath: "/callback" } }],
      context(root),
    );

    expect(step?.exitCode).toBe(0);
    const local = await readFile(join(root, ".env.local"), "utf8");
    expect(local).toContain("WORKOS_API_PORT=4100");
  });

  it("fails plainly when no port can be known", async () => {
    const root = await plotRoot();
    const provisioner = new Provisioner(new RecordingRunner());
    const { port: _port, ...portless } = context(root);

    const [step] = await provisioner.run(
      [{ workos: { callbackPath: "/callback" } }],
      portless,
    );

    expect(step?.exitCode).toBe(1);
    expect(step?.output).toContain("No emulator port");
  });

  it("fails at preparation rather than leaving a dead runtime later", async () => {
    const root = await plotRoot();
    const provisioner = new Provisioner(
      new RecordingRunner({
        exitCode: 1,
        stdout: "",
        stderr: "npm error code ENOTFOUND registry.npmjs.org",
      }),
    );

    const [step] = await provisioner.run(
      [{ workos: { callbackPath: "/callback" } }],
      context(root),
    );

    expect(step?.exitCode).toBe(1);
    expect(step?.output).toContain("Preparing the WorkOS emulator failed");
    expect(step?.advice).toContain("network");
    // Nothing was rewritten for an emulator that cannot run.
    await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toThrow();
  });

  it("recognises an offline fetch, and only that", () => {
    const step = { workos: { callbackPath: "/callback" } };

    expect(
      provisionDiagnosis(step, "npm error ENOTFOUND registry.npmjs.org")
        ?.advice,
    ).toContain("npx caches it");
    expect(provisionDiagnosis(step, "some other failure")).toBeUndefined();
  });
});

describe("workosEmulatePort", () => {
  it("derives a stable port past the plot range", () => {
    expect(workosEmulatePort(3456)).toBe(23456);
    // Plot ports live in [3000, 9000), so the emulator stays below the
    // ephemeral range and clear of every plot's own address.
    expect(workosEmulatePort(8999)).toBeLessThan(32768);
  });
});

describe("workosEmulateCommand", () => {
  it("pins the version and leaves the port to the plot's environment", () => {
    const command = workosEmulateCommand();

    expect(command).toContain(`@workos/emulate@${workosEmulateVersion}`);
    expect(command).toContain('--port "$SILVIC_WORKOS_PORT"');
    expect(command).toContain("--interactive");
    expect(command).not.toContain("--seed");
  });

  it("carries the repository's seed file when it has one", () => {
    expect(workosEmulateCommand("workos.emulate.yaml")).toContain(
      '--seed "workos.emulate.yaml"',
    );
  });
});
