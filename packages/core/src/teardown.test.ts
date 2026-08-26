import { describe, expect, it } from "vitest";

import type {
  ConnectorObservation,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "./command-runner";
import { planTeardown, TeardownService } from "./teardown";

function plot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspaceId: "plot-1",
    projectId: "project",
    path: "/plots/mono-feature-auth",
    repositoryName: "mono",
    branch: "feature/auth",
    name: "feature/auth",
    locationKind: "worktree",
    isPrimary: false,
    git: {
      branch: "feature/auth",
      upstream: "origin/feature/auth",
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

const deployment: ConnectorObservation = {
  connectorId: "convex",
  workspaceId: "plot-1",
  kind: "deployment",
  state: "active",
  label: "brazen-labrador-831",
  url: "https://dashboard.convex.dev/d/brazen-labrador-831",
};

const runtime: ConnectorObservation = {
  connectorId: "work-cli",
  workspaceId: "plot-1",
  kind: "runtime",
  state: "active",
  label: "web",
  detail: "running via tmux",
};

describe("planTeardown", () => {
  it("refuses to tear down the project's primary checkout", () => {
    const plan = planTeardown({
      workspace: plot({ isPrimary: true }),
      scope: "remove",
      deleteBranch: false,
    });

    expect(plan.blockers[0]).toMatch(/primary checkout/i);
  });

  it("stopping touches processes and nothing else", () => {
    const plan = planTeardown({
      workspace: plot({ observations: [runtime, deployment] }),
      scope: "stop",
      deleteBranch: false,
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.label).toBe("Stop web");
    // The deployment is not touched by stopping.
    expect(plan.steps.some((step) => step.id.startsWith("release:"))).toBe(
      false,
    );
  });

  it("says plainly that it cannot delete a Convex deployment", () => {
    const plan = planTeardown({
      workspace: plot({ observations: [deployment] }),
      scope: "archive",
      deleteBranch: false,
    });

    const release = plan.steps.find((step) => step.id.startsWith("release:"));
    expect(release?.manual).toMatch(/cannot delete/i);
    expect(release?.manual).toMatch(/costing/i);
    expect(release?.url).toBe(deployment.url);
  });

  it("archiving keeps the files and the branch", () => {
    const plan = planTeardown({
      workspace: plot(),
      scope: "archive",
      deleteBranch: false,
    });

    expect(plan.keeps.join(" ")).toMatch(/worktree/i);
    expect(plan.keeps.join(" ")).toMatch(/feature\/auth/);
    expect(plan.steps.some((step) => step.id === "worktree")).toBe(false);
  });

  it("blocks removal while work is uncommitted", () => {
    const plan = planTeardown({
      workspace: plot({
        git: { ...plot().git, unstaged: 3 },
      }),
      scope: "remove",
      deleteBranch: false,
    });

    expect(plan.blockers.join(" ")).toMatch(/3 uncommitted changes/);
  });

  it("removes a worktree holding unpushed commits, since the branch keeps them", () => {
    const plan = planTeardown({
      workspace: plot({ git: { ...plot().git, ahead: 2 } }),
      scope: "remove",
      deleteBranch: false,
      heldOnlyHere: 2,
    });

    // Deleting a worktree deletes no commits. They are still on the branch,
    // which this plan keeps.
    expect(plan.blockers).toEqual([]);
  });

  it("removes a clean worktree and keeps the branch by default", () => {
    const plan = planTeardown({
      workspace: plot(),
      scope: "remove",
      deleteBranch: false,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps.some((step) => step.id === "worktree")).toBe(true);
    expect(plan.steps.some((step) => step.id === "branch")).toBe(false);
    expect(plan.keeps.join(" ")).toMatch(/feature\/auth/);
  });

  it("will not delete a branch holding commits that exist nowhere else", () => {
    const plan = planTeardown({
      workspace: plot(),
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: 2,
    });

    expect(plan.blockers.join(" ")).toMatch(/2 commits exist only on/i);
  });

  it("deletes a never-pushed branch that holds nothing of its own", () => {
    // The ordinary plot: branched from main, never committed in, no upstream.
    // Nothing is lost by deleting it, so nothing should stand in the way.
    const { upstream: _ignored, ...withoutUpstream } = plot().git;
    const plan = planTeardown({
      workspace: plot({ git: withoutUpstream }),
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: 0,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps.some((step) => step.id === "branch:safe-force")).toBe(
      true,
    );
  });

  it("refuses rather than guesses when the count could not be taken", () => {
    const plan = planTeardown({
      workspace: plot(),
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: undefined,
    });

    expect(plan.blockers.join(" ")).toMatch(/could not tell/i);
  });

  it("hands an independent clone back rather than deleting the directory", () => {
    const plan = planTeardown({
      workspace: plot({ locationKind: "checkout" }),
      scope: "remove",
      deleteBranch: false,
    });

    const step = plan.steps.find((entry) => entry.id === "worktree");
    expect(step?.manual).toMatch(/independent clone/i);
  });
});

describe("deleting a squash-merged branch", () => {
  const mergedAt = (headRefOid: string): ConnectorObservation => ({
    connectorId: "github",
    workspaceId: "plot-1",
    kind: "review",
    state: "quiet",
    label: "#258 merged",
    metadata: { number: 258, state: "MERGED", headRefOid },
  });

  it("forces the deletion when the pull request merged this exact tip", () => {
    // A squash rewrote the two commits, so Git counts them as held only here.
    // GitHub's record of merging this very tip is what proves nothing is lost.
    const plan = planTeardown({
      workspace: plot({
        git: { ...plot().git, revision: "abc123" },
        observations: [mergedAt("abc123")],
      }),
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: 2,
    });

    expect(plan.blockers).toEqual([]);
    expect(plan.steps.some((step) => step.id === "branch:force")).toBe(true);
    expect(plan.steps.some((step) => step.id === "branch")).toBe(false);
  });

  it("still blocks when the branch moved past what GitHub merged", () => {
    // A commit made after the merge is exactly what a forced delete would
    // destroy; the mismatched tip is how the plan notices.
    const plan = planTeardown({
      workspace: plot({
        git: { ...plot().git, revision: "later9" },
        observations: [mergedAt("abc123")],
      }),
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: 3,
    });

    expect(plan.blockers.join(" ")).toMatch(/exist only on/i);
    expect(plan.steps.some((step) => step.id === "branch:force")).toBe(false);
  });

  it("does not force on merged evidence alone when the tip is unknown", () => {
    const plan = planTeardown({
      workspace: plot({ observations: [mergedAt("abc123")] }),
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: 2,
    });

    expect(plan.blockers.join(" ")).toMatch(/exist only on/i);
  });
});

describe("discarding uncommitted work", () => {
  const dirty = () => plot({ git: { ...plot().git, unstaged: 2 } });

  it("refuses by default, and says the way through", () => {
    const plan = planTeardown({
      workspace: dirty(),
      scope: "remove",
      deleteBranch: false,
    });

    expect(plan.blockers.join(" ")).toMatch(/2 uncommitted changes/);
    expect(plan.blockers.join(" ")).toMatch(/discard them here/i);
  });

  it("clears the way when asked, and says what that costs", () => {
    const plan = planTeardown({
      workspace: dirty(),
      scope: "remove",
      deleteBranch: false,
      discardChanges: true,
    });

    expect(plan.blockers).toEqual([]);
    const discard = plan.steps.find((step) => step.id === "discard");
    expect(discard?.label).toMatch(/discard 2 uncommitted changes/i);
    expect(discard?.detail).toMatch(/not tracking/i);
    // The discard has to happen before the removal it exists to allow.
    expect(plan.steps.findIndex((step) => step.id === "discard")).toBeLessThan(
      plan.steps.findIndex((step) => step.id === "worktree"),
    );
  });

  it("has nothing to discard when the tree is clean", () => {
    const plan = planTeardown({
      workspace: plot(),
      scope: "remove",
      deleteBranch: false,
      discardChanges: true,
    });

    expect(plan.steps.some((step) => step.id === "discard")).toBe(false);
  });
});

describe("TeardownService", () => {
  it("force-deletes a branch only after the plan proves its commits survive", async () => {
    const requests: CommandRequest[] = [];
    const runner: CommandRunner = {
      async run(request): Promise<CommandResult> {
        requests.push(request);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const workspace = plot();
    const plan = planTeardown({
      workspace,
      scope: "remove",
      deleteBranch: true,
      heldOnlyHere: 0,
    });

    const results = await new TeardownService(runner).execute(plan, {
      path: workspace.path,
      branch: workspace.branch,
      projectRoot: "/plots",
    });

    expect(results.every((step) => step.status === "done")).toBe(true);
    expect(requests.at(-1)?.arguments).toEqual([
      "branch",
      "-D",
      "feature/auth",
    ]);
  });
});
