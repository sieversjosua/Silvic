import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  PlotCommand,
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";
import type { SupervisedCommand } from "@silvic/core";

import {
  AutomationController,
  AutomationError,
  lifecycleState,
  type AutomationRuntime,
} from "./index";
import {
  automationProtocolVersion,
  type AutomationMethod,
  type AutomationRequest,
} from "./protocol";

const plot: WorkspaceSnapshot = {
  workspaceId: "plot_stable_123",
  projectId: "project_stable_456",
  name: "Issue 9",
  path: join(tmpdir(), "silvic-issue-9"),
  repositoryName: "Silvic",
  branch: "feat/issue-9",
  locationKind: "worktree",
  isPrimary: false,
  git: {
    branch: "feat/issue-9",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  },
  observations: [],
};

const project: ProjectSnapshot = {
  id: plot.projectId,
  name: "Silvic",
  rootPath: join(tmpdir(), "Silvic"),
  workspaces: [plot],
  branches: [plot.branch],
  remoteBranches: [],
};

const snapshot: SilvicSnapshot = {
  projects: [project],
  connectorFailures: [],
  refreshedAt: "2026-08-25T12:00:00.000Z",
};

const commands: Readonly<Record<string, PlotCommand>> = {
  web: { run: "pnpm dev", url: true },
  worker: { run: "pnpm worker" },
};

function request(
  method: AutomationMethod,
  params: Record<string, unknown>,
): AutomationRequest {
  return {
    jsonrpc: "2.0",
    protocolVersion: automationProtocolVersion,
    id: "test-request",
    method,
    params,
  };
}

