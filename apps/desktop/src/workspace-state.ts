import { normalize } from "node:path";

import { AutomationError } from "@silvic/automation";
import type { SilvicSnapshot } from "@silvic/contracts";
import {
  applyWorkspaceStatePlan,
  planWorkspaceState,
  type SupervisedCommand,
  type WorkspaceRecord,
  type WorkspaceStatePlan,
  type WorkspaceStateStorage,
} from "@silvic/core";

export interface WorkspaceStateServiceOptions {
  records(): readonly WorkspaceRecord[];
  persist(records: readonly WorkspaceRecord[]): void;
  snapshot(): SilvicSnapshot;
  refreshAuthoritative(): Promise<void>;
  existing(path: string): boolean;
  activeRuntimes(): readonly SupervisedCommand[];
  activeHarnessWorkspaceIds(
    records: readonly WorkspaceRecord[],
  ): Promise<ReadonlySet<string>>;
  providerStatePaths(): ReadonlySet<string>;
  storage(): Promise<readonly WorkspaceStateStorage[]>;
  now?(): Date;
}

/** Inspect-first reconciliation over Silvic-owned registry metadata only. */
export class WorkspaceStateService {
  constructor(private readonly options: WorkspaceStateServiceOptions) {}

  /** Pure observation: never refreshes or persists registry state. */
  inspect(): Promise<WorkspaceStatePlan> {
    return this.plan({ refresh: false, includeStorage: true });
  }

  /** Reconcile, re-plan, then remove only the exactly confirmed metadata. */
  async prune(confirmPlanId: string): Promise<{
    plan: WorkspaceStatePlan;
    removedRecordIds: readonly string[];
  }> {
    const plan = await this.plan({ refresh: true, includeStorage: false });
    let applied: ReturnType<typeof applyWorkspaceStatePlan>;
    try {
      applied = applyWorkspaceStatePlan(
        this.options.records(),
        plan,
        confirmPlanId,
      );
    } catch (error) {
      throw new AutomationError(
        "STATE_PLAN_CONFIRMATION_REQUIRED",
        error instanceof Error ? error.message : String(error),
        { planId: plan.planId, targets: plan.prunableRecordIds },
      );
    }
    this.options.persist(applied.records);
    return {
      plan,
      removedRecordIds: applied.removed.map((record) => record.workspaceId),
    };
  }

  private async plan(options: {
    refresh: boolean;
    includeStorage: boolean;
  }): Promise<WorkspaceStatePlan> {
    if (options.refresh) await this.options.refreshAuthoritative();
    const records = this.options.records();
    const observedWorkspaceIds = new Set(
      this.options
        .snapshot()
        .projects.flatMap((project) =>
          project.workspaces.map((workspace) => workspace.workspaceId),
        ),
    );
    const activeRuntimePaths = new Set(
      this.options
        .activeRuntimes()
        .filter((runtime) =>
          ["starting", "running", "stopping"].includes(runtime.status),
        )
        .map((runtime) => normalize(runtime.plotPath)),
    );
    return planWorkspaceState({
      records,
      observedWorkspaceIds,
      existingPaths: new Set(
        records
          .filter((record) => this.options.existing(record.path))
          .map((record) => normalize(record.path)),
      ),
      activeRuntimePaths,
      activeHarnessWorkspaceIds:
        await this.options.activeHarnessWorkspaceIds(records),
      providerStatePaths: this.options.providerStatePaths(),
      ...(options.includeStorage
        ? { storage: await this.options.storage() }
        : {}),
      ...(this.options.now ? { now: this.options.now() } : {}),
    });
  }
}
