import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@silvic/contracts";

import {
  cardRuntimeState,
  cardSignals,
  plotCardActions,
  plotConclusion,
  workspaceState,
} from "./state";

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

describe("workspaceState adoption", () => {
  it("calls a discovered external worktree not adopted even when a session is active", () => {
    expect(
      workspaceState({
        ...workspace,
        adoption: {
          status: "not-adopted",
          at: new Date(0).toISOString(),
          attempt: 0,
        },
        observations: [
          {
            connectorId: "local-context",
            workspaceId: workspace.workspaceId,
            kind: "session",
            state: "active",
            label: "Codex task",
          },
        ],
      }),
    ).toEqual({ label: "Not adopted", tone: "attention" });
  });
});

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
      startIds: [],
      stopIds: ["web", "convex"],
    });
  });

  it("offers both Start and Stop when a Plot is partially running", () => {
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
      label: "1/2 running",
      startIds: ["convex"],
      stopIds: ["web"],
    });
  });

  it("shows Stopped and starts every declared runtime when none is running", () => {
    expect(cardRuntimeState({ workspace, commands, processes: [] })).toEqual({
      tone: "quiet",
      label: "Stopped",
      startIds: ["web", "convex"],
      stopIds: [],
    });
  });

  it("calls a fully failed runtime set Failed, not merely Stopped", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands,
        processes: [
          { plotPath: workspace.path, id: "web", status: "failed" },
          { plotPath: workspace.path, id: "convex", status: "failed" },
        ],
      }),
    ).toEqual({
      tone: "attention",
      label: "Failed",
      startIds: ["web", "convex"],
      stopIds: [],
    });
  });

  it("shows a stop in progress and offers nothing to press meanwhile", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands,
        processes: [
          { plotPath: workspace.path, id: "web", status: "stopping" },
          { plotPath: workspace.path, id: "convex", status: "running" },
        ],
      }),
    ).toEqual({
      tone: "waiting",
      label: "Stopping…",
      startIds: [],
      stopIds: [],
    });
  });

  it("shows Starting until a named preview is actually reachable", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands,
        processes: [
          { plotPath: workspace.path, id: "web", status: "starting" },
          { plotPath: workspace.path, id: "convex", status: "running" },
        ],
      }),
    ).toEqual({
      tone: "waiting",
      label: "Starting…",
      startIds: [],
      stopIds: ["web", "convex"],
    });
  });

  it("carries the supervisor's advice for a failed runtime", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands: [commands[0]],
        processes: [
          {
            plotPath: workspace.path,
            id: "web",
            status: "failed",
            exitCode: 1,
            advice: "The named HTTPS URL needs portless.",
          },
        ],
      }),
    ).toMatchObject({
      label: "Failed",
      advice: "The named HTTPS URL needs portless.",
    });
  });

  it("drops the count when a Plot declares a single runtime", () => {
    expect(
      cardRuntimeState({
        workspace,
        commands: [commands[0]],
        processes: [{ plotPath: workspace.path, id: "web", status: "running" }],
      }),
    ).toEqual({
      tone: "active",
      label: "Running",
      startIds: [],
      stopIds: ["web"],
    });
  });
});

describe("plotConclusion", () => {
  const mergedReview = {
    connectorId: "github",
    workspaceId: workspace.workspaceId,
    kind: "review",
    state: "quiet",
    label: "#251 merged",
    metadata: { number: 251, state: "MERGED" },
  } as const;

  it("reads a merged pull request as the plot's ending", () => {
    expect(plotConclusion({ ...workspace, observations: [mergedReview] })).toBe(
      "merged",
    );
  });

  it("never concludes the primary checkout", () => {
    expect(
      plotConclusion({
        ...workspace,
        isPrimary: true,
        observations: [mergedReview],
      }),
    ).toBeUndefined();
  });

  it("lets Merged outrank leftover local changes in the state word", () => {
    expect(
      workspaceState({
        ...workspace,
        git: { ...workspace.git, unstaged: 5 },
        observations: [mergedReview],
      }),
    ).toEqual({ label: "Merged", tone: "ready" });
  });
});

describe("plotCardActions", () => {
  it("keeps Start available next to teardown after a pull request merged", () => {
    expect(
      plotCardActions({
        conclusion: "merged",
        runtime: {
          tone: "quiet",
          label: "Stopped",
          startIds: ["web", "convex"],
          stopIds: [],
        },
      }),
    ).toEqual({ teardown: true, start: true, stop: false });
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

  it("labels a deployment by kind and keeps its name for the tooltip", () => {
    expect(
      cardSignals({
        ...workspace,
        observations: [
          {
            connectorId: "convex",
            workspaceId: workspace.workspaceId,
            kind: "deployment",
            state: "active",
            label: "proficient-hare-568",
            detail: "dev",
            url: "https://dashboard.convex.dev/d/proficient-hare-568",
          },
        ],
      })[0],
    ).toEqual({
      kind: "deployment",
      tone: "active",
      text: "Deployment",
      hint: "dev · proficient-hare-568",
      url: "https://dashboard.convex.dev/d/proficient-hare-568",
    });
  });

  it("labels a session by kind and keeps its codename for the tooltip", () => {
    expect(
      cardSignals({
        ...workspace,
        observations: [
          {
            connectorId: "codex",
            workspaceId: workspace.workspaceId,
            kind: "session",
            state: "active",
            label: "calculating-heron-688",
            detail: "Fix the named HTTPS e2e flake",
          },
        ],
      })[0],
    ).toEqual({
      kind: "session",
      tone: "active",
      text: "Session",
      hint: "Fix the named HTTPS e2e flake",
    });
  });
});
