import { normalize } from "node:path";

import type {
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";
import type { WorkspaceRecord } from "./workspace-registry";

export function snapshotsSemanticallyEqual(
  left: SilvicSnapshot,
  right: SilvicSnapshot,
): boolean {
  return (
    JSON.stringify({ ...left, refreshedAt: "" }) ===
    JSON.stringify({ ...right, refreshedAt: "" })
  );
}

export function workspaceRecordsEqual(
  left: readonly WorkspaceRecord[],
  right: readonly WorkspaceRecord[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A fast scan may cover only the checkout that just changed. Merge that
 * checkout into the known project instead of treating its partial view as the
 * whole project.
 */
export function mergeSnapshots(
  current: SilvicSnapshot,
  incoming: SilvicSnapshot,
): SilvicSnapshot {
  const byId = new Map(
    current.projects.map((project) => [project.id, project]),
  );
  for (const project of incoming.projects) {
    const known = byId.get(project.id);
    byId.set(project.id, known ? mergeProject(known, project) : project);
  }
  return {
    projects: [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    connectorFailures:
      incoming.connectorFailures.length > 0
        ? incoming.connectorFailures
        : current.connectorFailures,
    refreshedAt: incoming.refreshedAt,
  };
}

/**
 * Drops a Workspace whose directory has just been deleted. A removal is
 * authoritative — the files are gone, and no survey can find them again — so it
 * belongs in the snapshot the moment it happens, rather than after the next
 * full survey has finished asking every connector.
 */
export function withoutWorkspace(
  snapshot: SilvicSnapshot,
  path: string,
): SilvicSnapshot {
  const gone = normalize(path);
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      workspaces: project.workspaces.filter(
        (workspace) => normalize(workspace.path) !== gone,
      ),
    })),
  };
}

function mergeProject(
  current: ProjectSnapshot,
  incoming: ProjectSnapshot,
): ProjectSnapshot {
  const primaryPath = normalize(current.rootPath);
  const replacements = new Map(
    incoming.workspaces.map((workspace) => [
      normalize(workspace.path),
      asMember(workspace, primaryPath),
    ]),
  );
  const workspaces: WorkspaceSnapshot[] = current.workspaces.map(
    (workspace) => {
      const replacement = replacements.get(normalize(workspace.path));
      return replacement
        ? {
            ...replacement,
            // Partial snapshots are deliberately Git-only. Connector state
            // remains valid until the enriched refresh replaces it.
            observations: workspace.observations,
          }
        : asMember(workspace, primaryPath);
    },
  );
  const knownPaths = new Set(
    current.workspaces.map((workspace) => normalize(workspace.path)),
  );
  for (const workspace of incoming.workspaces) {
    if (!knownPaths.has(normalize(workspace.path))) {
      workspaces.push(asMember(workspace, primaryPath));
    }
  }

  return {
    ...current,
    workspaces,
    branches: unique([...current.branches, ...incoming.branches]),
    remoteBranches: unique([
      ...current.remoteBranches,
      ...incoming.remoteBranches,
    ]),
  };
}

function asMember(
  workspace: WorkspaceSnapshot,
  primaryPath: string,
): WorkspaceSnapshot {
  const isPrimary = normalize(workspace.path) === primaryPath;
  return workspace.isPrimary === isPrimary
    ? workspace
    : { ...workspace, isPrimary };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
