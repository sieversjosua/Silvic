import type {
  PlotCommand,
  PlotProcess,
  PlotResource,
  PlotResourceDefinition,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { latestSessionActivity, workspaceMatchesQuery } from "./grove-layout";
import { plotResources } from "./plot-resources";
import {
  cardRuntimeState,
  workspaceState,
  type CardRuntimeState,
  type OperationalState,
  type Tone,
} from "./state";

export interface PlotListRow {
  workspace: WorkspaceSnapshot;
  /** The plot's overall condition, as the canvas card reports it. */
  state: OperationalState;
  /** The supervised command set, when the recipe declares one. */
  runtime: CardRuntimeState | undefined;
  /** All projected resources, used by row actions such as Copy address. */
  resources: readonly PlotResource[];
  /** Convex backends attached to this exact plot: deployments and dev servers. */
  convex: readonly PlotResource[];
  /** Agent sessions currently active here. */
  activeSessions: number;
  /** Most recent session activity, for the trailing column. */
  activityAt: number | undefined;
}

/**
 * The list answers "what is going on right now" ordered by how much each plot
 * deserves attention, so it cannot share the canvas's spatial lineage order.
 * The latest Codex work comes first. Primary checkout and operational urgency
 * only break ties between plots with the same session activity.
 */
export function plotListRows({
  workspaces,
  commands,
  processes,
  declared,
  query,
  project,
}: {
  workspaces: readonly WorkspaceSnapshot[];
  commands: readonly (readonly [string, PlotCommand])[];
  processes: readonly PlotProcess[];
  declared: Readonly<Record<string, PlotResourceDefinition>>;
  query: string;
  project?: ProjectSnapshot;
}): readonly PlotListRow[] {
  const commandMap = Object.fromEntries(commands);
  return workspaces
    .filter((workspace) => workspaceMatchesQuery(workspace, query, project))
    .map((workspace): PlotListRow => {
      const resources = plotResources({
        workspace,
        commands: commandMap,
        processes,
        declared,
      });
      return {
        workspace,
        state: workspaceState(workspace),
        runtime: cardRuntimeState({ workspace, commands, processes }),
        resources,
        // Deployments always show; a supervised `convex dev` only earns the
        // column while it does something, or every row repeats the recipe.
        convex: resources.filter(
          (resource) =>
            resource.provider === "convex" &&
            (resource.commandId === undefined || resource.state !== "quiet"),
        ),
        activeSessions: workspace.observations.filter(
          (observation) =>
            observation.kind === "session" && observation.state === "active",
        ).length,
        activityAt: latestSessionActivity(workspace),
      };
    })
    .toSorted(compareRows);
}

/** The order the list is currently holding, and what would justify redoing it. */
export interface RowOrder {
  signature: string;
  ids: readonly string[];
}

/**
 * Reordering is allowed when the latest session activity or a plot's standing
 * changes. Runtime tone still changes every few seconds, so the signature keeps
 * ignoring that jitter unless it moves the plot to another rank.
 */
export function steadyRows(
  rows: readonly PlotListRow[],
  previous: RowOrder | undefined,
): { rows: readonly PlotListRow[]; order: RowOrder } {
  const signature = rows
    .map(
      (row) =>
        `${row.workspace.workspaceId}:${row.activityAt ?? 0}:${activeSessionRank(row)}:${rowRank(row)}`,
    )
    .toSorted()
    .join("|");
  const ids = rows.map((row) => row.workspace.workspaceId);
  if (!previous || previous.signature !== signature) {
    return { rows, order: { signature, ids } };
  }
  const position = new Map(
    previous.ids.map((id, index) => [id, index] as const),
  );
  const held = rows.toSorted(
    (left, right) =>
      (position.get(left.workspace.workspaceId) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(right.workspace.workspaceId) ?? Number.MAX_SAFE_INTEGER),
  );
  return { rows: held, order: previous };
}

const urgency: Record<Tone, number> = {
  attention: 0,
  active: 1,
  changed: 2,
  waiting: 3,
  ready: 4,
  unknown: 5,
  quiet: 6,
};

/**
 * A stopped runtime says nothing beyond what the plot state already says, so
 * the runtime only lifts a row, never sinks it.
 */
function rowRank(row: PlotListRow): number {
  const state = urgency[row.state.tone];
  const runtime = row.runtime ? (urgency[row.runtime.tone] ?? state) : state;
  return Math.min(state, runtime);
}

function activeSessionRank(row: PlotListRow): number {
  return row.activeSessions > 0 ? 0 : 1;
}

function compareRows(left: PlotListRow, right: PlotListRow): number {
  const latestActivity = (right.activityAt ?? 0) - (left.activityAt ?? 0);
  if (latestActivity !== 0) return latestActivity;
  const sessionStanding = activeSessionRank(left) - activeSessionRank(right);
  if (sessionStanding !== 0) return sessionStanding;
  if (left.workspace.isPrimary !== right.workspace.isPrimary) {
    return left.workspace.isPrimary ? -1 : 1;
  }
  return (
    rowRank(left) - rowRank(right) ||
    left.workspace.name.localeCompare(right.workspace.name)
  );
}

/** Coarse on purpose: the column orients, it does not timestamp. */
export function activityLabel(
  timestamp: number | undefined,
  now: number,
): string | undefined {
  if (timestamp === undefined) return undefined;
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
