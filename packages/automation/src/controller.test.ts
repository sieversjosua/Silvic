import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  PlotAdoptionPlan,
  PlotAdoptionRunRequest,
  PlotAdoptionRunResult,
  PlotCommand,
  PlotProvisionRequest,
  PlotProvisionRunResult,
  PlotResourceDefinition,
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";
import type { SupervisedCommand, WorkspaceStatePlan } from "@silvic/core";

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
  adoption: {
    status: "adopted",
    at: "2026-08-25T12:00:00.000Z",
    attempt: 1,
  },
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
    client: { name: "silvic-cli", version: "development" },
    id: "test-request",
    method,
    params,
  };
}

function controller(
  options: {
    workspace?: WorkspaceSnapshot;
    requiresProvisioning?: boolean;
    resources?: Readonly<Record<string, PlotResourceDefinition>>;
    planAdoption?: (request: {
      workspaceId: string;
      scope: "single" | "family";
    }) => Promise<PlotAdoptionPlan>;
    adopt?: (request: PlotAdoptionRunRequest) => Promise<PlotAdoptionRunResult>;
    provision?: (
      request: PlotProvisionRequest,
    ) => Promise<PlotProvisionRunResult>;
    inspectWorkspaceState?: () => Promise<WorkspaceStatePlan>;
    pruneWorkspaceState?: (confirmPlanId: string) => Promise<{
      plan: WorkspaceStatePlan;
      removedRecordIds: readonly string[];
    }>;
    processes?: readonly SupervisedCommand[];
    start?: (plotPath: string, runtimeId: string) => Promise<void>;
    stop?: (plotPath: string, runtimeId: string) => void;
    probe?: (url: string) => Promise<boolean>;
    wait?: (milliseconds: number) => Promise<void>;
    now?: () => number;
    snapshot?: () => SilvicSnapshot;
    automaticAdoption?: boolean;
  } = {},
) {
  const workspace = options.workspace ?? plot;
  const projectSnapshot = { ...project, workspaces: [workspace] };
  const currentSnapshot = { ...snapshot, projects: [projectSnapshot] };
  return new AutomationController({
    snapshot: options.snapshot ?? (() => currentSnapshot),
    roots: () => [project.rootPath],
    definition: async () => ({
      commands,
      resources: options.resources ?? {},
      previewUrl: "https://web-issue-9-silvic.localhost",
      requiresProvisioning: options.requiresProvisioning ?? false,
      automaticAdoption: options.automaticAdoption ?? false,
    }),
    planAdoption:
      options.planAdoption ??
      (async ({ workspaceId, scope }) => ({
        projectId: project.id,
        scope,
        members: [
          {
            workspaceId,
            name: workspace.name,
            branch: workspace.branch,
            path: workspace.path,
            port: 43123,
            url: "https://web-issue-9-silvic.localhost",
            status: workspace.adoption?.status ?? "not-adopted",
          },
        ],
        steps: [{ label: "Convex deployment", providerChanging: true }],
        requiresProviderConfirmation: true,
      })),
    adopt:
      options.adopt ??
      (async () => ({
        members: [
          {
            workspaceId: workspace.workspaceId,
            name: workspace.name,
            status: "adopted",
          },
        ],
      })),
    provision:
      options.provision ??
      (async () => ({
        provision: [],
        runtime: { status: "not-required", durationMs: 0 },
        readiness: { status: "not-required", durationMs: 0 },
      })),
    inspectWorkspaceState:
      options.inspectWorkspaceState ?? (async () => statePlan("state_empty")),
    pruneWorkspaceState:
      options.pruneWorkspaceState ??
      (async (confirmPlanId) => ({
        plan: statePlan(confirmPlanId),
        removedRecordIds: [],
      })),
    processes: () => options.processes ?? [],
    start: options.start ?? (async () => undefined),
    stop: options.stop ?? (() => undefined),
    output: async (_plotPath, runtimeId) => `${runtimeId} output`,
    probe: options.probe ?? (async () => true),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

function statePlan(planId: string): WorkspaceStatePlan {
  return {
    planId,
    generatedAt: "2026-08-28T00:00:00.000Z",
    retentionDays: 30,
    totalRecords: 0,
    activeRecords: 0,
    staleRecords: [],
    prunableRecordIds: [],
    storage: [],
    boundaries: [],
  };
}

describe("workspace state automation", () => {
  it("returns a read-only plan before forwarding an exact confirmation", async () => {
    const inspectWorkspaceState = vi.fn(async () => statePlan("state_exact"));
    const pruneWorkspaceState = vi.fn(async (confirmPlanId: string) => ({
      plan: statePlan(confirmPlanId),
      removedRecordIds: ["stale-1"],
    }));
    const automation = controller({
      inspectWorkspaceState,
      pruneWorkspaceState,
    });

    await expect(
      automation.handle(request("workspaceStatePlan", {})),
    ).resolves.toMatchObject({ planId: "state_exact" });
    await expect(
      automation.handle(
        request("pruneWorkspaceState", { confirmPlanId: "state_exact" }),
      ),
    ).resolves.toMatchObject({ removedRecordIds: ["stale-1"] });
    expect(inspectWorkspaceState).toHaveBeenCalledOnce();
    expect(pruneWorkspaceState).toHaveBeenCalledWith("state_exact");
  });

  it("rejects unknown pruning parameters before state can change", async () => {
    const pruneWorkspaceState = vi.fn();
    await expect(
      controller({ pruneWorkspaceState }).handle(
        request("pruneWorkspaceState", {
          confirmPlanId: "state_exact",
          path: "/arbitrary/worktree",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(pruneWorkspaceState).not.toHaveBeenCalled();
  });
});

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
        {
          plotPath: plot.path,
          id: "worker",
          status: "running",
          processId: 91,
          expectedPort: 31_100,
          inspectorPort: 31_101,
          identity: "silvic-issue-9-agent-a1b2c3",
        },
      ],
    }).handle(request("status", { plot: plot.workspaceId }));

    expect(status).toMatchObject({
      id: plot.workspaceId,
      state: "ready",
      runtimes: [
        { id: "web", ownership: "external" },
        {
          id: "worker",
          ownership: "silvic",
          expectedPort: 31_100,
          inspectorPort: 31_101,
          identity: "silvic-issue-9-agent-a1b2c3",
        },
      ],
    });
  });
});

