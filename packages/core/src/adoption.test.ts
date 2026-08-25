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
