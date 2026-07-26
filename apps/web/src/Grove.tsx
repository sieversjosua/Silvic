import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Copy,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Link2,
  Maximize2,
  Minus,
  MoreHorizontal,
  Play,
  Plus,
  Radio,
  SlidersHorizontal,
  Trash2,
  Terminal,
  TriangleAlert,
} from "lucide-react";

import type {
  ConnectorObservation,
  HarnessId,
  HarnessDefinition,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { substrate, type Appearance } from "./appearance";
import {
  CodexMark,
  ConvexMark,
  GitHubMark,
  HarnessMark,
} from "./providers";
import {
  QUIET_FOLD_MIN,
  isQuiet,
  layout,
} from "./grove-layout";
import { HarnessRows, harnessLabel } from "./harnesses";
import {
  cardSignals,
  locationLabel,
  workingTreeLabel,
  workspaceState,
  type CardSignal,
} from "./state";

const STORAGE_KEY = "silvic.grove.nudges.v2";

type Offset = { x: number; y: number };
type ProjectNudges = Record<string, Offset>;

interface WorkspaceNodeData extends Record<string, unknown> {
  workspace: WorkspaceSnapshot;
  selected: boolean;
  dimmed: boolean;
  menuOpen: boolean;
  project: ProjectSnapshot;
  onSelect(id: string): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onOpenMenu(id: string): void;
  onCloseMenu(): void;
  onEditRecipe(): void;
  onNewPlot(): void;
  defaultHarness: HarnessId;
  onSetDefaultHarness(id: HarnessId): void;
  onTeardown(workspace: WorkspaceSnapshot): void;
}

interface QuietNodeData extends Record<string, unknown> {
  count: number;
  onExpand(): void;
}

type WorkspaceFlowNode = Node<WorkspaceNodeData, "workspace">;
type QuietFlowNode = Node<QuietNodeData, "quiet">;
type GroveNode = WorkspaceFlowNode | QuietFlowNode;

interface GroveProps {
  project: ProjectSnapshot;
  query: string;
  appearance: Appearance;
  selectedWorkspaceId: string | undefined;
  onSelect(id: string): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onEditRecipe(): void;
  onNewPlot(): void;
  defaultHarness: HarnessId;
  onSetDefaultHarness(id: HarnessId): void;
  onTeardown(workspace: WorkspaceSnapshot): void;
}

const nodeTypes = { workspace: memo(WorkspaceNode), quiet: memo(QuietNode) };

export function Grove(props: GroveProps) {
  return (
    <ReactFlowProvider>
      <GroveCanvas {...props} />
    </ReactFlowProvider>
  );
}

function GroveCanvas({
  project,
  query,
  appearance,
  selectedWorkspaceId,
  onSelect,
  onOpen,
  onEditRecipe,
  onNewPlot,
  defaultHarness,
  onSetDefaultHarness,
  onTeardown,
}: GroveProps) {
  const [nudges, setNudges] = useState<ProjectNudges>(() =>
    readNudges(project.id),
  );
  const [showLegend, setShowLegend] = useState(true);
  const [showQuiet, setShowQuiet] = useState(false);
  const [menuPlotId, setMenuPlotId] = useState<string>();
  const dragging = useRef(false);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  useEffect(() => setNudges(readNudges(project.id)), [project.id]);
  useEffect(() => setShowQuiet(false), [project.id]);

  // Searching should reach folded environments, not hide them.
  const searching = query.trim().length > 0;
  const tidy = useMemo(
    () => layout(project, showQuiet || searching),
    [project, showQuiet, searching],
  );
  const paint = substrate[appearance];

  const computed = useMemo<GroveNode[]>(() => {
    const needle = query.trim().toLowerCase();
    return tidy.placements.map(({ key, workspace, quietCount, position }) => {
      const nudge = nudges[key];
      const placed = nudge
        ? { x: position.x + nudge.x, y: position.y + nudge.y }
        : position;
      if (!workspace) {
        return {
          id: key,
          type: "quiet",
          position: placed,
          draggable: false,
          data: { count: quietCount ?? 0, onExpand: () => setShowQuiet(true) },
        } satisfies QuietFlowNode;
      }
      return {
        id: key,
        type: "workspace",
        position: placed,
        data: {
          workspace,
          selected: workspace.workspaceId === selectedWorkspaceId,
          dimmed: needle.length > 0 && !matches(workspace, needle),
          menuOpen: menuPlotId === workspace.workspaceId,
          project,
          onSelect,
          onOpen,
          onOpenMenu: setMenuPlotId,
          onCloseMenu: () => setMenuPlotId(undefined),
          onEditRecipe,
          onNewPlot,
          defaultHarness,
          onSetDefaultHarness,
          onTeardown,
        },
      } satisfies WorkspaceFlowNode;
    });
  }, [
    tidy,
    project,
    nudges,
    query,
    menuPlotId,
    selectedWorkspaceId,
    onSelect,
    onOpen,
    onEditRecipe,
    onNewPlot,
    defaultHarness,
    onSetDefaultHarness,
    onTeardown,
  ]);

  const quietTotal = project.workspaces.filter(isQuiet).length;
  const foldable = quietTotal >= QUIET_FOLD_MIN;

  const [nodes, setNodes, onNodesChange] = useNodesState<GroveNode>([]);
  useEffect(() => {
    if (!dragging.current) setNodes(computed);
  }, [computed, setNodes]);

  const edges = useMemo<Edge[]>(
    () =>
      tidy.links.map((link) => ({
        id: `${link.source}:${link.target}`,
        source: link.source,
        target: link.target,
        sourceHandle: link.side > 0 ? "out-right" : "out-left",
        targetHandle: link.side > 0 ? "in-left" : "in-right",
        type: "smoothstep",
        pathOptions: { borderRadius: 18 },
        style: {
          stroke:
            link.evidence === "recorded" ? paint.lineage : paint.lineageFaint,
          strokeWidth: 1.25,
          ...(link.evidence === "recorded" ? {} : { strokeDasharray: "4 5" }),
        },
      })),
    [tidy, paint],
  );

  const persist = useCallback(
    (next: ProjectNudges) => {
      setNudges(next);
      writeNudges(project.id, next);
    },
    [project.id],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node) => {
      dragging.current = false;
      const anchor = tidy.placements.find(
        (placement) => placement.key === node.id,
      );
      if (!anchor) return;
      const offset = {
        x: Math.round(node.position.x - anchor.position.x),
        y: Math.round(node.position.y - anchor.position.y),
      };
      const next = { ...nudges };
      if (offset.x === 0 && offset.y === 0) delete next[node.id];
      else next[node.id] = offset;
      persist(next);
    },
    [tidy, nudges, persist],
  );

  const nudged = Object.keys(nudges).length;

  return (
    <div className="grove">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={() => {
          dragging.current = true;
        }}
        onNodeDragStop={onNodeDragStop}
        onMoveStart={() => setMenuPlotId(undefined)}
        fitView
        fitViewOptions={{ padding: 0.24, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.4}
        nodesConnectable={false}
        panOnScroll
        selectionOnDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          id="hairline"
          variant={BackgroundVariant.Lines}
          gap={16}
          lineWidth={0.5}
          color={paint.hairline}
        />
        <Background
          id="stations"
          variant={BackgroundVariant.Cross}
          gap={96}
          size={7}
          lineWidth={0.9}
          color={paint.tick}
        />
      </ReactFlow>

      <div className="grove-tools">
        <button type="button" aria-label="Zoom out" onClick={() => zoomOut()}>
          <Minus size={14} />
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => zoomIn()}>
          <Plus size={14} />
        </button>
        <span className="tool-rule" />
        <button
          type="button"
          aria-label="Fit grove to view"
          onClick={() => fitView({ padding: 0.24, maxZoom: 1, duration: 320 })}
        >
          <Maximize2 size={13} />
        </button>
        {foldable && (
          <>
            <span className="tool-rule" />
            <button
              type="button"
              className="tool-text"
              onClick={() => setShowQuiet(!showQuiet)}
              disabled={searching}
              title={
                searching
                  ? "Search already reveals every environment"
                  : undefined
              }
            >
              {showQuiet ? "Fold quiet" : `Show ${quietTotal} quiet`}
            </button>
          </>
        )}
        {nudged > 0 && (
          <button type="button" className="tool-text" onClick={() => persist({})}>
            Retidy {nudged}
          </button>
        )}
      </div>

      <button
        type="button"
        className={`grove-legend ${showLegend ? "open" : ""}`}
        onClick={() => setShowLegend(!showLegend)}
      >
        <span className="legend-title">Legend</span>
        {showLegend && (
          <span className="legend-body">
            <span>
              <i className="legend-line recorded" /> Recorded lineage
            </span>
            <span>
              <i className="legend-line inferred" /> Inferred or unknown
            </span>
            <span>
              <i className="legend-swatch" /> Drag to arrange · Retidy resets
            </span>
          </span>
        )}
      </button>
    </div>
  );
}