describe("automation operations", () => {
  it("makes shared and manual resource limits explicit in status and diagnostics", async () => {
    const result = await controller({
      resources: {
        agent: {
          provider: "livekit",
          kind: "agent",
          isolation: "shared",
          command: "worker",
        },
        ingress: {
          provider: "cloudflare",
          kind: "ingress",
          isolation: "manual",
        },
        auth: {
          provider: "workos",
          kind: "auth",
          isolation: "manual",
        },
      },
    }).handle(request("status", { plot: plot.workspaceId }));

    expect(result).toMatchObject({
      resources: [
        {
          id: "agent",
          isolation: "shared",
          runtimeIdentity: "namespaced",
        },
        { id: "ingress", isolation: "manual" },
        { id: "auth", isolation: "manual" },
      ],
      diagnostics: [
        expect.stringMatching(/agent: livekit infrastructure is shared/),
        expect.stringMatching(/ingress: cloudflare isolation is manual/),
        expect.stringMatching(/auth: workos isolation is manual/),
      ],
    });
  });
  it("shows adoption and provisioning state in Plot status", async () => {
    const status = await controller({
      workspace: {
        ...plot,
        provisioning: {
          status: "complete",
          at: "2026-08-27T12:00:00.000Z",
          steps: [],
        },
      },
    }).handle(request("status", { plot: plot.workspaceId }));

    expect(status).toMatchObject({
      adoption: { status: "adopted", attempt: 1 },
      provisioning: { status: "complete" },
    });
  });

  it("plans adoption from a path but returns the stable Plot identity", async () => {
    const planAdoption = vi.fn(async ({ scope }) => ({
      projectId: project.id,
      scope,
      members: [],
      steps: [],
      requiresProviderConfirmation: false,
    }));

    const result = await controller({ planAdoption }).handle(
      request("adoptionPlan", { plot: plot.path, scope: "family" }),
    );

    expect(planAdoption).toHaveBeenCalledWith({
      workspaceId: plot.workspaceId,
      scope: "family",
    });
    expect(result).toMatchObject({ selectedPlotId: plot.workspaceId });
  });

  it("requires adoption confirmation to match the stable Plot ID", async () => {
    const adopt = vi.fn(async () => ({ members: [] }));
    const operation = controller({ adopt }).handle(
      request("adopt", { plot: plot.path, confirmPlotId: plot.path }),
    );

    await expect(operation).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      details: { plotId: plot.workspaceId },
    });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("adopts a Plot explicitly and reports member-level partial failure", async () => {
    const adopt = vi.fn(async () => ({
      members: [
        { workspaceId: "parent", name: "Parent", status: "adopted" as const },
        {
          workspaceId: plot.workspaceId,
          name: plot.name,
          status: "failed" as const,
          error: "provider refused",
        },
      ],
    }));

    const result = await controller({ adopt }).handle(
      request("adopt", {
        plot: plot.path,
        scope: "family",
        confirmPlotId: plot.workspaceId,
      }),
    );

    expect(adopt).toHaveBeenCalledWith({
      workspaceId: plot.workspaceId,
      scope: "family",
      confirmProviderChanges: true,
    });
    expect(result).toMatchObject({ failed: true, partialFailure: true });
  });

  it("retries provisioning only after adoption and stable-ID confirmation", async () => {
    const provision = vi.fn(async () => ({
      provision: [
        {
          label: "Convex deployment",
          command: "npx convex dev --once",
          exitCode: 0,
          output: "",
          durationMs: 1,
        },
      ],
      runtime: { status: "started" as const, durationMs: 1 },
      readiness: { status: "ready" as const, durationMs: 1 },
    }));

    const result = await controller({ provision }).handle(
      request("provision", {
        plot: plot.path,
        confirmPlotId: plot.workspaceId,
        remedy: "convex-cli",
      }),
    );

    expect(provision).toHaveBeenCalledWith({
      path: plot.path,
      remedy: "convex-cli",
    });
    expect(result).toMatchObject({ failed: false, partialFailure: false });
  });

  it("forwards an offered destructive Convex recovery as a closed remedy", async () => {
    const provision = vi.fn(async () => ({
      provision: [],
      runtime: { status: "not-required" as const, durationMs: 0 },
      readiness: { status: "not-required" as const, durationMs: 0 },
    }));

    await controller({ provision }).handle(
      request("provision", {
        plot: plot.workspaceId,
        confirmPlotId: plot.workspaceId,
        remedy: "convex-recreate",
      }),
    );

    expect(provision).toHaveBeenCalledWith({
      path: plot.path,
      remedy: "convex-recreate",
    });
  });

  it("requires stable-ID confirmation before adopting legacy Convex identity", async () => {
    const provision = vi.fn(async () => ({
      provision: [],
      runtime: { status: "not-required" as const, durationMs: 0 },
      readiness: { status: "not-required" as const, durationMs: 0 },
    }));
    const automation = controller({ provision });

    await expect(
      automation.handle(
        request("provision", {
          plot: plot.workspaceId,
          confirmPlotId: "wrong-plot",
          remedy: "convex-adopt",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(provision).not.toHaveBeenCalled();

    await automation.handle(
      request("provision", {
        plot: plot.workspaceId,
        confirmPlotId: plot.workspaceId,
        remedy: "convex-adopt",
      }),
    );
    expect(provision).toHaveBeenCalledWith({
      path: plot.path,
      remedy: "convex-adopt",
    });
  });

  it("treats a repeated successful provisioning request as a no-op", async () => {
    const provision = vi.fn();
    const result = await controller({
      workspace: {
        ...plot,
        provisioning: {
          status: "complete",
          at: "2026-08-27T12:00:00.000Z",
          steps: [
            {
              label: "Convex deployment",
              command: "npx convex dev --once",
              exitCode: 0,
              output: "",
              durationMs: 1,
            },
          ],
        },
      },
      provision,
    }).handle(
      request("provision", {
        plot: plot.workspaceId,
        confirmPlotId: plot.workspaceId,
      }),
    );

    expect(provision).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      alreadyProvisioned: true,
      failed: false,
      partialFailure: false,
    });
  });

  it("recreates an expired Convex deployment after stored provisioning completed", async () => {
    const provision = vi.fn(async () => ({
      provision: [
        {
          label: "Convex deployment",
          command: "Silvic isolated Convex environment",
          exitCode: 0,
          output: "Created replacement deployment",
          durationMs: 1,
        },
      ],
      runtime: { status: "not-required" as const, durationMs: 0 },
      readiness: { status: "not-required" as const, durationMs: 0 },
    }));
    const result = await controller({
      workspace: {
        ...plot,
        provisioning: {
          status: "complete",
          at: "2026-08-27T12:00:00.000Z",
          steps: [
            {
              label: "Convex deployment",
              command: "Silvic isolated Convex environment",
              exitCode: 0,
              output: "Created original deployment",
              durationMs: 1,
            },
          ],
        },
      },
      provision,
    }).handle(
      request("provision", {
        plot: plot.workspaceId,
        confirmPlotId: plot.workspaceId,
        remedy: "convex-recreate",
      }),
    );

    expect(provision).toHaveBeenCalledWith({
      path: plot.path,
      remedy: "convex-recreate",
    });
    expect(result).toMatchObject({
      alreadyProvisioned: false,
      failed: false,
      partialFailure: false,
    });
  });

  it("does not provision an external Plot before adoption", async () => {
    const provision = vi.fn(async () => ({
      provision: [],
      runtime: { status: "not-required" as const, durationMs: 0 },
      readiness: { status: "not-required" as const, durationMs: 0 },
    }));
    const operation = controller({
      workspace: {
        ...plot,
        adoption: {
          status: "not-adopted",
          at: "2026-08-27T12:00:00.000Z",
          attempt: 0,
        },
      },
      provision,
    }).handle(
      request("provision", {
        plot: plot.workspaceId,
        confirmPlotId: plot.workspaceId,
      }),
    );

    await expect(operation).rejects.toMatchObject({
      code: "ADOPTION_REQUIRED",
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not start any Convex runtime before an external Plot is adopted", async () => {
    const plotPath = await mkdtemp(join(tmpdir(), "silvic-unadopted-convex-"));
    await writeFile(
      join(plotPath, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:shared-stale-deployment\n",
    );
    const start = vi.fn(async () => undefined);
    const operation = controller({
      workspace: {
        ...plot,
        path: plotPath,
        adoption: {
          status: "not-adopted",
          at: "2026-08-27T12:00:00.000Z",
          attempt: 0,
        },
      },
      requiresProvisioning: true,
      start,
    }).handle(request("start", { plot: plot.workspaceId }));

    try {
      await expect(operation).rejects.toEqual(
        expect.objectContaining<Partial<AutomationError>>({
          code: "ADOPTION_REQUIRED",
        }),
      );
      expect(start).not.toHaveBeenCalled();
    } finally {
      await rm(plotPath, { recursive: true, force: true });
    }
  });

  it("automatically adopts an eligible detached Plot and returns the audit", async () => {
    let current: WorkspaceSnapshot = {
      ...plot,
      branch: "(detached)",
      git: { ...plot.git, branch: "(detached)" },
      adoption: {
        status: "not-adopted",
        at: "2026-08-28T12:00:00.000Z",
        attempt: 0,
      },
    };
    const currentSnapshot = (): SilvicSnapshot => ({
      ...snapshot,
      projects: [{ ...project, workspaces: [current] }],
    });
    const plan: PlotAdoptionPlan = {
      projectId: project.id,
      scope: "single",
      members: [
        {
          workspaceId: plot.workspaceId,
          name: plot.name,
          branch: "(detached)",
          path: plot.path,
          port: 43123,
          url: "https://web-issue-9-silvic.localhost",
          status: "not-adopted",
        },
      ],
      steps: [
        { label: "Install", providerChanging: false },
        { label: "Convex deployment", providerChanging: true },
      ],
      automaticAdoption: {
        policy: "isolated-disposable",
        eligible: true,
        reasons: [],
      },
      requiresProviderConfirmation: true,
    };
    const adopt = vi.fn(async () => {
      current = {
        ...current,
        adoption: {
          status: "adopted",
          at: "2026-08-28T12:00:01.000Z",
          attempt: 1,
        },
        provisioning: {
          status: "complete",
          at: "2026-08-28T12:00:01.000Z",
          steps: [],
        },
      };
      return {
        members: [
          {
            workspaceId: plot.workspaceId,
            name: plot.name,
            status: "adopted" as const,
          },
        ],
      };
    });
    const start = vi.fn(async () => undefined);

    const result = await controller({
      workspace: current,
      snapshot: currentSnapshot,
      automaticAdoption: true,
      requiresProvisioning: true,
      planAdoption: async () => plan,
      adopt,
      start,
    }).handle(request("start", { plot: plot.workspaceId }));

    expect(adopt).toHaveBeenCalledWith({
      workspaceId: plot.workspaceId,
      scope: "single",
      confirmProviderChanges: true,
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      automaticAdoption: {
        selectedPlotId: plot.workspaceId,
        plan: { automaticAdoption: { eligible: true } },
        result: { members: [{ status: "adopted" }] },
      },
    });
  });

  it("keeps an ineligible disposable Plot fail closed with policy reasons", async () => {
    const detached: WorkspaceSnapshot = {
      ...plot,
      branch: "(detached)",
      git: { ...plot.git, branch: "(detached)" },
      adoption: {
        status: "not-adopted",
        at: "2026-08-28T12:00:00.000Z",
        attempt: 0,
      },
    };
    const adopt = vi.fn();
    const start = vi.fn(async () => undefined);
    const operation = controller({
      workspace: detached,
      automaticAdoption: true,
      planAdoption: async () => ({
        projectId: project.id,
        scope: "single",
        members: [],
        steps: [{ label: "Deploy shared state", providerChanging: true }],
        automaticAdoption: {
          policy: "isolated-disposable",
          eligible: false,
          reasons: [
            "Deploy shared state: shell steps must declare providerChanges false.",
          ],
        },
        requiresProviderConfirmation: true,
      }),
      adopt,
      start,
    }).handle(request("start", { plot: plot.workspaceId }));

    await expect(operation).rejects.toMatchObject({
      code: "ADOPTION_REQUIRED",
      details: {
        automaticAdoption: {
          selectedPlotId: plot.workspaceId,
          plan: {
            automaticAdoption: {
              eligible: false,
              reasons: [expect.stringContaining("providerChanges false")],
            },
          },
        },
      },
    });
    expect(adopt).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not infer automatic approval for a detached Plot without repository opt-in", async () => {
    const detached: WorkspaceSnapshot = {
      ...plot,
      branch: "(detached)",
      git: { ...plot.git, branch: "(detached)" },
      adoption: {
        status: "not-adopted",
        at: "2026-08-28T12:00:00.000Z",
        attempt: 0,
      },
    };
    const planAdoption = vi.fn();
    const adopt = vi.fn();

    await expect(
      controller({ workspace: detached, planAdoption, adopt }).handle(
        request("start", { plot: plot.workspaceId }),
      ),
    ).rejects.toMatchObject({ code: "ADOPTION_REQUIRED" });
    expect(planAdoption).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("does not start one runtime after required provisioning failed", async () => {
    const start = vi.fn(async () => undefined);
    const operation = controller({
      workspace: {
        ...plot,
        provisioning: {
          status: "failed",
          at: "2026-08-27T12:00:00.000Z",
          steps: [],
        },
      },
      requiresProvisioning: true,
      start,
    }).handle(request("start", { plot: plot.workspaceId, runtime: "worker" }));

    await expect(operation).rejects.toEqual(
      expect.objectContaining<Partial<AutomationError>>({
        code: "PROVISIONING_REQUIRED",
        message:
          "Retry provisioning before starting runtimes for this Plot. Inspect the plan, then explicitly confirm the stable Plot ID.",
      }),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("starts an adopted Plot after required provisioning completed", async () => {
    const start = vi.fn(async () => undefined);

    await controller({
      workspace: {
        ...plot,
        provisioning: {
          status: "complete",
          at: "2026-08-27T12:00:00.000Z",
          steps: [],
        },
      },
      requiresProvisioning: true,
      start,
    }).handle(request("start", { plot: plot.workspaceId, runtime: "worker" }));

    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(plot.path, "worker");
  });

  it("allows the primary checkout without adoption or provisioning", async () => {
    const start = vi.fn(async () => undefined);
    const { adoption: _adoption, provisioning: _provisioning, ...base } = plot;
    const primary = {
      ...base,
      isPrimary: true,
      locationKind: "checkout" as const,
    };

    await controller({
      workspace: primary,
      requiresProvisioning: true,
      start,
    }).handle(request("start", { plot: plot.workspaceId, runtime: "web" }));

    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(primary.path, "web");
  });

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
