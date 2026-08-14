import { randomUUID } from "node:crypto";
import { normalize } from "node:path";

import type {
  SilvicSnapshot,
  TaskContext,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { resolveDisplayName } from "./workspace-names";

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

/** Persist a human name without disturbing the Plot's identity or lineage. */
export function renameWorkspaceRecord(
  records: readonly WorkspaceRecord[],
  workspaceId: string,
  displayName: string,
): WorkspaceRecord[] {
  let found = false;
  const renamed = records.map((record) => {
    if (record.workspaceId !== workspaceId) return { ...record };
    found = true;
    return { ...record, displayName };
  });
  if (!found) throw new Error("Unknown plot");
  return renamed;
}

export class WorkspaceRegistry {
  reconcile(
    snapshot: SilvicSnapshot,
    existingRecords: readonly WorkspaceRecord[],
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
        stableWorkspace(workspace, record, transientToStable, primaryId),
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
): WorkspaceSnapshot {
  const stableId = record.workspaceId;
  const parentWorkspaceId =
    record.parentWorkspaceId ?? (!workspace.isPrimary ? primaryId : undefined);
  const sessionName = !workspace.isPrimary
    ? workspace.observations.find(
        (observation) => observation.kind === "session",
      )?.label
    : undefined;
  return {
    ...workspace,
    workspaceId: stableId,
    name: resolveDisplayName({
      path: workspace.path,
      recorded: record.displayName,
      ...(sessionName ? { sessionName } : {}),
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
