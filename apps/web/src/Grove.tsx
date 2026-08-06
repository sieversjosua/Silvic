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
  useStore,
  useStoreApi,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowState,
} from "@xyflow/react";
import { Compass, Maximize2, Minus, Plus } from "lucide-react";

import type {
  HarnessId,
  HarnessDefinition,
  ProjectSnapshot,
  PlotCommand,
  PlotProcess,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { substrate, type Appearance } from "./appearance";
import {
  QUIET_FOLD_MIN,
  anyNodeInView,
  isQuiet,
  layout,
  viewShift,
  type Point,
} from "./grove-layout";
import { WorkspaceNode, type WorkspaceFlowNode } from "./PlotCard";
import { cardRuntimeState } from "./state";

const STORAGE_KEY = "silvic.grove.nudges.v2";

type Offset = { x: number; y: number };
type ProjectNudges = Record<string, Offset>;

interface QuietNodeData extends Record<string, unknown> {
  count: number;
  onExpand(): void;
}

type QuietFlowNode = Node<QuietNodeData, "quiet">;
type GroveNode = WorkspaceFlowNode | QuietFlowNode;

interface GroveProps {
  project: ProjectSnapshot;
  commands: readonly (readonly [string, PlotCommand])[];
  processes: readonly PlotProcess[];
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
  commands,
  processes,
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
  const draggingId = useRef<string>(undefined);
  const shown = useRef(new Map<string, Point>());
  const { zoomIn, zoomOut, fitView, setViewport } = useReactFlow();
  const store = useStoreApi();

  // Being lost is a fact about the canvas, not an event to catch: derived from
  // the viewport itself, every pan, zoom, resize and layout change answers the
  // question again, however it was caused.
  const lost = useStore(
    useCallback(
      (state: ReactFlowState) => nothingInSight(shown.current, state),
      [],
    ),
  );

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
          runtime: cardRuntimeState({ workspace, commands, processes }),
          previewUrl: processes.find(
            (process) =>
              process.plotPath === workspace.path &&
              process.status === "running" &&
              process.url,
          )?.url,
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
    commands,
    processes,
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

  const comeBack = useCallback(() => {
    void fitView({ padding: 0.24, maxZoom: 1, duration: 320 });
  }, [fitView]);

  // A plot torn down rebalances the fan, so the cards that remain move. The
  // camera moves with them: what the reader was watching stays where they left
  // it, and the grove only refits when that subject is gone for good.
  useEffect(() => {
    if (draggingId.current !== undefined) {
      // A card torn down mid-drag never reports its own drag end.
      if (computed.some((node) => node.id === draggingId.current)) return;
      draggingId.current = undefined;
    }
    const next = new Map(computed.map((node) => [node.id, node.position]));
    const { transform, width, height } = store.getState();
    const [x, y, zoom] = transform;
    const shift = viewShift(shown.current, next, {
      x,
      y,
      zoom,
      width,
      height,
    });
    shown.current = next;
    setNodes(computed);
    if (shift.kind === "follow") {
      void setViewport({
        x: x - shift.dx * zoom,
        y: y - shift.dy * zoom,
        zoom,
      });
    } else if (shift.kind === "fit") {
      comeBack();
    }
  }, [computed, setNodes, store, setViewport, comeBack]);

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
      draggingId.current = undefined;
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
        onNodeDragStart={(_event, node) => {
          draggingId.current = node.id;
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

      {lost && (
        <button type="button" className="grove-rescue" onClick={comeBack}>
          <Compass size={14} />
          Back to the grove
        </button>
      )}

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
          title="Fit every plot into view"
          onClick={comeBack}
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
          <button
            type="button"
            className="tool-text"
            onClick={() => persist({})}
          >
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

/**
 * Panned into empty paper, every card out of sight: the way back appears in the
 * middle of the canvas rather than hiding behind the fit icon. The cards come
 * from what the canvas was last given rather than from React Flow's own store,
 * which trails a frame behind a layout change and would flash the rescue during
 * one.
 */
function nothingInSight(
  cards: ReadonlyMap<string, Point>,
  state: ReactFlowState,
): boolean {
  if (cards.size === 0 || state.width === 0 || state.height === 0) return false;
  return !anyNodeInView(
    [...cards.values()].map((position) => ({ position })),
    {
      x: state.transform[0],
      y: state.transform[1],
      zoom: state.transform[2],
      width: state.width,
      height: state.height,
    },
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
