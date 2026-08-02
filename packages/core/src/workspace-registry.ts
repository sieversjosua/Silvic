import { randomUUID } from "node:crypto";
import { normalize } from "node:path";

import type {
  SilvicSnapshot,
  TaskContext,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { resolveDisplayName } from "./work-cli-names";

export interface WorkspaceRecord {
  workspaceId: string;
  projectId: string;
  path: string;
  branch: string;
  parentWorkspaceId?: string;
  displayName?: string;
  purpose?: string;
  task?: TaskContext;
}

export interface ReconciledWorkspaces {
  snapshot: SilvicSnapshot;
  records: readonly WorkspaceRecord[];
}

export class WorkspaceRegistry {
  /**
   * `suggestedNames` maps a normalised path to a name discovered elsewhere,
   * such as work-cli's slug for a harness-created worktree. It is applied at
   * read time rather than stored, so it never masquerades as a name the user
   * chose and never goes stale.
   */
  reconcile(
    snapshot: SilvicSnapshot,
    existingRecords: readonly WorkspaceRecord[],
    suggestedNames: ReadonlyMap<string, string> = new Map(),
  ): ReconciledWorkspaces {
    const records = existingRecords.map((record) => ({ ...record }));
    const claimed = new Set<string>();
    const projects = snapshot.projects.map((project) => {
      const ordered = [
        ...project.workspaces.filter((workspace) => workspace.isPrimary),
        ...project.workspaces.filter((workspace) => !workspace.isPrimary),
      ];
      const transientToStable = new Map<string, string>();
      const matched = ordered.map((workspace) => {
        const record = records.find(
          (candidate) =>
            !claimed.has(candidate.workspaceId) &&
            (candidate.projectId === project.id ||
              candidate.projectId === "legacy") &&
            normalize(candidate.path) === normalize(workspace.path),
        ) ??
          uniqueRecordForBranch(
            records,
            claimed,
            project.id,
            workspace.branch,
          ) ?? {
            workspaceId: randomUUID(),
            projectId: project.id,
            path: workspace.path,
            branch: workspace.branch,
          };
        if (
          !records.some(
            (candidate) => candidate.workspaceId === record.workspaceId,
          )
        ) {
          records.push(record);
        }
        record.projectId = project.id;
        record.path = workspace.path;
        record.branch = workspace.branch;
        claimed.add(record.workspaceId);
        transientToStable.set(workspace.workspaceId, record.workspaceId);
        return { workspace, record };
      });
      const primaryId = matched.find(({ workspace }) => workspace.isPrimary)
        ?.record.workspaceId;
      const workspaces = matched.map(({ workspace, record }) =>
        stableWorkspace(
          workspace,
          record,
          transientToStable,
          primaryId,
          suggestedNames.get(normalize(workspace.path)),
        ),
      );
      return { ...project, workspaces };
    });
    return {
      snapshot: { ...snapshot, projects },
      records,
    };
  }
}

function uniqueRecordForBranch(
  records: readonly WorkspaceRecord[],
  claimed: ReadonlySet<string>,
  projectId: string,
  branch: string,
): WorkspaceRecord | undefined {
  const matches = records.filter(
    (record) =>
      !claimed.has(record.workspaceId) &&
      record.projectId === projectId &&
      record.branch === branch,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function stableWorkspace(
  workspace: WorkspaceSnapshot,
  record: WorkspaceRecord,
  transientToStable: ReadonlyMap<string, string>,
  primaryId: string | undefined,
  suggestedName: string | undefined,
): WorkspaceSnapshot {
  const stableId = record.workspaceId;
  const parentWorkspaceId =
    record.parentWorkspaceId ?? (!workspace.isPrimary ? primaryId : undefined);
  return {
    ...workspace,
    workspaceId: stableId,
    name: resolveDisplayName({
      path: workspace.path,
      recorded: record.displayName,
      workCliName: suggestedName,
      gitName: workspace.name,
    }),
    ...(record.purpose ? { purpose: record.purpose } : {}),
    ...(record.task ? { task: record.task } : {}),
    observations: workspace.observations.map((observation) => ({
      ...observation,
      workspaceId: stableId,
    })),
    ...(parentWorkspaceId
      ? {
          lineage: {
            parentWorkspaceId:
              transientToStable.get(parentWorkspaceId) ?? parentWorkspaceId,
            evidence: record.parentWorkspaceId
              ? ("recorded" as const)
              : ("inferred" as const),
          },
        }
      : {}),
  };
}