function controller(
  options: {
    processes?: readonly SupervisedCommand[];
    start?: (plotPath: string, runtimeId: string) => Promise<void>;
    stop?: (plotPath: string, runtimeId: string) => void;
    probe?: (url: string) => Promise<boolean>;
    wait?: (milliseconds: number) => Promise<void>;
    now?: () => number;
  } = {},
) {
  return new AutomationController({
    snapshot: () => snapshot,
    roots: () => [project.rootPath],
    definition: async () => ({
      commands,
      previewUrl: "https://web-issue-9-silvic.localhost",
    }),
    processes: () => options.processes ?? [],
    start: options.start ?? (async () => undefined),
    stop: options.stop ?? (() => undefined),
    output: async (_plotPath, runtimeId) => `${runtimeId} output`,
    probe: options.probe ?? (async () => true),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

describe("automation lifecycle states", () => {
  const runtime = (
    id: string,
    status: AutomationRuntime["status"],
    ownership: AutomationRuntime["ownership"] = "silvic",
  ): AutomationRuntime => ({
    id,
    status,
    ownership,
    servesPreview: id === "web",
  });

  it.each([
    ["stopped", [runtime("web", "stopped"), runtime("worker", "stopped")]],
    ["starting", [runtime("web", "starting"), runtime("worker", "starting")]],
    ["ready", [runtime("web", "running"), runtime("worker", "running")]],
    ["failed", [runtime("web", "failed"), runtime("worker", "failed")]],
    [
      "partially-running",
      [runtime("web", "running"), runtime("worker", "failed")],
    ],
  ] as const)("reports %s", (expected, runtimes) => {
    expect(lifecycleState(runtimes)).toBe(expected);
  });

  it("makes external ownership visible in ready status", async () => {
    const status = await controller({
      processes: [
        {
          plotPath: plot.path,
          id: "web",
          status: "running",
          ownership: "external",
          url: "https://web-issue-9-silvic.localhost",
        },
        { plotPath: plot.path, id: "worker", status: "running", processId: 91 },
      ],
    }).handle(request("status", { plot: plot.workspaceId }));

    expect(status).toMatchObject({
      id: plot.workspaceId,
      state: "ready",
      runtimes: [
        { id: "web", ownership: "external" },
        { id: "worker", ownership: "silvic" },
      ],
    });
  });
});

describe("automation operations", () => {
  it("starts every runtime idempotently and reports partial failures", async () => {
    const start = vi.fn(async (_plotPath: string, runtimeId: string) => {
      if (runtimeId === "worker")
        throw new Error("worker configuration failed");
    });
    const result = await controller({
      processes: [
        { plotPath: plot.path, id: "web", status: "running", processId: 41 },
      ],
      start,
    }).handle(request("start", { plot: plot.workspaceId }));

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(plot.path, "worker");
    expect(result).toMatchObject({
      partialFailure: true,
      results: [
        { runtimeId: "web", action: "already-running" },
        {
          runtimeId: "worker",
          action: "failed",
          message: "worker configuration failed",
        },
      ],
    });
  });

  it("detaches an external runtime without claiming to stop its process", async () => {
    const stop = vi.fn();
    const result = await controller({
      processes: [
        {
          plotPath: plot.path,
          id: "web",
          status: "running",
          ownership: "external",
          targetPort: 4_321,
        },
      ],
      stop,
    }).handle(request("stop", { plot: plot.workspaceId, runtime: "web" }));

    expect(stop).toHaveBeenCalledWith(plot.path, "web");
    expect(result).toMatchObject({
      partialFailure: false,
      results: [
        { runtimeId: "web", action: "detached", ownership: "external" },
      ],
    });
  });

  it("waits for an in-flight stop before satisfying a start", async () => {
    let tick = 0;
    const processes: SupervisedCommand[] = [
      { plotPath: plot.path, id: "web", status: "stopping", processId: 71 },
    ];
    const start = vi.fn(async () => undefined);
    const result = await controller({
      processes,
      start,
      now: () => tick,
      wait: async (milliseconds) => {
        tick += milliseconds;
        processes.splice(0);
      },
    }).handle(request("start", { plot: plot.workspaceId, runtime: "web" }));

    expect(start).toHaveBeenCalledWith(plot.path, "web");
    expect(result).toMatchObject({
      partialFailure: false,
      results: [{ runtimeId: "web", action: "started" }],
    });
  });

  it("waits until a Silvic-owned runtime has actually stopped", async () => {
    let tick = 0;
    const processes: SupervisedCommand[] = [
      { plotPath: plot.path, id: "web", status: "running", processId: 72 },
    ];
    const stop = vi.fn(() => {
      processes[0] = { ...processes[0]!, status: "stopping" };
    });
    const result = await controller({
      processes,
      stop,
      now: () => tick,
      wait: async (milliseconds) => {
        tick += milliseconds;
        processes.splice(0);
      },
    }).handle(request("stop", { plot: plot.workspaceId, runtime: "web" }));

    expect(result).toMatchObject({
      partialFailure: false,
      results: [{ runtimeId: "web", action: "stopped", ownership: "silvic" }],
    });
  });

  it("waits for the serving runtime and returns the canonical URL", async () => {
    let tick = 0;
    const processes: SupervisedCommand[] = [
      { plotPath: plot.path, id: "web", status: "starting", processId: 88 },
      { plotPath: plot.path, id: "worker", status: "running", processId: 89 },
    ];
    const wait = vi.fn(async () => {
      tick += 500;
      processes[0] = { ...processes[0]!, status: "running" };
    });
    const result = await controller({
      processes,
      wait,
      now: () => tick,
      probe: vi.fn().mockResolvedValue(true),
    }).handle(request("wait", { plot: plot.workspaceId, timeoutMs: 2_000 }));

    expect(result).toMatchObject({
      ready: true,
      url: "https://web-issue-9-silvic.localhost",
      durationMs: 500,
    });
    expect(wait).toHaveBeenCalledOnce();
  });

  it("returns actionable diagnostics with recent logs", async () => {
    const result = await controller({
      processes: [
        {
          plotPath: plot.path,
          id: "web",
          status: "failed",
          exitCode: 1,
          advice: "Install the missing dependency.",
        },
      ],
    }).handle(
      request("logs", { plot: plot.workspaceId, runtime: "web", limit: 500 }),
    );

    expect(result).toEqual({
      plotId: plot.workspaceId,
      entries: [{ runtimeId: "web", output: "web output" }],
      diagnostics: ["web: Install the missing dependency."],
    });
  });

  it("fails readiness immediately when the preview runtime failed", async () => {
    const operation = controller({
      processes: [
        {
          plotPath: plot.path,
          id: "web",
          status: "failed",
          exitCode: 7,
          advice: "Port 4321 is already occupied.",
        },
      ],
    }).handle(request("wait", { plot: plot.workspaceId }));

    await expect(operation).rejects.toEqual(
      expect.objectContaining<Partial<AutomationError>>({
        code: "RUNTIME_FAILED",
        message: "Port 4321 is already occupied.",
      }),
    );
  });
});
