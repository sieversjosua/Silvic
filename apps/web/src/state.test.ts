import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@silvic/contracts";

import { cardRuntimeState, cardSignals } from "./state";

const workspace: WorkspaceSnapshot = {
  workspaceId: "plot-1",
  projectId: "project-1",
  path: "/plots/auth-callback",
  repositoryName: "app",
  branch: "auth-callback",
  name: "auth-callback",
  locationKind: "worktree",
  isPrimary: false,
  git: {
    branch: "auth-callback",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  },
  observations: [],
};

const commands = [
  ["web", { run: "bun run dev", url: true }],
  ["convex", { run: "bunx convex dev" }],
] as const;

describe("cardRuntimeState", () => {
  it("offers one explicit Stop action when every Plot runtime is running", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands,
        processes: [
          { plotPath: workspace.path, id: "web", status: "running" },
          { plotPath: workspace.path, id: "convex", status: "running" },
        ],
      }),
    ).toEqual({
      tone: "active",
      label: "2 running",
      action: "stop",
      targetIds: ["web", "convex"],
    });
  });

  it("offers to start only missing runtimes when a Plot is partially running", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands,
        processes: [
          { plotPath: workspace.path, id: "web", status: "running" },
          { plotPath: workspace.path, id: "convex", status: "failed" },
        ],
      }),
    ).toEqual({
      tone: "attention",
      label: "1 of 2 running",
      action: "start",
      targetIds: ["convex"],
    });
  });

  it("shows Stopped and starts every declared runtime when none is running", () => {
    expect(cardRuntimeState({ workspace, commands, processes: [] })).toEqual({
      tone: "quiet",
      label: "Stopped",
      action: "start",
      targetIds: ["web", "convex"],
    });
  });
});

describe("cardSignals", () => {
  it("describes an observed node process as a local preview, not a Play action", () => {
    expect(
      cardSignals({
        ...workspace,
        observations: [
          {
            connectorId: "local-context",
            workspaceId: workspace.workspaceId,
            kind: "runtime",
            state: "active",
            label: "node",
            url: "http://localhost:3000",
          },
        ],
      })[0],
    ).toEqual({
      kind: "runtime",
      tone: "active",
      text: "Local preview",
      url: "http://localhost:3000",
    });
  });
});
