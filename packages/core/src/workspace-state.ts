import { createHash } from "node:crypto";
import { normalize } from "node:path";

import type { WorkspaceRecord } from "./workspace-registry";

export const dayDurationMs = 24 * 60 * 60 * 1_000;
export const workspaceRecordRetentionMs = 30 * dayDurationMs;

export type WorkspaceStateProtection =
  | "active-runtime"
  | "active-session"
  | "discovered-workspace"
  | "existing-location"
  | "invalid-metadata"
  | "provider-state";

export interface WorkspaceStateStorage {
  path: string;
  bytes: number;
  ownership: "silvic" | "codex" | "observed";
  note: string;
}

export interface StaleWorkspaceRecordPlan {
  workspaceId: string;
  projectId: string;
  path: string;
  branch: string;
  missingSince: string;
  ageDays: number;
  action: "protect" | "retain" | "prune-metadata";
  reasons: readonly WorkspaceStateProtection[];
}

export interface WorkspaceStatePlan {
  planId: string;
  generatedAt: string;
  retentionDays: number;
  totalRecords: number;
  activeRecords: number;
  staleRecords: readonly StaleWorkspaceRecordPlan[];
  prunableRecordIds: readonly string[];
  storage: readonly WorkspaceStateStorage[];
  boundaries: readonly string[];
}

export interface WorkspaceStatePlanInput {
  records: readonly WorkspaceRecord[];
  observedWorkspaceIds?: ReadonlySet<string>;
  existingPaths?: ReadonlySet<string>;
  activeRuntimePaths?: ReadonlySet<string>;
  activeHarnessWorkspaceIds?: ReadonlySet<string>;
  providerStatePaths?: ReadonlySet<string>;
  storage?: readonly WorkspaceStateStorage[];
  now?: Date;
  retentionMs?: number;
}

export function planWorkspaceState(
  input: WorkspaceStatePlanInput,
): WorkspaceStatePlan {
  const now = input.now ?? new Date();
  const retentionMs = input.retentionMs ?? workspaceRecordRetentionMs;
  const observed = input.observedWorkspaceIds ?? new Set<string>();
  const existing = normalized(input.existingPaths);
  const runtimes = normalized(input.activeRuntimePaths);
  const harnessWorkspaces =
    input.activeHarnessWorkspaceIds ?? new Set<string>();
  const providerPaths = normalized(input.providerStatePaths);
  const staleRecords = input.records
    .filter((record) => record.missingSince !== undefined)
    .map((record): StaleWorkspaceRecordPlan => {
      const path = normalize(record.path);
      const reasons = new Set<WorkspaceStateProtection>();
      if (observed.has(record.workspaceId)) reasons.add("discovered-workspace");
      if (existing.has(path)) reasons.add("existing-location");
      if (runtimes.has(path)) reasons.add("active-runtime");
      if (harnessWorkspaces.has(record.workspaceId)) {
        reasons.add("active-session");
      }
      if (providerPaths.has(path) || hasTaskOrAdoptionProtection(record)) {
        reasons.add("provider-state");
      }
      const missingAt = Date.parse(record.missingSince!);
      if (!Number.isFinite(missingAt)) reasons.add("invalid-metadata");
      const ageMs = Number.isFinite(missingAt)
        ? Math.max(0, now.getTime() - missingAt)
        : 0;
      const action =
        reasons.size > 0
          ? "protect"
          : ageMs < retentionMs
            ? "retain"
            : "prune-metadata";
      return {
        workspaceId: record.workspaceId,
        projectId: record.projectId,
        path: record.path,
        branch: record.branch,
        missingSince: record.missingSince!,
        ageDays: Math.floor(ageMs / dayDurationMs),
        action,
        reasons: [...reasons].sort(),
      };
    })
    .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  const prunableRecordIds = staleRecords
    .filter((record) => record.action === "prune-metadata")
    .map((record) => record.workspaceId);
  const generatedAt = now.toISOString();
  const planId = `state_${createHash("sha256")
    .update(
      JSON.stringify({
        retentionMs,
        records: staleRecords.map((record) => ({
          id: record.workspaceId,
          path: normalize(record.path),
          missingSince: record.missingSince,
          action: record.action,
          reasons: record.reasons,
        })),
      }),
    )
    .digest("hex")
    .slice(0, 16)}`;
  return {
    planId,
    generatedAt,
    retentionDays: retentionMs / dayDurationMs,
    totalRecords: input.records.length,
    activeRecords: input.records.length - staleRecords.length,
    staleRecords,
    prunableRecordIds,
    storage: [...(input.storage ?? [])],
    boundaries: [
      "Apply removes only the listed Silvic workspace records.",
      "Git/Codex worktrees, directories, branches, sessions, and processes are never removed.",
      "Existing locations, active runtimes/Harness Sessions, and task/adoption/provisioning state are protected.",
    ],
  };
}

export function applyWorkspaceStatePlan(
  records: readonly WorkspaceRecord[],
  plan: WorkspaceStatePlan,
  confirmPlanId: string,
): { records: WorkspaceRecord[]; removed: readonly WorkspaceRecord[] } {
  if (confirmPlanId !== plan.planId) {
    throw new Error(`Confirm this exact state plan with ${plan.planId}.`);
  }
  const targets = new Set(plan.prunableRecordIds);
  const removed = records.filter((record) => targets.has(record.workspaceId));
  if (removed.length !== targets.size) {
    throw new Error(
      "Workspace state changed; inspect a fresh plan before applying.",
    );
  }
  return {
    records: records.filter((record) => !targets.has(record.workspaceId)),
    removed,
  };
}

function normalized(paths: ReadonlySet<string> | undefined): Set<string> {
  return new Set([...(paths ?? [])].map(normalize));
}

function hasTaskOrAdoptionProtection(record: WorkspaceRecord): boolean {
  return (
    record.task?.issue !== undefined ||
    record.adoption?.status === "adopted" ||
    record.adoption?.status === "adopting" ||
    record.adoption?.status === "failed"
  );
}
