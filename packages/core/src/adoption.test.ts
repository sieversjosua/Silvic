import { describe, expect, it, vi } from "vitest";

import type {
  PlotAdoption,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import {
  adoptionMembers,
  buildAdoptionPlan,
  executeAdoption,
  executePlannedAdoption,
} from "./adoption";

function workspace(id: string, parentWorkspaceId?: string): WorkspaceSnapshot {
  return {
    workspaceId: id,
    projectId: "project",
    path: `/repo/${id}`,
    repositoryName: "repo",
    branch: id,
    name: id,
    locationKind: id === "main" ? "checkout" : "worktree",
    isPrimary: id === "main",
    git: {
      branch: id,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    observations: [],
    ...(id === "main"
      ? {}
      : {
          adoption: {
            status: "not-adopted" as const,
            at: new Date(0).toISOString(),
            attempt: 0,
          },
        }),
    ...(parentWorkspaceId
      ? { lineage: { parentWorkspaceId, evidence: "recorded" as const } }
      : {}),
  };
}

const project: ProjectSnapshot = {
  id: "project",
  name: "repo",
  rootPath: "/repo/main",
  branches: [],
  remoteBranches: [],
  workspaces: [
    workspace("main"),
    workspace("base", "main"),
    workspace("middle", "base"),
    workspace("leaf", "middle"),
    workspace("unrelated", "main"),
  ],
};

describe("worktree adoption", () => {
  it("plans a single adoption with its stable route and provider warning", () => {
    const plan = buildAdoptionPlan({
      project,
      selectedWorkspaceId: "leaf",
      scope: "single",
      steps: [
        { label: "Install", run: "pnpm install" },
        { convex: { name: "dev/{plot}" } },
      ],
      member: (member) => ({
        port: member.workspaceId === "leaf" ? 43123 : 43124,
        url: `https://${member.name}.localhost`,
      }),
    });

    expect(plan.members).toEqual([
      expect.objectContaining({
        workspaceId: "leaf",
        port: 43123,
        url: "https://leaf.localhost",
      }),
    ]);
    expect(plan.requiresProviderConfirmation).toBe(true);
    expect(plan.steps).toEqual([
      { label: "Install", providerChanging: true },
      { label: "Convex deployment", providerChanging: true },
    ]);
  });

  it("approves only a detached Plot with local steps and expiring isolated resources", () => {
    const detached = {
      ...workspace("leaf", "main"),
      branch: "(detached)",
      git: { ...workspace("leaf", "main").git, branch: "(detached)" },
    };
    const plan = buildAdoptionPlan({
      project: { ...project, workspaces: [workspace("main"), detached] },
      selectedWorkspaceId: "leaf",
      scope: "single",
      steps: [
        { label: "Install", run: "pnpm install", providerChanges: false },
        {
          convex: { name: "dev/{plot}", expiration: "in 1 day" },
        },
        { label: "Build", run: "pnpm build", providerChanges: false },
      ],
      resources: {
        app: {
          provider: "web",
          kind: "runtime",
          isolation: "isolated",
          command: "web",
        },
        backend: {
          provider: "convex",
          kind: "backend",
          isolation: "isolated",
        },
      },
      automaticAdoption: true,
      member: () => ({ port: 43123, url: "https://leaf.localhost" }),
    });

    expect(plan.steps).toEqual([
      { label: "Install", providerChanging: false },
      { label: "Convex deployment", providerChanging: true },
      { label: "Build", providerChanging: false },
    ]);
    expect(plan.automaticAdoption).toEqual({
      policy: "isolated-disposable",
      eligible: true,
      reasons: [],
    });
  });

  it("keeps opaque steps, shared resources, and missing expiration fail closed", () => {
    const detached = {
      ...workspace("leaf", "main"),
      branch: "(detached)",
      git: { ...workspace("leaf", "main").git, branch: "(detached)" },
    };
    const plan = buildAdoptionPlan({
      project: { ...project, workspaces: [workspace("main"), detached] },
      selectedWorkspaceId: "leaf",
      scope: "single",
      steps: [
        { label: "Install", run: "pnpm install" },
        { convex: { name: "dev/{plot}" } },
      ],
      resources: {
        auth: {
          provider: "workos",
          kind: "auth",
          isolation: "shared",
        },
      },
      automaticAdoption: true,
      member: () => ({ port: 43123, url: "https://leaf.localhost" }),
    });

    expect(plan.automaticAdoption).toMatchObject({ eligible: false });
    expect(plan.automaticAdoption?.reasons).toEqual([
      "Install: shell steps must declare providerChanges false.",
      "Convex deployment: an expiration is required.",
      "auth: shared resources are not eligible for automatic adoption.",
    ]);
  });

  it("surfaces a failed provisioning recovery with its data-loss boundary", () => {
    const failedProject: ProjectSnapshot = {
      ...project,
      workspaces: project.workspaces.map((candidate) =>
        candidate.workspaceId === "leaf"
          ? {
              ...candidate,
              provisioning: {
                status: "failed",
                at: "2026-08-28T10:00:00.000Z",
                steps: [
                  {
                    label: "Convex deployment",
                    command: "Silvic isolated Convex environment",
                    exitCode: 1,
                    output: "Schema validation failed",
                    durationMs: 10,
                    remedy: {
                      id: "convex-recreate",
                      label: "Replace the isolated Convex deployment",
                      dataLoss: true,
                      detail: "Existing data is not copied.",
                    },
                  },
                ],
                attachments: [
                  {
                    provider: "convex",
                    team: "syntwin",
                    project: "mono",
                    deploymentKind: "dev",
                    recipeDeploymentName: "dev/leaf",
                    logicalDeploymentRef: "syntwin:mono:dev/leaf",
                    physicalDeploymentSlug: "fleet-alligator-19",
                    expiration: "in 7 days",
                  },
                ],
              },
            }
          : candidate,
      ),
    };

    const plan = buildAdoptionPlan({
      project: failedProject,
      selectedWorkspaceId: "leaf",
      scope: "single",
      steps: [{ convex: { name: "dev/{plot}", expiration: "in 7 days" } }],
      member: () => ({ port: 43123, url: "https://leaf.localhost" }),
    });

    expect(plan.recovery).toEqual({
      id: "convex-recreate",
      label: "Replace the isolated Convex deployment",
      dataLoss: true,
      detail: "Existing data is not copied.",
      providerChanging: true,
    });
    expect(plan.requiresProviderConfirmation).toBe(true);
  });

  it("requires explicit attachment adoption before a legacy Convex recovery", () => {
    const legacyProject: ProjectSnapshot = {
      ...project,
      workspaces: project.workspaces.map((candidate) =>
        candidate.workspaceId === "leaf"
          ? {
              ...candidate,
              provisioning: {
                status: "failed",
                at: "2026-09-01T08:00:00.000Z",
                steps: [
                  {
                    label: "Convex deployment attachment",
                    command: "npx convex dev",
                    exitCode: 1,
                    output: "AuthenticationFailed: Invalid Convex deploy key",
                    durationMs: 0,
                    remedy: {
                      id: "convex-recreate",
                      label: "Replace the expired Convex deployment",
                      dataLoss: true,
                    },
                  },
                ],
              },
            }
          : candidate,
      ),
    };

    const plan = buildAdoptionPlan({
      project: legacyProject,
      selectedWorkspaceId: "leaf",
      scope: "single",
      steps: [{ convex: { name: "dev/{plot}", expiration: "in 7 days" } }],
      member: () => ({ port: 43123, url: "https://leaf.localhost" }),
    });

    expect(plan.recovery).toMatchObject({
      id: "convex-adopt",
      providerChanging: true,
    });
    expect(plan.recovery).not.toHaveProperty("dataLoss");
    expect(plan.recovery?.detail).toContain(
      "predates structured provider identity",
    );
  });

  it("adopts the selected stack ancestors without unrelated worktrees", () => {
    expect(
      adoptionMembers(project, "leaf", "family").map(
        (member) => member.workspaceId,
      ),
    ).toEqual(["base", "middle", "leaf"]);
  });

  it("adopts one discovered worktree and persists completion", async () => {
    const states = new Map<string, PlotAdoption>();
    const [leaf] = planMembers().slice(-1);
    if (!leaf) throw new Error("Fixture has no leaf");

    const result = await executeAdoption({
      members: [leaf],
      state: (id) => states.get(id),
      persist: (id, adoption) => void states.set(id, adoption),
      run: async () => ({
        provision: [],
        runtime: { status: "not-required", durationMs: 0 },
        readiness: { status: "not-required", durationMs: 0 },
      }),
    });

    expect(result).toEqual([
      expect.objectContaining({ workspaceId: "leaf", status: "adopted" }),
    ]);
    expect(states.get("leaf")).toEqual(
      expect.objectContaining({ status: "adopted", attempt: 1 }),
    );
  });

  it("records partial failure per member and continues the family", async () => {
    const states = new Map<string, PlotAdoption>();
    const run = vi.fn(async (member: { workspaceId: string }) => {
      if (member.workspaceId === "middle") throw new Error("provider refused");
      return {};
    });
    const result = await executeAdoption({
      members: planMembers(),
      state: (id) => states.get(id),
      persist: (id, adoption) => void states.set(id, adoption),
      run,
    });

    expect(result.map(({ status }) => status)).toEqual([
      "adopted",
      "failed",
      "adopted",
    ]);
    expect(states.get("middle")).toEqual(
      expect.objectContaining({
        status: "failed",
        attempt: 1,
        error: "provider refused",
      }),
    );
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("retries only failed work and treats duplicate adoption idempotently", async () => {
    const states = new Map<string, PlotAdoption>([
      [
        "base",
        { status: "adopted", at: new Date(0).toISOString(), attempt: 1 },
      ],
      [
        "middle",
        {
          status: "failed",
          at: new Date(0).toISOString(),
          attempt: 1,
          error: "offline",
        },
      ],
      [
        "leaf",
        { status: "adopted", at: new Date(0).toISOString(), attempt: 1 },
      ],
    ]);
    const run = vi.fn(async () => ({}));
    const result = await executeAdoption({
      members: planMembers(),
      state: (id) => states.get(id),
      persist: (id, adoption) => void states.set(id, adoption),
      run,
    });

    expect(result.map(({ status }) => status)).toEqual([
      "already-adopted",
      "adopted",
      "already-adopted",
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(states.get("middle")).toEqual(
      expect.objectContaining({ status: "adopted", attempt: 2 }),
    );
  });

  it("runs the shared confirmed adoption, reservation, and provisioning transaction", async () => {
    const states = new Map<string, PlotAdoption>();
    const reserve = vi.fn();
    const provision = vi.fn(async () => ({
      provision: [],
      runtime: { status: "not-required" as const, durationMs: 0 },
      readiness: { status: "not-required" as const, durationMs: 0 },
    }));
    const plan = buildAdoptionPlan({
      project,
      selectedWorkspaceId: "leaf",
      scope: "single",
      steps: [{ label: "Provider setup", run: "provider setup" }],
      member: () => ({ port: 43123, url: "https://leaf.localhost" }),
    });

    await expect(
      executePlannedAdoption({
        plan,
        confirmProviderChanges: false,
        state: (id) => states.get(id),
        persist: (id, adoption) => void states.set(id, adoption),
        reserve,
        provision,
      }),
    ).rejects.toThrow("Confirm the listed provider changes");
    expect(reserve).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();

    await expect(
      executePlannedAdoption({
        plan,
        confirmProviderChanges: true,
        state: (id) => states.get(id),
        persist: (id, adoption) => void states.set(id, adoption),
        reserve,
        provision,
      }),
    ).resolves.toMatchObject({
      members: [{ workspaceId: "leaf", status: "adopted" }],
    });
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "leaf", port: 43123 }),
    );
    expect(states.get("leaf")).toMatchObject({ status: "adopted" });
  });
});

function planMembers() {
  return adoptionMembers(project, "leaf", "family").map((member, index) => ({
    workspaceId: member.workspaceId,
    name: member.name,
    branch: member.branch,
    path: member.path,
    port: 43000 + index,
    url: `https://${member.name}.localhost`,
    status: member.adoption?.status ?? ("not-adopted" as const),
  }));
}