function WorkspaceNode({ data }: NodeProps<WorkspaceFlowNode>) {
  const { workspace } = data;
  const state = workspaceState(workspace);
  const { ahead, behind } = workspace.git;
  const signals = cardSignals(workspace);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { remoteUrl } = data.project;
  const runtimeUrl = workspace.observations.find(
    (observation) => observation.kind === "runtime" && observation.url,
  )?.url;

  return (
    <article
      className="plot"
      data-tone={state.tone}
      data-running={state.tone === "active" || undefined}
      data-primary={workspace.isPrimary || undefined}
      data-selected={data.selected || undefined}
      data-dimmed={data.dimmed || undefined}
      tabIndex={0}
      onClick={() => data.onSelect(workspace.workspaceId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onSelect(workspace.workspaceId);
        }
      }}
    >
      <Handle id="in-left" type="target" position={Position.Left} />
      <Handle id="in-right" type="target" position={Position.Right} />
      <Handle id="out-left" type="source" position={Position.Left} />
      <span className="plot-ticks" aria-hidden="true" />

      <header className="plot-head">
        <span className="micro">
          {workspace.isPrimary ? "Project" : locationLabel(workspace)}
        </span>
        <span className="plot-state">
          <i className="dot" />
          {state.label}
        </span>
      </header>

      <div className="plot-title">
        <h3 className="plot-name">
          {workspace.isPrimary ? data.project.name : workspace.name}
        </h3>
        {workspace.isPrimary && remoteUrl && (
          <button
            type="button"
            className="plot-remote"
            aria-label="Open the repository"
            title={remoteUrl}
            onClick={(event) => {
              event.stopPropagation();
              void window.silvic.openLink({ url: remoteUrl });
            }}
          >
            <GitHubMark size={14} />
          </button>
        )}
      </div>
      <p className="plot-branch">
        <GitBranch size={11} />
        <span>{workspace.branch || "Detached"}</span>
      </p>

      <p className="plot-facts">
        <span>{workingTreeLabel(workspace)}</span>
        <i className="fact-sep" />
        <span>
          ↑{ahead} ↓{behind}
        </span>
        {workspace.isPrimary && (
          <>
            <i className="fact-sep" />
            <span>{plotSummary(data.project)}</span>
          </>
        )}
      </p>

      {workspace.provisioning?.status === "failed" && (
        <p className="plot-unprovisioned">
          <TriangleAlert size={11} />
          <span>Provisioning unfinished</span>
        </p>
      )}

      {signals.length > 0 && (
        <div className="plot-signals">
          {signals.map((signal) => (
            <Signal key={signal.kind} signal={signal} />
          ))}
        </div>
      )}

      <footer className="plot-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen(workspace.path, data.defaultHarness);
          }}
        >
          <HarnessMark id={data.defaultHarness} size={13} />
          {harnessLabel(data.defaultHarness)}
        </button>
        <button
          type="button"
          className="icon"
          aria-label="Open in Terminal"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen(workspace.path, "terminal");
          }}
        >
          <Terminal size={12} />
        </button>
        <span className="plot-actions-gap" />
        {workspace.isPrimary && (
          <button
            type="button"
            className="icon plot-new"
            aria-label="New plot from here"
            title="New plot"
            onClick={(event) => {
              event.stopPropagation();
              data.onNewPlot();
            }}
          >
            <Plus size={14} />
          </button>
        )}
        <button
          type="button"
          className="icon"
          aria-label={`Actions for ${workspace.name}`}
          aria-haspopup="menu"
          aria-expanded={data.menuOpen}
          ref={menuButton}
          onClick={(event) => {
            event.stopPropagation();
            data.menuOpen
              ? data.onCloseMenu()
              : data.onOpenMenu(workspace.workspaceId);
          }}
        >
          <MoreHorizontal size={13} />
        </button>
      </footer>
      {data.menuOpen && (
        <PlotMenu
          anchor={menuButton.current}
          workspace={workspace}
          runtimeUrl={runtimeUrl}
          defaultHarness={data.defaultHarness}
          onClose={data.onCloseMenu}
          onOpen={data.onOpen}
          onSetDefaultHarness={data.onSetDefaultHarness}
          onEditRecipe={data.onEditRecipe}
          onTeardown={data.onTeardown}
        />
      )}
      <Handle id="out-right" type="source" position={Position.Right} />
    </article>
  );
}

