import type {
  PlotCommand,
  PlotProcess,
  PlotResource,
  PlotResourceDefinition,
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
 * The primary checkout stays on top as the fixed point of reference.
 */
export function plotListRows({
  workspaces,
  commands,
  processes,
  declared,
  query,
}: {
  workspaces: readonly WorkspaceSnapshot[];
  commands: readonly (readonly [string, PlotCommand])[];
  processes: readonly PlotProcess[];
  declared: Readonly<Record<string, PlotResourceDefinition>>;
  query: string;
}): readonly PlotListRow[] {
  const commandMap = Object.fromEntries(commands);
  return workspaces
    .filter((workspace) => workspaceMatchesQuery(workspace, query))
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

function compareRows(left: PlotListRow, right: PlotListRow): number {
  if (left.workspace.isPrimary !== right.workspace.isPrimary) {
    return left.workspace.isPrimary ? -1 : 1;
  }
  return (
    rowRank(left) - rowRank(right) ||
    (right.activityAt ?? 0) - (left.activityAt ?? 0) ||
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
