// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { TeardownPlanPayload, WorkspaceSnapshot } from "@silvic/contracts";

import { TeardownDialog } from "./TeardownDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspace: WorkspaceSnapshot = {
  workspaceId: "plot-1",
  projectId: "project-1",
  path: "/plots/feature",
  repositoryName: "app",
  branch: "feature/valuable-work",
  name: "valuable-work",
  locationKind: "worktree",
  isPrimary: false,
  git: {
    branch: "feature/valuable-work",
    ahead: 2,
    behind: 0,
    staged: 0,
    unstaged: 2,
    untracked: 0,
    conflicted: 0,
  },
  observations: [],
};

const blockedPlan: TeardownPlanPayload = {
  scope: "remove",
  steps: [],
  blockers: ["2 commits exist only on feature/valuable-work."],
  keeps: [],
};

const safePlan: TeardownPlanPayload = {
  scope: "remove",
  steps: [
    {
      id: "discard",
      label: "Discard 2 uncommitted changes",
      detail: "Including files Git is not tracking",
    },
    {
      id: "worktree",
      label: "Remove the worktree",
      detail: workspace.path,
    },
  ],
  blockers: [],
  keeps: [`The branch ${workspace.branch}`],
};

describe("TeardownDialog", () => {
  it("reduces teardown to one safe confirmation and keeps valuable branches", async () => {
    const planTeardown = vi
      .fn()
      .mockResolvedValueOnce(blockedPlan)
      .mockResolvedValueOnce(safePlan);
    const runTeardown = vi.fn().mockResolvedValue({
      results: safePlan.steps.map((step) => ({
        id: step.id,
        label: step.label,
        status: "done",
        output: "",
      })),
      snapshot: { projects: [] },
    });
    Object.defineProperty(window, "silvic", {
      configurable: true,
      value: { planTeardown, runTeardown },
    });
    const onClose = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(TeardownDialog, {
          workspace,
          onClose,
          onFailed: vi.fn(),
        }),
      );
    });

    expect(planTeardown).toHaveBeenNthCalledWith(1, {
      path: workspace.path,
      scope: "remove",
      deleteBranch: true,
      discardChanges: true,
    });
    expect(planTeardown).toHaveBeenNthCalledWith(2, {
      path: workspace.path,
      scope: "remove",
      deleteBranch: false,
      discardChanges: true,
    });
    expect(container.textContent).toContain(
      "2 uncommitted changes will be discarded.",
    );
    expect(container.textContent).toContain("Branch kept");
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      0,
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(".primary-button.danger")
        ?.click();
    });

    expect(runTeardown).toHaveBeenCalledWith({
      path: workspace.path,
      scope: "remove",
      deleteBranch: false,
      discardChanges: true,
    });
    expect(onClose).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
});