/**
 * React Flow puts nodes inside a transformed viewport, so a menu rendered in
 * place would scale with the zoom and position against the transform rather
 * than the screen. Portalling to the body keeps it a normal-sized menu anchored
 * to where the button actually is.
 */
function PlotMenu({
  anchor,
  workspace,
  runtimeUrl,
  defaultHarness,
  onClose,
  onOpen,
  onSetDefaultHarness,
  onEditRecipe,
  onTeardown,
}: {
  anchor: HTMLElement | null;
  workspace: WorkspaceSnapshot;
  runtimeUrl: string | undefined;
  defaultHarness: HarnessId;
  onClose(): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onSetDefaultHarness(id: HarnessId): void;
  onEditRecipe(): void;
  onTeardown(workspace: WorkspaceSnapshot): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rect = anchor?.getBoundingClientRect();
  if (!rect) return null;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return createPortal(
    <>
      <div className="menu-scrim" onClick={onClose} />
      <div
        className="menu plot-menu"
        role="menu"
        style={{ top: rect.bottom + 6, left: Math.max(8, rect.right - 200) }}
      >
        <HarnessRows
          defaultHarness={defaultHarness}
          onOpen={(id) => run(() => onOpen(workspace.path, id))()}
          onSetDefault={onSetDefaultHarness}
        />
        <div className="menu-rule" />
        <button
          type="button"
          role="menuitem"
          onClick={run(() => onOpen(workspace.path, "finder"))}
        >
          <FolderOpen size={14} />
          Reveal in Finder
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={run(() => void window.silvic.copyText(workspace.path))}
        >
          <Copy size={14} />
          Copy path
        </button>
        {runtimeUrl && (
          <button
            type="button"
            role="menuitem"
            onClick={run(() => void window.silvic.copyText(runtimeUrl))}
          >
            <Link2 size={14} />
            Copy address
          </button>
        )}
        <div className="menu-rule" />
        {workspace.isPrimary ? (
          <button type="button" role="menuitem" onClick={run(onEditRecipe)}>
            <SlidersHorizontal size={14} />
            Recipe…
          </button>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={run(() => onTeardown(workspace))}
          >
            <Trash2 size={14} />
            Tear down…
          </button>
        )}
      </div>
    </>,
    window.document.body,
  );
}

/** Clean, inactive environments collapse to one stack so the loud ones read. */
function QuietNode({ data }: NodeProps<QuietFlowNode>) {
  return (
    <article
      className="quiet-stack"
      tabIndex={0}
      onClick={data.onExpand}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onExpand();
        }
      }}
    >
      <Handle id="in-left" type="target" position={Position.Left} />
      <Handle id="in-right" type="target" position={Position.Right} />
      <span className="micro">Quiet</span>
      <h3>{data.count} plots</h3>
      <p>Clean, no running work</p>
      <span className="quiet-action">Show them</span>
    </article>
  );
}

