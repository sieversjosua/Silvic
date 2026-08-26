import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@silvic/contracts";

import { activityLabel, plotListRows, steadyRows } from "./plot-list";

function plot(overrides: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  const name = overrides.name ?? "plot";
  return {
    workspaceId: name,
    projectId: "project-1",
    path: `/plots/${name}`,
    repositoryName: "app",
    branch: name,
    name,
    locationKind: "worktree",
    isPrimary: false,
    git: {
      branch: name,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    observations: [],
    ...overrides,
  };
}

function session(
  workspaceId: string,
  state: "active" | "quiet" | "ready",
  updatedAtMs: number,
) {
  return {
    connectorId: "codex",
    workspaceId,
    kind: "session",
    state,
    label: `${workspaceId} session`,
    metadata: { updatedAtMs },
  } as const;
}

const empty = { commands: [], processes: [], declared: {}, query: "" };

describe("plotListRows", () => {
  it("orders every plot by its latest Codex session activity", () => {
    const rows = plotListRows({
      ...empty,
      workspaces: [
        plot({ name: "quiet-one" }),
        plot({
          name: "conflicted",
          observations: [session("conflicted", "quiet", 4)],
          git: {
            branch: "conflicted",
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 2,
          },
        }),
        plot({
          name: "working",
          observations: [session("working", "active", 5)],
        }),
        plot({ name: "trunk", isPrimary: true }),
      ],
    });
    expect(rows.map((row) => row.workspace.name)).toEqual([
      "working",
      "conflicted",
      "trunk",
      "quiet-one",
    ]);
  });

  it("lets an active Codex session outrank an attention state", () => {
    const rows = plotListRows({
      ...empty,
      workspaces: [
        plot({
          name: "conflicted",
          git: {
            branch: "conflicted",
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 2,
          },
        }),
        plot({
          name: "working",
          observations: [session("working", "active", 5)],
        }),
      ],
    });

    expect(rows.map((row) => row.workspace.name)).toEqual([
      "working",
      "conflicted",
    ]);
  });

  it("lets a running supervised command lift a quiet plot", () => {
    const rows = plotListRows({
      ...empty,
      commands: [["web", { run: "bun run dev", url: true }]],
      processes: [{ plotPath: "/plots/running", id: "web", status: "running" }],
      workspaces: [plot({ name: "idle" }), plot({ name: "running" })],
    });
    expect(rows.map((row) => row.workspace.name)).toEqual(["running", "idle"]);
    expect(rows[0]?.runtime?.label).toBe("Running");
  });

  it("does not demote current work when session history enriches the first paint", () => {
    const common = {
      ...empty,
      commands: [["web", { run: "bun run dev" }]] as const,
      processes: [
        {
          plotPath: "/plots/current",
          id: "web",
          status: "running" as const,
        },
      ],
    };
    const startup = steadyRows(
      plotListRows({
        ...common,
        workspaces: [plot({ name: "old" }), plot({ name: "current" })],
      }),
      undefined,
    );
    expect(startup.rows.map((row) => row.workspace.name)).toEqual([
      "current",
      "old",
    ]);

    const enriched = plotListRows({
      ...common,
      workspaces: [
        plot({
          name: "old",
          observations: [session("old", "ready", 200)],
        }),
        plot({
          name: "current",
          observations: [session("current", "ready", 100)],
        }),
      ],
    });
    expect(
      steadyRows(enriched, startup.order).rows.map((row) => row.workspace.name),
    ).toEqual(["current", "old"]);
  });

  it("keeps not-adopted plots below adopted work", () => {
    const rows = plotListRows({
      ...empty,
      workspaces: [
        plot({
          name: "external",
          adoption: {
            status: "not-adopted",
            at: "2026-08-26T00:00:00.000Z",
            attempt: 1,
          },
          observations: [session("external", "active", 200)],
        }),
        plot({ name: "adopted" }),
      ],
    });

    expect(rows.map((row) => row.workspace.name)).toEqual([
      "adopted",
      "external",
    ]);
  });

  it("orders equally urgent plots by most recent session activity", () => {
    const rows = plotListRows({
      ...empty,
      workspaces: [
        plot({ name: "older", observations: [session("older", "quiet", 10)] }),
        plot({ name: "newer", observations: [session("newer", "quiet", 20)] }),
      ],
    });
    expect(rows.map((row) => row.workspace.name)).toEqual(["newer", "older"]);
  });

  it("reorders when the latest Codex session activity changes", () => {
    const rowsAt = (older: number, newer: number) =>
      plotListRows({
        ...empty,
        workspaces: [
          plot({
            name: "alpha",
            observations: [session("alpha", "quiet", older)],
          }),
          plot({
            name: "beta",
            observations: [session("beta", "quiet", newer)],
          }),
        ],
      });

    const first = steadyRows(rowsAt(1, 2), undefined);
    expect(first.rows.map((row) => row.workspace.name)).toEqual([
      "beta",
      "alpha",
    ]);

    // Alpha's agent writes a line, so it is now the most recent.
    const second = steadyRows(rowsAt(3, 2), first.order);
    expect(second.rows.map((row) => row.workspace.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(second.order).not.toBe(first.order);
  });

  it("reorders when a plot's rank really changes", () => {
    const calm = plotListRows({
      ...empty,
      workspaces: [plot({ name: "alpha" }), plot({ name: "beta" })],
    });
    const held = steadyRows(calm, undefined);

    const alarmed = plotListRows({
      ...empty,
      workspaces: [
        plot({
          name: "alpha",
          git: {
            branch: "alpha",
            ahead: 0,
            behind: 0,
            staged: 0,
            unstaged: 0,
            untracked: 0,
            conflicted: 2,
          },
        }),
        plot({ name: "beta" }),
      ],
    });
    expect(
      steadyRows(alarmed, held.order).rows.map((row) => row.workspace.name),
    ).toEqual(["alpha", "beta"]);
  });

  it("reorders when a Codex session becomes active", () => {
    const calm = plotListRows({
      ...empty,
      workspaces: [
        plot({ name: "trunk", isPrimary: true }),
        plot({ name: "working" }),
      ],
    });
    const held = steadyRows(calm, undefined);

    const active = plotListRows({
      ...empty,
      workspaces: [
        plot({ name: "trunk", isPrimary: true }),
        plot({
          name: "working",
          observations: [session("working", "active", 10)],
        }),
      ],
    });

    expect(
      steadyRows(active, held.order).rows.map((row) => row.workspace.name),
    ).toEqual(["working", "trunk"]);
  });

  it("filters by the same query the canvas answers to", () => {
    const rows = plotListRows({
      ...empty,
      query: "auth",
      workspaces: [plot({ name: "auth-callback" }), plot({ name: "billing" })],
    });
    expect(rows.map((row) => row.workspace.name)).toEqual(["auth-callback"]);
  });

  it("keeps every row when the query names the containing repository", () => {
    const workspaces = [plot({ name: "auth" }), plot({ name: "billing" })];
    const rows = plotListRows({
      ...empty,
      query: "github.com/example/app",
      project: {
        id: "github.com/example/app",
        name: "app",
        rootPath: "/repos/app",
        remoteUrl: "https://github.com/example/app",
        workspaces,
        branches: [],
        remoteBranches: [],
      },
      workspaces,
    });

    expect(rows.map((row) => row.workspace.name)).toEqual(["auth", "billing"]);
  });

  it("surfaces Convex deployments and counts active sessions", () => {
    const rows = plotListRows({
      ...empty,
      workspaces: [
        plot({
          name: "backend",
          observations: [
            {
              connectorId: "convex",
              workspaceId: "backend",
              kind: "deployment",
              state: "active",
              label: "hearty-lemur-123",
              detail: "dev",
              url: "https://dashboard.convex.dev/d/hearty-lemur-123",
            },
            session("backend", "active", 30),
          ],
        }),
      ],
    });
    const row = rows[0];
    expect(row?.convex.map((resource) => resource.label)).toEqual([
      "hearty-lemur-123",
    ]);
    expect(row?.convex[0]?.state).toBe("active");
    expect(row?.convex[0]?.dashboardUrl).toBe(
      "https://dashboard.convex.dev/d/hearty-lemur-123",
    );
    expect(row?.activeSessions).toBe(1);
  });

  it("shows a supervised convex dev command only while it does something", () => {
    const commands = [["convex", { run: "bunx convex dev" }]] as const;
    const running = plotListRows({
      ...empty,
      commands,
      processes: [
        { plotPath: "/plots/backend", id: "convex", status: "running" },
      ],
      workspaces: [plot({ name: "backend" })],
    });
    expect(running[0]?.convex.map((resource) => resource.state)).toEqual([
      "active",
    ]);

    const stopped = plotListRows({
      ...empty,
      commands,
      workspaces: [plot({ name: "backend" })],
    });
    expect(stopped[0]?.convex).toEqual([]);
  });
});

describe("activityLabel", () => {
  it("stays coarse across the useful range", () => {
    const now = 100 * 24 * 60 * 60_000;
    expect(activityLabel(undefined, now)).toBeUndefined();
    expect(activityLabel(now - 30_000, now)).toBe("just now");
    expect(activityLabel(now - 5 * 60_000, now)).toBe("5m ago");
    expect(activityLabel(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(activityLabel(now - 49 * 60 * 60_000, now)).toBe("2d ago");
  });
});
