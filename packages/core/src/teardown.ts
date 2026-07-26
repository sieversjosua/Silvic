import type { WorkspaceSnapshot } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import { requireSuccess } from "./command-runner";

/**
 * Three rungs, each reversible at increasing cost:
 *
 * - `stop`    ends processes. Free, instant, nothing lost.
 * - `archive` releases what a plot holds, keeping files and branch.
 * - `remove`  deletes the worktree, and the branch only if asked.
 */
export type TeardownScope = "stop" | "archive" | "remove";

export interface TeardownStep {
  id: string;
  label: string;
  detail: string;
  /**
   * Set when Silvic cannot perform the step itself. The step is still shown,
   * with the reason, rather than quietly dropped — otherwise a plan would imply
   * work that never happens.
   */
  manual?: string;
  url?: string;
}

export interface TeardownPlan {
  scope: TeardownScope;
  steps: readonly TeardownStep[];
  /** Reasons the plan must not run. Empty means it is safe to confirm. */
  blockers: readonly string[];
  /** What survives, said plainly so the plan is not read as "everything goes". */
  keeps: readonly string[];
}

export interface TeardownRequest {
  workspace: WorkspaceSnapshot;
  scope: TeardownScope;
  deleteBranch: boolean;
}

export function planTeardown({
  workspace,
  scope,
  deleteBranch,
}: TeardownRequest): TeardownPlan {
  const steps: TeardownStep[] = [];
  const blockers: string[] = [];
  const keeps: string[] = [];

  // The trunk is the project on the canvas; tearing it down would remove the
  // thing every other plot hangs off.
  if (workspace.isPrimary) {
    blockers.push(
      "This is the project's primary checkout, not a plot. Silvic will not tear it down.",
    );
  }

  const running = workspace.observations.filter(
    (observation) => observation.kind === "runtime" && observation.state === "active",
  );
  for (const process of running) {
    steps.push({
      id: `stop:${process.connectorId}:${process.label}`,
      label: `Stop ${process.label}`,
      detail: process.detail ?? "Running process",
      // Silvic has no process supervision yet, so it did not start this and
      // cannot end it.
      manual: "Silvic did not start this process and cannot stop it yet",
      ...(process.url ? { url: process.url } : {}),
    });
  }
  if (scope === "stop") {
    keeps.push("Everything else. Stopping only ends processes.");
    return { scope, steps, blockers, keeps };
  }

  const deployments = workspace.observations.filter(
    (observation) => observation.kind === "deployment",
  );
  for (const deployment of deployments) {
    steps.push({
      id: `release:${deployment.connectorId}:${deployment.label}`,
      label: `Release ${deployment.label}`,
      detail: deployment.detail ?? "Provider deployment",
      // Verified against the CLI: `convex deployment` offers select, create and
      // token, and nothing that deletes.
      manual:
        "The Convex CLI cannot delete a deployment. This one keeps costing until you remove it in the dashboard.",
      ...(deployment.url ? { url: deployment.url } : {}),
    });
  }

  if (scope === "archive") {
    keeps.push("The worktree and its files");
    keeps.push(`The branch ${workspace.branch}`);
    return { scope, steps, blockers, keeps };
  }

  const uncommitted =
    workspace.git.staged +
    workspace.git.unstaged +
    workspace.git.untracked +
    workspace.git.conflicted;
  if (uncommitted > 0) {
    blockers.push(
      `${uncommitted} uncommitted change${uncommitted === 1 ? "" : "s"} would be lost. Commit or discard them first.`,
    );
  }
  if (workspace.git.ahead > 0) {
    blockers.push(
      `${workspace.git.ahead} commit${workspace.git.ahead === 1 ? "" : "s"} are not pushed. Push them first, or they only exist here.`,
    );
  }

  if (workspace.locationKind === "worktree") {
    steps.push({
      id: "worktree",
      label: "Remove the worktree",
      detail: workspace.path,
    });
  } else {
    steps.push({
      id: "worktree",
      label: "Remove the checkout",
      detail: workspace.path,
      manual:
        "This is an independent clone rather than a linked worktree. Delete the directory yourself.",
    });
  }

  if (deleteBranch) {
    if (!workspace.git.upstream) {
      blockers.push(
        `${workspace.branch} has no upstream, so deleting it would be the only copy.`,
      );
    }
    steps.push({
      id: "branch",
      label: `Delete the branch ${workspace.branch}`,
      detail: "Refused by Git if it holds unmerged work",
    });
  } else {
    keeps.push(`The branch ${workspace.branch}`);
  }

  return { scope, steps, blockers, keeps };
}

export interface TeardownStepResult {
  id: string;
  label: string;
  status: "done" | "skipped" | "failed";
  output: string;
}

export class TeardownService {
  constructor(private readonly runner: CommandRunner) {}

  /**
   * Runs only the steps Silvic can actually perform. A plan with blockers is
   * refused outright rather than partially applied.
   */
  async execute(
    plan: TeardownPlan,
    context: { path: string; branch: string; projectRoot: string },
  ): Promise<TeardownStepResult[]> {
    if (plan.blockers.length > 0) {
      throw new Error(plan.blockers[0] ?? "This teardown is not safe to run");
    }
    const results: TeardownStepResult[] = [];
    for (const step of plan.steps) {
      if (step.manual) {
        results.push({
          id: step.id,
          label: step.label,
          status: "skipped",
          output: step.manual,
        });
        continue;
      }
      try {
        if (step.id === "worktree") {
          await requireSuccess(this.runner, {
            executable: "git",
            arguments: ["worktree", "remove", context.path],
            cwd: context.projectRoot,
          });
        } else if (step.id === "branch") {
          // `-d` refuses to delete unmerged work; that protection is the point.
          await requireSuccess(this.runner, {
            executable: "git",
            arguments: ["branch", "-d", context.branch],
            cwd: context.projectRoot,
          });
        } else {
          results.push({
            id: step.id,
            label: step.label,
            status: "skipped",
            output: "Nothing for Silvic to do",
          });
          continue;
        }
        results.push({
          id: step.id,
          label: step.label,
          status: "done",
          output: "",
        });
      } catch (error) {
        results.push({
          id: step.id,
          label: step.label,
          status: "failed",
          output: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    return results;
  }
}
