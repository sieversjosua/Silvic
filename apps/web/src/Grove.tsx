import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Bot,
  Cloud,
  GitBranch,
  GitPullRequest,
  Maximize2,
  Minus,
  Play,
  Plus,
  Radio,
  Terminal,
} from "lucide-react";

import type {
  ConnectorObservation,
  HarnessDefinition,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { substrate, type Appearance } from "./appearance";
import {
  QUIET_FOLD_MIN,
  isQuiet,
  layout,
} from "./grove-layout";
import {
  cardSignals,
  locationLabel,
  workingTreeLabel,
  workspaceState,
} from "./state";

const STORAGE_KEY = "silvic.grove.nudges.v2";

type Offset = { x: number; y: number };
type ProjectNudges = Record<string, Offset>;

interface WorkspaceNodeData extends Record<string, unknown> {
  workspace: WorkspaceSnapshot;
  selected: boolean;
  dimmed: boolean;
  harnessIcons: Readonly<Record<string, string>>;
  onSelect(id: string): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
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
  harnessIcons: Readonly<Record<string, string>>;
  selectedWorkspaceId: string | undefined;
  onSelect(id: string): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
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
  harnessIcons,
  selectedWorkspaceId,
  onSelect,
  onOpen,
}: GroveProps) {
  const [nudges, setNudges] = useState<ProjectNudges>(() =>
    readNudges(project.id),
  );
  const [showLegend, setShowLegend] = useState(true);
  const [showQuiet, setShowQuiet] = useState(false);
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
          harnessIcons,
          onSelect,
          onOpen,
        },
      } satisfies WorkspaceFlowNode;
    });
  }, [tidy, nudges, query, harnessIcons, selectedWorkspaceId, onSelect, onOpen]);

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

  return (
    <article
      className="plot"
      data-tone={state.tone}
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
        <span className="micro">{locationLabel(workspace)}</span>
        <span className="plot-state">
          <i className="dot" />
          {state.label}
        </span>
      </header>

      <h3 className="plot-name">{workspace.name}</h3>
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
      </p>

      {signals.length > 0 && (
        <div className="plot-signals">
          {signals.map((signal) => (
            <span key={signal.kind} className="chip" data-tone={signal.tone}>
              {signalIcon(signal.kind)}
              <span>{signal.text}</span>
            </span>
          ))}
        </div>
      )}

      <footer className="plot-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen(workspace.path, "codex");
          }}
        >
          {data.harnessIcons["codex"] ? (
            <img
              className="harness-icon"
              src={data.harnessIcons["codex"]}
              alt=""
              width={13}
              height={13}
            />
          ) : (
            <Bot size={12} />
          )}
          Open
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
      </footer>
      <Handle id="out-right" type="source" position={Position.Right} />
    </article>
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

function signalIcon(kind: ConnectorObservation["kind"]) {
  if (kind === "runtime") return <Play size={10} />;
  if (kind === "deployment") return <Cloud size={10} />;
  if (kind === "review") return <GitPullRequest size={10} />;
  if (kind === "session") return <Bot size={10} />;
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
