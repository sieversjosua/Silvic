import { useEffect, useMemo, useRef, useState } from "react";

import type {
  PlotCommand,
  PlotProcess,
  PlotResource,
  PlotResourceDefinition,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import {
  activityLabel,
  plotListRows,
  steadyRows,
  type PlotListRow,
  type RowOrder,
} from "./plot-list";
import { ConvexMark } from "./providers";
import { workingTreeLabel } from "./state";

interface PlotListProps {
  project: ProjectSnapshot;
  commands: readonly (readonly [string, PlotCommand])[];
  declaredResources: Readonly<Record<string, PlotResourceDefinition>>;
  processes: readonly PlotProcess[];
  query: string;
  selectedWorkspaceId: string | undefined;
  onSelect(id: string): void;
}

/**
 * The structured sibling of the canvas: every plot as one row, ordered by
 * urgency, with the operational facts — state, supervised runtime, Convex
 * backend, working tree — as scannable columns. Selection is shared with the
 * canvas, so clicking a row fills the same inspector.
 */
export function PlotList({
  project,
  commands,
  declaredResources,
  processes,
  query,
  selectedWorkspaceId,
  onSelect,
}: PlotListProps) {
  // The order a person is looking at is held until a plot's rank actually
  // changes; see steadyRows.
  const held = useRef<RowOrder>(undefined);
  const rows = useMemo(() => {
    const fresh = plotListRows({
      workspaces: project.workspaces,
      commands,
      processes,
      declared: declaredResources,
      query,
      project,
    });
    const steady = steadyRows(fresh, held.current);
    held.current = steady.order;
    return steady.rows;
  }, [project.workspaces, commands, processes, declaredResources, query]);
  // The activity column shows coarse relative times; one tick a minute keeps
  // "3m ago" honest without re-deriving anything else.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="plot-list">
      <div className="plot-list-head plot-list-grid">
        <span className="micro">Plot</span>
        <span className="micro">Status</span>
        <span className="micro">Runtime</span>
        <span className="micro">Convex</span>
        <span className="micro">Working tree</span>
        <span className="micro">Activity</span>
      </div>
      <div className="plot-list-rows">
        {rows.map((row) => (
          <Row
            key={row.workspace.workspaceId}
            row={row}
            now={now}
            active={row.workspace.workspaceId === selectedWorkspaceId}
            onSelect={() => onSelect(row.workspace.workspaceId)}
          />
        ))}
        {rows.length === 0 && (
          <p className="plot-list-empty">
            No plots match &ldquo;{query.trim()}&rdquo;.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  now,
  active,
  onSelect,
}: {
  row: PlotListRow;
  now: number;
  active: boolean;
  onSelect(): void;
}) {
  const { workspace, state, runtime, convex, activeSessions } = row;
  return (
    <div
      className="plot-list-row plot-list-grid"
      role="button"
      tabIndex={0}
      data-active={active || undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
      <div className="plot-list-plot">
        <i className="dot" data-tone={state.tone} />
        <div className="plot-list-name">
          <strong className="truncate">
            {workspace.task?.title ?? workspace.name}
          </strong>
          <span className="mono truncate">
            {workspace.branch || "Detached"}
          </span>
        </div>
        {workspace.isPrimary && <span className="micro">Primary</span>}
      </div>
      <span>
        <span className="state-pill" data-tone={state.tone}>
          <i className="dot" />
          {state.label}
        </span>
      </span>
      {runtime ? (
        <span className="plot-list-runtime mono" data-tone={runtime.tone}>
          {runtime.label}
        </span>
      ) : (
        <span className="plot-list-none">—</span>
      )}
      <ConvexCell resources={convex} />
      <span
        className="plot-list-changes mono"
        data-quiet={changesQuiet(workspace) || undefined}
      >
        {changesLabel(workspace)}
      </span>
      <span
        className="plot-list-activity mono"
        data-tone={activeSessions > 0 ? "active" : undefined}
      >
        {activeSessions > 0
          ? `${activeSessions} session${activeSessions === 1 ? "" : "s"}`
          : (activityLabel(row.activityAt, now) ?? "—")}
      </span>
    </div>
  );
}

function changesQuiet(workspace: WorkspaceSnapshot): boolean {
  return changesLabel(workspace) === "Clean";
}

function changesLabel(workspace: WorkspaceSnapshot): string {
  const parts = [workingTreeLabel(workspace)];
  if (workspace.git.ahead > 0) parts.push(`↑${workspace.git.ahead}`);
  if (workspace.git.behind > 0) parts.push(`↓${workspace.git.behind}`);
  return parts.join(" ");
}

/**
 * Everything Convex attached to the plot, deployment and dev server alike. A
 * deployment carries a dashboard address, so the entry opens it; the click must
 * not fall through to the row underneath.
 */
function ConvexCell({ resources }: { resources: readonly PlotResource[] }) {
  if (resources.length === 0) {
    return <span className="plot-list-none">—</span>;
  }
  return (
    <div className="plot-list-convex">
      {resources.map((resource) => {
        const address = resource.dashboardUrl ?? resource.url;
        const body = (
          <>
            <i className="dot" data-tone={resource.state} />
            <ConvexMark size={11} />
            <span className="truncate">{resource.label}</span>
            {/* A command's detail is its run string; only a deployment's
                environment tag is worth column space. */}
            {resource.detail && resource.commandId === undefined && (
              <span className="plot-list-env truncate">{resource.detail}</span>
            )}
          </>
        );
        if (!address) {
          return (
            <span key={resource.id} className="plot-list-deployment">
              {body}
            </span>
          );
        }
        return (
          <button
            key={resource.id}
            type="button"
            className="plot-list-deployment linked"
            title={`Open · ${address}`}
            onClick={(event) => {
              event.stopPropagation();
              void window.silvic.openLink({ url: address });
            }}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
