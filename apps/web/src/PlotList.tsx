import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import type {
  HarnessDefinition,
  HarnessId,
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
import { HarnessMark } from "./providers";
import { harnessLabel } from "./harnesses";
import {
  PlotMenu,
  PlotMenuTrigger,
  PlotRenameForm,
  PlotRuntimeActions,
} from "./PlotActions";
import { plotConclusion, workingTreeLabel } from "./state";

interface PlotListProps {
  project: ProjectSnapshot;
  commands: readonly (readonly [string, PlotCommand])[];
  declaredResources: Readonly<Record<string, PlotResourceDefinition>>;
  processes: readonly PlotProcess[];
  query: string;
  selectedWorkspaceId: string | undefined;
  onSelect(id: string): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onEditRecipe(): void;
  onNewPlot(): void;
  defaultHarness: HarnessId;
  onSetDefaultHarness(id: HarnessId): void;
  onRename(id: string, name: string): Promise<void>;
  onTeardown(workspace: WorkspaceSnapshot): void;
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
  onOpen,
  onEditRecipe,
  onNewPlot,
  defaultHarness,
  onSetDefaultHarness,
  onRename,
  onTeardown,
}: PlotListProps) {
  const [menuPlotId, setMenuPlotId] = useState<string>();
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
        <span className="micro plot-list-col-plot">Plot</span>
        <span className="micro plot-list-col-status">Status</span>
        <span className="micro plot-list-col-runtime">Runtime</span>
        <span className="micro plot-list-col-convex">Convex</span>
        <span className="micro plot-list-col-changes">Working tree</span>
        <span className="micro plot-list-col-activity">Activity</span>
        <span className="micro plot-list-col-actions">Actions</span>
      </div>
      <div className="plot-list-rows">
        {rows.map((row) => (
          <Row
            key={row.workspace.workspaceId}
            row={row}
            now={now}
            active={row.workspace.workspaceId === selectedWorkspaceId}
            onSelect={() => onSelect(row.workspace.workspaceId)}
            menuOpen={menuPlotId === row.workspace.workspaceId}
            onOpenMenu={() => setMenuPlotId(row.workspace.workspaceId)}
            onCloseMenu={() => setMenuPlotId(undefined)}
            onOpen={onOpen}
            onEditRecipe={onEditRecipe}
            onNewPlot={onNewPlot}
            defaultHarness={defaultHarness}
            onSetDefaultHarness={onSetDefaultHarness}
            onRename={onRename}
            onTeardown={onTeardown}
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
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  onOpen,
  onEditRecipe,
  onNewPlot,
  defaultHarness,
  onSetDefaultHarness,
  onRename,
  onTeardown,
}: {
  row: PlotListRow;
  now: number;
  active: boolean;
  onSelect(): void;
  menuOpen: boolean;
  onOpenMenu(): void;
  onCloseMenu(): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onEditRecipe(): void;
  onNewPlot(): void;
  defaultHarness: HarnessId;
  onSetDefaultHarness(id: HarnessId): void;
  onRename(id: string, name: string): Promise<void>;
  onTeardown(workspace: WorkspaceSnapshot): void;
}) {
  const { workspace, state, runtime, convex, activeSessions } = row;
  const [renaming, setRenaming] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const conclusion = plotConclusion(workspace);
  const externalRuntime = row.resources.find(
    (resource) =>
      resource.commandId === undefined &&
      (resource.kind === "runtime" || resource.kind === "agent"),
  );
  const runtimeUrl =
    row.resources.find(
      (resource) =>
        resource.commandId !== undefined &&
        resource.state === "active" &&
        resource.url,
    )?.url ?? externalRuntime?.url;
  return (
    <article
      className="plot-list-row plot-list-grid"
      data-active={active || undefined}
    >
      {renaming ? (
        <div className="plot-list-plot">
          <i className="dot" data-tone={state.tone} />
          <PlotRenameForm
            workspace={workspace}
            onRename={onRename}
            onDone={() => setRenaming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="plot-list-plot plot-list-select"
          aria-label={`Select ${workspace.name}`}
          aria-current={active ? "true" : undefined}
          onClick={onSelect}
        >
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
        </button>
      )}
      <span className="plot-list-col-status">
        <span className="state-pill" data-tone={state.tone}>
          <i className="dot" />
          {state.label}
        </span>
      </span>
      {runtime ? (
        <span
          className="plot-list-runtime plot-list-col-runtime mono"
          data-tone={runtime.tone}
          title={
            [
              runtime.advice,
              externalRuntime
                ? `${externalRuntime.label} is managed outside Silvic`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
        >
          {runtime.label}
          {externalRuntime ? " · External" : ""}
        </span>
      ) : externalRuntime ? (
        <span
          className="plot-list-runtime plot-list-col-runtime mono"
          data-tone={externalRuntime.state}
          title={`${externalRuntime.label} is observed but managed outside Silvic`}
        >
          External
        </span>
      ) : (
        <span className="plot-list-none plot-list-col-runtime">—</span>
      )}
      <ConvexCell resources={convex} />
      <span
        className="plot-list-changes plot-list-col-changes mono"
        data-quiet={changesQuiet(workspace) || undefined}
      >
        {changesLabel(workspace)}
      </span>
      <span
        className="plot-list-activity plot-list-col-activity mono"
        data-tone={activeSessions > 0 ? "active" : undefined}
      >
        {activeSessions > 0
          ? `${activeSessions} session${activeSessions === 1 ? "" : "s"}`
          : (activityLabel(row.activityAt, now) ?? "—")}
      </span>
      <div className="plot-list-actions plot-list-col-actions">
        <button
          type="button"
          className="plot-list-open"
          aria-label={`Open ${workspace.name} in ${harnessLabel(defaultHarness)}`}
          title={`Open in ${harnessLabel(defaultHarness)}`}
          onClick={() => onOpen(workspace.path, defaultHarness)}
        >
          <HarnessMark id={defaultHarness} size={13} />
        </button>
        <PlotRuntimeActions
          workspace={workspace}
          runtime={runtime}
          conclusion={conclusion}
          onTeardown={onTeardown}
        />
        {workspace.isPrimary && (
          <button
            type="button"
            className="plot-new"
            aria-label="New plot from here"
            title="New plot"
            onClick={onNewPlot}
          >
            <Plus size={14} />
          </button>
        )}
        <PlotMenuTrigger
          workspaceId={workspace.workspaceId}
          workspaceName={workspace.name}
          expanded={menuOpen}
          buttonRef={menuButton}
          onToggle={menuOpen ? onCloseMenu : onOpenMenu}
        />
      </div>
      {menuOpen && (
        <PlotMenu
          anchor={menuButton.current}
          workspace={workspace}
          runtimeUrl={runtimeUrl}
          defaultHarness={defaultHarness}
          onClose={onCloseMenu}
          onOpen={onOpen}
          onSetDefaultHarness={onSetDefaultHarness}
          onEditRecipe={onEditRecipe}
          onRename={() => setRenaming(true)}
          onTeardown={onTeardown}
        />
      )}
    </article>
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
    return <span className="plot-list-none plot-list-col-convex">—</span>;
  }
  return (
    <div className="plot-list-convex plot-list-col-convex">
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
