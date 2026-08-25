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
  type NodeChange,
  type NodeProps,
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
  anyNodeInView,
  layout,
  projectForQuery,
  recentActivityOrder,
  stabilizePlacements,
  viewShift,
  workspaceMatchesQuery,
  type NodeSize,
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
  onRename(id: string, name: string): Promise<void>;
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
  onRename,
  onTeardown,
}: GroveProps) {
  const [nudges, setNudges] = useState<ProjectNudges>(() =>
    readNudges(project.id),
  );
  const [showLegend, setShowLegend] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [menuPlotId, setMenuPlotId] = useState<string>();
  const draggingId = useRef<string>(undefined);
  const shown = useRef(new Map<string, Point>());
  const spatial = useRef<{
    projectId: string;
    activityOrder: string;
    positions: Map<string, Point>;
    sizes: Map<string, NodeSize>;
  }>({
    projectId: project.id,
    activityOrder: "",
    positions: new Map(),
    sizes: new Map(),
  });
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const measurementFrame = useRef<number>(undefined);
  const focusFrame = useRef<number>(undefined);
  const { zoomIn, zoomOut, fitView, setViewport } = useReactFlow();
  const store = useStoreApi();
  const transform = useStore((state) => state.transform);
  const flowWidth = useStore((state) => state.width);
  const flowHeight = useStore((state) => state.height);

  useEffect(() => setNudges(readNudges(project.id)), [project.id]);
  useEffect(() => setShowInactive(false), [project.id]);

  // Searching should reach folded environments, not hide them.
  const searching = query.trim().length > 0;
  const viewProject = useMemo(
    () => projectForQuery(project, query),
    [project, query],
  );
  const proposed = useMemo(
    () => layout(viewProject, showInactive || searching),
    [viewProject, showInactive, searching],
  );
  const activityOrder = useMemo(
    () => recentActivityOrder(project.workspaces).join("\0"),
    [project.workspaces],
  );
  if (spatial.current.projectId !== project.id) {
    spatial.current = {
      projectId: project.id,
      activityOrder,
      positions: new Map(),
      sizes: new Map(),
    };
  } else if (spatial.current.activityOrder !== activityOrder) {
    // A task becoming the most recent is the one state change that is meant to
    // move cards: the grove is explicitly ordered by last Codex activity.
    spatial.current.activityOrder = activityOrder;
    spatial.current.positions = new Map();
  }
  const tidy = useMemo(() => {
    const placements = stabilizePlacements(
      proposed.placements,
      spatial.current.positions,
      spatial.current.sizes,
    );
    spatial.current.positions = new Map(
      placements.map((placement) => [placement.key, placement.position]),
    );
    return { ...proposed, placements };
  }, [proposed, measurementRevision]);
  const paint = substrate[appearance];

  const computed = useMemo<GroveNode[]>(() => {
    const needle = query.trim().toLowerCase();
    return tidy.placements.map(({ key, workspace, hiddenCount, position }) => {
      // Search is a temporary focused map. A saved manual arrangement belongs
      // to the full grove and must not pull a lone hit away from its ancestry.
      const nudge = searching ? undefined : nudges[key];
      const placed = nudge
        ? { x: position.x + nudge.x, y: position.y + nudge.y }
        : position;
      if (!workspace) {
        return {
          id: key,
          type: "quiet",
          position: placed,
          draggable: false,
          data: {
            count: hiddenCount ?? 0,
            onExpand: () => setShowInactive(true),
          },
        } satisfies QuietFlowNode;
      }
      return {
        id: key,
        type: "workspace",
        position: placed,
        data: {
          workspace,
          selected: workspace.workspaceId === selectedWorkspaceId,
          dimmed:
            needle.length > 0 &&
            !workspaceMatchesQuery(workspace, needle, project),
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
          onRename,
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
    searching,
    menuPlotId,
    selectedWorkspaceId,
    onSelect,
    onOpen,
    onEditRecipe,
    onNewPlot,
    defaultHarness,
    onSetDefaultHarness,
    onRename,
    onTeardown,
  ]);

  // Subscribe to the viewport itself, then derive visibility during render.
  // A selector that returned only this boolean could get stuck on its initial
  // answer because the card positions lived in a ref outside React Flow's
  // store. Every pan, zoom, resize and layout change now supplies an explicit
  // input and therefore re-evaluates the way back.
  const visibleCards = useMemo(
    () => new Map(computed.map((node) => [node.id, node.position])),
    [computed],
  );
  const lost = nothingInSight(
    visibleCards,
    {
      x: transform[0],
      y: transform[1],
      zoom: transform[2],
      width: flowWidth,
      height: flowHeight,
    },
    spatial.current.sizes,
  );

  const hiddenTotal = tidy.placements.reduce(
    (total, placement) => total + (placement.hiddenCount ?? 0),
    0,
  );
  const foldable = hiddenTotal > 0 || showInactive;

  const [nodes, setNodes, onNodesChange] = useNodesState<GroveNode>([]);
  useEffect(
    () => () => {
      if (measurementFrame.current !== undefined) {
        window.cancelAnimationFrame(measurementFrame.current);
      }
      if (focusFrame.current !== undefined) {
        window.cancelAnimationFrame(focusFrame.current);
      }
    },
    [],
  );
  const handleNodesChange = useCallback(
    (changes: NodeChange<GroveNode>[]) => {
      onNodesChange(changes);
      let changed = false;
      for (const change of changes) {
        if (change.type !== "dimensions" || !change.dimensions) continue;
        const next = {
          width: change.dimensions.width,
          height: change.dimensions.height,
        };
        const current = spatial.current.sizes.get(change.id);
        if (
          current &&
          Math.abs(current.width - next.width) < 0.5 &&
          Math.abs(current.height - next.height) < 0.5
        ) {
          continue;
        }
        spatial.current.sizes.set(change.id, next);
        changed = true;
      }
      if (changed && measurementFrame.current === undefined) {
        // React Flow reports dimensions from a ResizeObserver. Repositioning
        // synchronously inside that observer can make the browser deliver a
        // second resize in the same cycle; one frame of separation keeps the
        // measurement and layout phases finite and warning-free.
        measurementFrame.current = window.requestAnimationFrame(() => {
          measurementFrame.current = undefined;
          setMeasurementRevision((revision) => revision + 1);
        });
      }
    },
    [onNodesChange],
  );

  const comeBack = useCallback(() => {
    void fitView({ padding: 0.24, maxZoom: 1, duration: 320 });
  }, [fitView]);

  // Stable anchors normally keep surviving cards fixed. If measured growth or
  // a topology change still moves one, the camera follows it; the grove only
  // refits when the subject being watched is gone for good.
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

  const focusKey = `${project.id}\0${query.trim().toLowerCase()}`;
  useEffect(() => {
    if (focusFrame.current !== undefined) {
      window.cancelAnimationFrame(focusFrame.current);
    }
    // React Flow receives the focused node set in the effect above. Fitting on
    // the next frame keeps the camera bounds in lockstep with that committed
    // set, both when entering search and when clearing it again.
    focusFrame.current = window.requestAnimationFrame(() => {
      focusFrame.current = undefined;
      comeBack();
    });
    return () => {
      if (focusFrame.current !== undefined) {
        window.cancelAnimationFrame(focusFrame.current);
        focusFrame.current = undefined;
      }
    };
  }, [focusKey, comeBack]);

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
      // The user moved the paper on purpose. Record the dropped position as
      // already shown so the automatic layout follower cannot counter-pan and
      // make a successful drag look as though the whole canvas jumped.
      shown.current.set(node.id, node.position);
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
        onNodesChange={handleNodesChange}
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
              onClick={() => setShowInactive(!showInactive)}
              disabled={searching}
              title={
                searching
                  ? "Search already reveals every environment"
                  : undefined
              }
            >
              {showInactive ? "Fold older" : `Show ${hiddenTotal} older`}
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
  view: {
    x: number;
    y: number;
    zoom: number;
    width: number;
    height: number;
  },
  sizes: ReadonlyMap<string, NodeSize> = new Map(),
): boolean {
  if (cards.size === 0 || view.width === 0 || view.height === 0) return false;
  return !anyNodeInView(
    [...cards].map(([key, position]) => {
      const measured = sizes.get(key);
      return { position, ...(measured ? { measured } : {}) };
    }),
    view,
  );
}

/** Older environments collapse to one stack so recent work stays readable. */
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
      <span className="micro">Older</span>
      <h3>
        {data.count} {data.count === 1 ? "plot" : "plots"}
      </h3>
      <p>No Codex activity in 3 days</p>
      <span className="quiet-action">Show them</span>
    </article>
  );
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
