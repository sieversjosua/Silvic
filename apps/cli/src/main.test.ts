import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeAll, expect, it } from "vitest";

import {
  AutomationError,
  startAutomationServer,
  type AutomationRequest,
  type AutomationServer,
} from "@silvic/automation";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const executable = resolve(repositoryRoot, "apps/cli/dist/silvic.mjs");
const directories: string[] = [];
let server: AutomationServer | undefined;

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@silvic/cli", "build"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("writes one versioned JSON document and keeps stderr clean", async () => {
  const directory = await serve(async () => ({
    roots: ["/projects"],
    projects: [
      {
        id: "project_123",
        name: "Silvic",
        rootPath: "/projects/Silvic",
        plots: [],
      },
    ],
    refreshedAt: "2026-08-25T12:00:00.000Z",
  }));

  const result = await executeFile(executable, ["projects", "--json"], {
    env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
  });

  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    ok: true,
    result: {
      roots: ["/projects"],
      projects: [
        {
          id: "project_123",
          name: "Silvic",
          rootPath: "/projects/Silvic",
          plotCount: 0,
        },
      ],
    },
  });
});

it("maps not-found failures to exit 4 with structured stdout", async () => {
  const directory = await serve(async () => {
    throw new AutomationError(
      "PLOT_NOT_FOUND",
      "No watched Plot matches missing.",
    );
  });

  const failure = await executeFailure(
    ["status", "--plot", "missing", "--json"],
    directory,
  );

  expect(failure.code).toBe(4);
  expect(failure.stderr).toBe("");
  expect(JSON.parse(failure.stdout)).toEqual({
    schemaVersion: 1,
    ok: false,
    error: {
      code: "PLOT_NOT_FOUND",
      message: "No watched Plot matches missing.",
    },
  });
});

it("uses exit 6 for a parseable partial runtime result", async () => {
  const directory = await serve(async () => ({
    results: [
      { runtimeId: "web", action: "started" },
      { runtimeId: "worker", action: "failed", message: "Exited with code 1" },
    ],
    plot: { id: "plot_123" },
    partialFailure: true,
  }));

  const failure = await executeFailure(
    ["start", "--plot", "plot_123", "--json"],
    directory,
  );

  expect(failure.code).toBe(6);
  expect(JSON.parse(failure.stdout)).toMatchObject({
    schemaVersion: 1,
    ok: true,
    result: { partialFailure: true },
  });
});

async function serve(
  handle: (request: AutomationRequest) => Promise<unknown>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "silvic-cli-"));
  directories.push(directory);
  server = await startAutomationServer({
    socketPath: join(directory, "automation.sock"),
    handle,
  });
  return directory;
}

async function executeFailure(args: readonly string[], directory: string) {
  try {
    await executeFile(executable, [...args], {
      env: { ...process.env, SILVIC_AUTOMATION_DIR: directory },
    });
    throw new Error("Command unexpectedly succeeded");
  } catch (error) {
    return error as Error & {
      code: number;
      stdout: string;
      stderr: string;
    };
  }
}