/** How the project's plots are doing, in one line. */
function plotSummary(project: ProjectSnapshot): string {
  const plots = project.workspaces.filter((workspace) => !workspace.isPrimary);
  if (plots.length === 0) return "no plots";
  const busy = plots.filter((workspace) => !isQuiet(workspace)).length;
  return busy > 0
    ? `${plots.length} plots · ${busy} busy`
    : `${plots.length} plots · all quiet`;
}

function Signal({ signal }: { signal: CardSignal }) {
  const { url } = signal;
  const body = (
    <>
      {signalIcon(signal.kind)}
      <span>{signal.text}</span>
    </>
  );
  if (!url) {
    return (
      <span className="chip" data-tone={signal.tone}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip linked"
      data-tone={signal.tone}
      title={url}
      onClick={(event) => {
        event.stopPropagation();
        void window.silvic.openLink({ url });
      }}
    >
      {body}
    </button>
  );
}

function signalIcon(kind: ConnectorObservation["kind"]) {
  if (kind === "runtime") return <Play size={10} />;
  if (kind === "deployment") return <ConvexMark size={10} />;
  if (kind === "review") return <GitPullRequest size={10} />;
  if (kind === "session") return <CodexMark size={10} />;
  return <Radio size={10} />;
}


function matches(workspace: WorkspaceSnapshot, needle: string): boolean {
  return [
    workspace.name,
    workspace.branch,
    workspace.path,
    workspace.purpose ?? "",
    ...workspace.observations.flatMap((observation) => [
      observation.label,
      observation.detail ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function readNudges(projectId: string): ProjectNudges {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entry = (parsed as Record<string, unknown>)[projectId];
    if (typeof entry !== "object" || entry === null) return {};
    const result: ProjectNudges = {};
    for (const [id, offset] of Object.entries(entry)) {
      if (
        typeof offset === "object" &&
        offset !== null &&
        Number.isFinite((offset as Offset).x) &&
        Number.isFinite((offset as Offset).y)
      ) {
        result[id] = { x: (offset as Offset).x, y: (offset as Offset).y };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeNudges(projectId: string, nudges: ProjectNudges): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const all: Record<string, ProjectNudges> =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, ProjectNudges>)
        : {};
    if (Object.keys(nudges).length === 0) delete all[projectId];
    else all[projectId] = nudges;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Layout nudges are a convenience; losing them must never break the canvas.
  }
}
