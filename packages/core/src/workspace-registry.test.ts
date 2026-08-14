import { describe, expect, it } from "vitest";

import type { SilvicSnapshot } from "@silvic/contracts";

import { WorkspaceRegistry, renameWorkspaceRecord } from "./workspace-registry";

describe("WorkspaceRegistry", () => {
  it("keeps the Issue that explains why a Plot exists", () => {
    const registry = new WorkspaceRegistry();
    const snapshot = fixture("/projects/app-feature");
    const feature = snapshot.projects[0]?.workspaces.find(
      (workspace) => !workspace.isPrimary,
    );
    if (!feature) throw new Error("Fixture has no feature Plot");

    const result = registry.reconcile(snapshot, [
      {
        workspaceId: "plot-184",
        projectId: feature.projectId,
        path: feature.path,
        branch: feature.branch,
        purpose: "Fix HEIC uploads",
        task: {
          title: "Fix HEIC uploads",
          description: "HEIC images fail during conversion.",
          issue: {
            provider: "github",
            number: 184,
            title: "Fix HEIC uploads",
            body: "HEIC images fail during conversion.",
            url: "https://github.com/example/app/issues/184",
            labels: ["bug"],
            assignees: ["josua"],
          },
        },
      },
    ]);

    expect(
      result.snapshot.projects[0]?.workspaces.find(
        (workspace) => workspace.workspaceId === "plot-184",
      )?.task,
    ).toEqual({
      title: "Fix HEIC uploads",
      description: "HEIC images fail during conversion.",
      issue: expect.objectContaining({ number: 184, provider: "github" }),
    });
  });

  it("keeps a Workspace identity after a path move and preserves recorded lineage", () => {
    const registry = new WorkspaceRegistry();
    const snapshot = fixture("/projects/app-feature");
    const first = registry.reconcile(snapshot, []);
    const primary = first.snapshot.projects[0]?.workspaces.find(
      (workspace) => workspace.isPrimary,
    );
    const feature = first.snapshot.projects[0]?.workspaces.find(
      (workspace) => !workspace.isPrimary,
    );
    expect(primary).toBeDefined();
    expect(feature).toBeDefined();
    if (!primary || !feature) throw new Error("Fixture reconciliation failed");

    const recorded = first.records.map((record) =>
      record.workspaceId === feature.workspaceId
        ? { ...record, parentWorkspaceId: primary.workspaceId }
        : record,
    );
    const moved = registry.reconcile(
      fixture("/archives/app-feature"),
      recorded,
    );
    const movedFeature = moved.snapshot.projects[0]?.workspaces.find(
      (workspace) => !workspace.isPrimary,
    );

    expect(movedFeature?.workspaceId).toBe(feature.workspaceId);
    expect(movedFeature?.lineage).toEqual({
      parentWorkspaceId: primary.workspaceId,
      evidence: "recorded",
    });
  });

  it("persists a renamed Plot without changing its identity or lineage", () => {
    const registry = new WorkspaceRegistry();
    const first = registry.reconcile(fixture("/projects/app-feature"), []);
    const feature = first.snapshot.projects[0]?.workspaces.find(
      (workspace) => !workspace.isPrimary,
    );
    if (!feature) throw new Error("Fixture has no feature Plot");

    const records = renameWorkspaceRecord(
      first.records,
      feature.workspaceId,
      "Image upload repair",
    );
    const refreshed = registry.reconcile(
      fixture("/projects/app-feature"),
      records,
    );
    const renamed = refreshed.snapshot.projects[0]?.workspaces.find(
      (workspace) => workspace.workspaceId === feature.workspaceId,
    );

    expect(renamed?.name).toBe("Image upload repair");
    expect(renamed?.workspaceId).toBe(feature.workspaceId);
    expect(
      records.find((record) => record.workspaceId === feature.workspaceId),
    ).toEqual(
      expect.objectContaining({
        displayName: "Image upload repair",
        path: feature.path,
        branch: feature.branch,
      }),
    );
  });

  it("refuses to rename an unknown Plot record", () => {
    expect(() => renameWorkspaceRecord([], "missing", "Name")).toThrow(
      "Unknown plot",
    );
  });
});

function fixture(featurePath: string): SilvicSnapshot {
  const git = {
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  };
  return {
    refreshedAt: new Date(0).toISOString(),
    connectorFailures: [],
    projects: [
      {
        id: "github.com/example/app",
        name: "app",
        rootPath: "/projects/app",
        branches: [],
        remoteBranches: [],
        workspaces: [
          {
            workspaceId: "transient-main",
            projectId: "github.com/example/app",
            path: "/projects/app",
            repositoryName: "app",
            branch: "main",
            name: "main",
            locationKind: "checkout",
            isPrimary: true,
            git,
            observations: [],
          },
          {
            workspaceId: "transient-feature",
            projectId: "github.com/example/app",
            path: featurePath,
            repositoryName: "app",
            branch: "feature/stable",
            name: "feature/stable",
            locationKind: "worktree",
            isPrimary: false,
            git: { ...git, branch: "feature/stable" },
            observations: [],
          },
        ],
      },
    ],
  };
}
