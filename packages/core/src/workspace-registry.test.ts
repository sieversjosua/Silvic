import { describe, expect, it } from "vitest";

import type { SilvicSnapshot } from "@silvic/contracts";

import { WorkspaceRegistry } from "./workspace-registry";

describe("WorkspaceRegistry", () => {
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
