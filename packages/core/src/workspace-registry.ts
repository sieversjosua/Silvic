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
  /**
   * The session title this plot was first named after, kept because a name
   * may not depend on data that arrives late. Silvic paints from Git first
   * and enriches with connector observations a moment later; without a
   * remembered answer, every such paint renamed an opaque harness worktree
   * back to `codex-70b0` and the enrichment renamed it again.
   */
  observedName?: string;
  purpose?: string;
  task?: TaskContext;
  adoption?: WorkspaceSnapshot["adoption"];
  /** Last authoritative scan that found this Workspace. */
  lastSeenAt?: string;
  /** First authoritative scan that no longer found this Workspace. */
  missingSince?: string;
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
    options: { authoritative?: boolean; now?: Date } = {},
  ): ReconciledWorkspaces {
    const authoritative = options.authoritative ?? true;
    const observedAt = (options.now ?? new Date()).toISOString();
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
            lastSeenAt: observedAt,
            ...(!workspace.isPrimary
              ? {
                  adoption: {
                    status: "not-adopted" as const,
                    at: new Date().toISOString(),
                    attempt: 0,
                  },
                }
              : {}),
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
        if (!record.lastSeenAt || record.missingSince) {
          record.lastSeenAt = observedAt;
        }
        delete record.missingSince;
        if (!workspace.isPrimary && !record.adoption) {
          record.adoption = {
            status: "not-adopted",
            at: new Date().toISOString(),
            attempt: 0,
          };
        }
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
    if (authoritative) {
      for (const record of records) {
        if (!claimed.has(record.workspaceId) && !record.missingSince) {
          record.missingSince = observedAt;
        }
      }
    }
    return {
      snapshot: { ...snapshot, projects },
      records,
    };
  }
}

/**
 * The most recent session speaks for the plot. Taking whichever observation
 * came first instead let the answer depend on the order the connectors were
 * read in, so the name changed without anything about the plot changing.
 */
function newestSessionLabel(workspace: WorkspaceSnapshot): string | undefined {
  let best: { label: string; updatedAtMs: number } | undefined;
  for (const observation of workspace.observations) {
    if (observation.kind !== "session" || !observation.label) continue;
    const value = observation.metadata?.["updatedAtMs"];
    const updatedAtMs =
      typeof value === "number" && Number.isFinite(value) ? value : 0;
    if (
      !best ||
      updatedAtMs > best.updatedAtMs ||
      (updatedAtMs === best.updatedAtMs && observation.label < best.label)
    ) {
      best = { label: observation.label, updatedAtMs };
    }
  }
  return best?.label;
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
    record.parentWorkspaceId ??
    workspace.lineage?.parentWorkspaceId ??
    (!workspace.isPrimary ? primaryId : undefined);
  // Written once and then left alone: a plot that has been called something
  // keeps being called that, however many threads are opened in it later.
  if (!workspace.isPrimary && record.observedName === undefined) {
    const observed = newestSessionLabel(workspace);
    if (observed) record.observedName = observed;
  }
  const sessionName = workspace.isPrimary ? undefined : record.observedName;
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
    ...(record.adoption ? { adoption: record.adoption } : {}),
    observations: workspace.observations.map((observation) => ({
      ...observation,
      workspaceId: stableId,
    })),
    ...(parentWorkspaceId
      ? {
          lineage: {
            parentWorkspaceId:
              transientToStable.get(parentWorkspaceId) ?? parentWorkspaceId,
            evidence: record.parentWorkspaceId ? "recorded" : "inferred",
          },
        }
      : {}),
  };
}
