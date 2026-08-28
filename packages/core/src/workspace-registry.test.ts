import { describe, expect, it } from "vitest";

import type { SilvicSnapshot } from "@silvic/contracts";

import { WorkspaceRegistry, renameWorkspaceRecord } from "./workspace-registry";

describe("WorkspaceRegistry", () => {
  it("marks an externally discovered worktree as not adopted and persists it", () => {
    const registry = new WorkspaceRegistry();
    const first = registry.reconcile(fixture("/projects/app-feature"), []);
    const feature = first.snapshot.projects[0]?.workspaces.find(
      (workspace) => !workspace.isPrimary,
    );

    expect(feature?.adoption).toEqual(
      expect.objectContaining({ status: "not-adopted", attempt: 0 }),
    );
    expect(
      registry
        .reconcile(fixture("/projects/app-feature"), first.records)
        .snapshot.projects[0]?.workspaces.find(
          (workspace) => !workspace.isPrimary,
        )?.adoption,
    ).toEqual(feature?.adoption);
  });

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

  it("holds a session-derived name through a poll that observes nothing", () => {
    const registry = new WorkspaceRegistry();
    // An opaque harness worktree: only the thread title says what it is.
    const detached = "/Users/me/.codex/worktrees/70b0/app";
    const withSessions = (
      sessions: readonly { label: string; updatedAtMs: number }[],
    ) => {
      const snapshot = fixture(detached);
      const feature = snapshot.projects[0]?.workspaces[1];
      if (!feature) throw new Error("Fixture has no feature Plot");
      return {
        ...snapshot,
        projects: [
          {
            ...snapshot.projects[0]!,
            workspaces: [
              snapshot.projects[0]!.workspaces[0]!,
              {
                ...feature,
                branch: "(detached)",
                name: "app",
                git: { ...feature.git, branch: "(detached)" },
                observations: sessions.map((session) => ({
                  connectorId: "local-context",
                  workspaceId: feature.workspaceId,
                  kind: "session" as const,
                  state: "ready" as const,
                  label: session.label,
                  metadata: { updatedAtMs: session.updatedAtMs },
                })),
              },
            ],
          },
        ],
      };
    };
    const nameOf = (result: ReturnType<WorkspaceRegistry["reconcile"]>) =>
      result.snapshot.projects[0]?.workspaces.find(
        (workspace) => !workspace.isPrimary,
      )?.name;

    // Order of arrival says nothing about which session is current.
    const first = registry.reconcile(
      withSessions([
        { label: "Older thread", updatedAtMs: 10 },
        { label: "Fix owner onboarding", updatedAtMs: 20 },
      ]),
      [],
    );
    expect(nameOf(first)).toBe("Fix owner onboarding");

    // A poll where the harness read failed must not rename the plot back to
    // its opaque directory evidence.
    expect(nameOf(registry.reconcile(withSessions([]), first.records))).toBe(
      "Fix owner onboarding",
    );

    // Nor may a newer thread rename it, and nor may a restart: the answer
    // travels with the records, so the Git-only paint that comes first after
    // launch already knows it.
    const later = registry.reconcile(
      withSessions([{ label: "Something else entirely", updatedAtMs: 99 }]),
      first.records,
    );
    expect(nameOf(later)).toBe("Fix owner onboarding");
    expect(
      nameOf(
        new WorkspaceRegistry().reconcile(withSessions([]), later.records),
      ),
    ).toBe("Fix owner onboarding");
  });

  it("refuses to rename an unknown Plot record", () => {
    expect(() => renameWorkspaceRecord([], "missing", "Name")).toThrow(
      "Unknown plot",
    );
  });

  it("marks missing records only after an authoritative scan", () => {
    const registry = new WorkspaceRegistry();
    const first = registry.reconcile(fixture("/projects/app-feature"), [], {
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const partial = registry.reconcile(
      { projects: [], connectorFailures: [], refreshedAt: "partial" },
      first.records,
      { authoritative: false, now: new Date("2026-01-02T00:00:00.000Z") },
    );
    expect(partial.records.every((record) => !record.missingSince)).toBe(true);

    const missing = registry.reconcile(
      { projects: [], connectorFailures: [], refreshedAt: "full" },
      partial.records,
      { authoritative: true, now: new Date("2026-01-03T00:00:00.000Z") },
    );
    expect(missing.records.map((record) => record.missingSince)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
  });

  it("clears a stale marker when the same stable Workspace returns", () => {
    const registry = new WorkspaceRegistry();
    const first = registry.reconcile(fixture("/projects/app-feature"), [], {
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    const missing = registry.reconcile(
      { projects: [], connectorFailures: [], refreshedAt: "full" },
      first.records,
      { now: new Date("2026-02-01T00:00:00.000Z") },
    );
    const returned = registry.reconcile(
      fixture("/projects/app-feature"),
      missing.records,
      { now: new Date("2026-02-02T00:00:00.000Z") },
    );

    expect(returned.records.every((record) => !record.missingSince)).toBe(true);
    expect(returned.records.map((record) => record.workspaceId)).toEqual(
      first.records.map((record) => record.workspaceId),
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
