import type { ProjectSnapshot, WorkspaceSnapshot } from "@silvic/contracts";

import { workspaceState } from "./state";

export const NODE_WIDTH = 268;
export const NODE_HEIGHT = 184;
const COLUMN_GAP = 108;
const ROW_GAP = 22;
/** Roughly the proportions of the canvas area between rail and inspector. */
const CANVAS_ASPECT = 1.2;
/** Below this, quiet environments are cheaper to read than a stack. */
export const QUIET_FOLD_MIN = 3;

export type LineageEvidence = "recorded" | "inferred" | "unrecorded";

export interface Placement {
  key: string;
  workspace?: WorkspaceSnapshot;
  quietCount?: number;
  position: { x: number; y: number };
}

export interface Link {
  source: string;
  target: string;
  evidence: LineageEvidence;
  /** 1 when the child sits right of its parent, -1 when it sits left. */
  side: number;
}

export interface NodeSize {
  width: number;
  height: number;
}

/**
 * Preserve the spatial address of every surviving plot across snapshot
 * changes. Measured growth may push a lower established plot down; newcomers
 * yield to established plots instead of making the existing grove jump.
 */
export function stabilizePlacements(
  placements: readonly Placement[],
  previous: ReadonlyMap<string, Point>,
  sizes: ReadonlyMap<string, NodeSize> = new Map(),
): Placement[] {
  const result = new Map<string, Placement>();
  const columns = Map.groupBy(
    placements,
    (placement) => (previous.get(placement.key) ?? placement.position).x,
  );

  for (const [, column] of columns) {
    const ordered = [...column].sort((left, right) => {
      const leftPosition = previous.get(left.key) ?? left.position;
      const rightPosition = previous.get(right.key) ?? right.position;
      return (
        leftPosition.y - rightPosition.y || left.key.localeCompare(right.key)
      );
    });
    const established = ordered.filter((placement) =>
      previous.has(placement.key),
    );
    const newcomers = ordered.filter(
      (placement) => !previous.has(placement.key),
    );
    const occupied: Array<{ y: number; height: number }> = [];
    let nextY = Number.NEGATIVE_INFINITY;
    for (const placement of established) {
      const preferred = previous.get(placement.key) ?? placement.position;
      const position = {
        x: preferred.x,
        y: Math.max(preferred.y, nextY),
      };
      result.set(placement.key, { ...placement, position });
      const height = sizes.get(placement.key)?.height ?? NODE_HEIGHT;
      nextY = position.y + height + ROW_GAP;
      occupied.push({ y: position.y, height });
    }
    for (const placement of newcomers) {
      const height = sizes.get(placement.key)?.height ?? NODE_HEIGHT;
      let y = placement.position.y;
      let collision = occupied.find(
        (item) =>
          y < item.y + item.height + ROW_GAP && y + height + ROW_GAP > item.y,
      );
      while (collision) {
        y = collision.y + collision.height + ROW_GAP;
        collision = occupied.find(
          (item) =>
            y < item.y + item.height + ROW_GAP && y + height + ROW_GAP > item.y,
        );
      }
      const position = { x: placement.position.x, y };
      result.set(placement.key, { ...placement, position });
      occupied.push({ y, height });
      occupied.sort((left, right) => left.y - right.y);
    }
  }

  return placements.map((placement) => result.get(placement.key) ?? placement);
}

export function isQuiet(workspace: WorkspaceSnapshot): boolean {
  return workspaceState(workspace).tone === "quiet";
}

/**
 * Deterministic left-to-right layout. Depth still drives the column, but a
 * parent's children are laid out as a wrapped block instead of one tall column,
 * so a wide fan of parallel worktrees stays legible. Quiet environments collapse
 * into a single stack unless the user asks to see them.
 */
export function layout(
  project: ProjectSnapshot,
  showQuiet: boolean,
): { placements: Placement[]; links: Link[] } {
  const byId = new Map(
    project.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const primary =
    project.workspaces.find((workspace) => workspace.isPrimary) ??
    project.workspaces[0];
  if (!primary) return { placements: [], links: [] };

  const children = new Map<string, string[]>();
  const evidenceOf = new Map<string, LineageEvidence>();
  for (const workspace of project.workspaces) {
    if (workspace.workspaceId === primary.workspaceId) continue;
    const recorded = workspace.lineage?.parentWorkspaceId;
    const hasRecordedParent =
      recorded !== undefined &&
      recorded !== workspace.workspaceId &&
      byId.has(recorded);
    const parent = hasRecordedParent ? recorded : primary.workspaceId;
    evidenceOf.set(
      workspace.workspaceId,
      hasRecordedParent
        ? (workspace.lineage?.evidence ?? "inferred")
        : "unrecorded",
    );
    children.set(parent, [
      ...(children.get(parent) ?? []),
      workspace.workspaceId,
    ]);
  }

  const placements: Placement[] = [];
  const links: Link[] = [];
  const nextRow = new Map<number, number>();
  const columnOccupants = new Map<number, number>();

  const reserve = (columns: readonly number[], rows: number) => {
    let base = 0;
    for (const column of columns) {
      base = Math.max(base, nextRow.get(column) ?? 0);
    }
    for (const column of columns) nextRow.set(column, base + rows);
    return base;
  };
  const cell = (column: number, row: number) => ({
    x: column * (NODE_WIDTH + COLUMN_GAP),
    y: row * (NODE_HEIGHT + ROW_GAP),
  });
  const occupy = (column: number) =>
    columnOccupants.set(column, (columnOccupants.get(column) ?? 0) + 1);

  const visited = new Set<string>([primary.workspaceId]);
  const primaryPlacement: Placement = {
    key: primary.workspaceId,
    workspace: primary,
    position: cell(0, reserve([0], 1)),
  };
  placements.push(primaryPlacement);
  occupy(0);

  // direction 0 is the trunk, which fans both ways; every descendant keeps
  // growing outward on the side it was placed.
  const queue: Array<{
    id: string;
    column: number;
    direction: number;
    placement: Placement;
  }> = [
    {
      id: primary.workspaceId,
      column: 0,
      direction: 0,
      placement: primaryPlacement,
    },
  ];

  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    const kids = (children.get(parent.id) ?? [])
      .filter((id) => !visited.has(id))
      .map((id) => byId.get(id))
      .filter((workspace) => workspace !== undefined)
      // Operational state changes continuously while work is running. It may
      // change a card's emphasis, but it must never change the card's address
      // on the canvas. Workspace identity is the stable spatial order.
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    if (kids.length === 0) continue;

    const loud = kids.filter((workspace) => !isQuiet(workspace));
    const quiet = kids.filter(isQuiet);
    const folded = !showQuiet && quiet.length >= QUIET_FOLD_MIN;
    const entries: Array<WorkspaceSnapshot | undefined> = folded
      ? [...loud, undefined]
      : [...loud, ...quiet];

    // The trunk splits its stably ordered children; the first half grows right,
    // which is the direction the eye already travels.
    const rightCount =
      parent.direction === 0
        ? Math.ceil(entries.length / 2)
        : parent.direction > 0
          ? entries.length
          : 0;
    const right = entries.slice(0, rightCount);
    const left = entries.slice(rightCount);

    // Both sides share a column count so the fan stays symmetrical.
    const perSide = Math.max(right.length, left.length);
    const sides = (right.length > 0 ? 1 : 0) + (left.length > 0 ? 1 : 0);
    const width = perSide > 0 ? columnsPerSide(perSide, Math.max(sides, 1)) : 0;
    const shapeFor = (count: number) => {
      if (count === 0) return { columns: 0, rows: 0 };
      const columns = Math.min(width, count);
      return { columns, rows: Math.ceil(count / columns) };
    };
    const rightShape = shapeFor(right.length);
    const leftShape = shapeFor(left.length);
    const rows = Math.max(rightShape.rows, leftShape.rows, 1);
    const usedColumns = [
      ...Array.from(
        { length: rightShape.columns },
        (_, index) => parent.column + 1 + index,
      ),
      ...Array.from(
        { length: leftShape.columns },
        (_, index) => parent.column - 1 - index,
      ),
    ];
    const baseRow = reserve(usedColumns, rows);

    const put = (
      workspace: WorkspaceSnapshot | undefined,
      column: number,
      row: number,
    ) => {
      occupy(column);
      const side = column > parent.column ? 1 : -1;
      if (!workspace) {
        const key = `quiet:${parent.id}`;
        placements.push({
          key,
          quietCount: quiet.length,
          position: cell(column, row),
        });
        links.push({
          source: parent.id,
          target: key,
          evidence: "unrecorded",
          side,
        });
        return;
      }
      visited.add(workspace.workspaceId);
      const placement: Placement = {
        key: workspace.workspaceId,
        workspace,
        position: cell(column, row),
      };
      placements.push(placement);
      links.push({
        source: parent.id,
        target: workspace.workspaceId,
        evidence: evidenceOf.get(workspace.workspaceId) ?? "unrecorded",
        side,
      });
      queue.push({
        id: workspace.workspaceId,
        column,
        direction: side,
        placement,
      });
    };

    right.forEach((workspace, index) =>
      put(
        workspace,
        parent.column + 1 + Math.floor(index / rightShape.rows),
        baseRow + (index % rightShape.rows),
      ),
    );
    left.forEach((workspace, index) =>
      put(
        workspace,
        parent.column - 1 - Math.floor(index / leftShape.rows),
        baseRow + (index % leftShape.rows),
      ),
    );

    if (folded) {
      for (const workspace of quiet) visited.add(workspace.workspaceId);
    }
    // A parent that owns its column reads better centred on its block.
    if ((columnOccupants.get(parent.column) ?? 0) === 1) {
      parent.placement.position.y = cell(
        parent.column,
        baseRow + (rows - 1) / 2,
      ).y;
    }
  }

  // Anything the walk could not reach (a lineage cycle) still gets a column.
  for (const workspace of project.workspaces) {
    if (visited.has(workspace.workspaceId)) continue;
    visited.add(workspace.workspaceId);
    occupy(1);
    placements.push({
      key: workspace.workspaceId,
      workspace,
      position: cell(1, reserve([1], 1)),
    });
  }

  return { placements: stabilizePlacements(placements, new Map()), links };
}

/**
 * Choose how many columns each side gets so the whole fan — both sides plus the
 * parent's own column — lands as close to the canvas proportions as possible.
 * Measuring the finished shape matters: a block that is well proportioned on
 * its own becomes far too wide once it is mirrored onto the other side.
 */
function columnsPerSide(perSide: number, sides: number): number {
  const cellWidth = NODE_WIDTH + COLUMN_GAP;
  const cellHeight = NODE_HEIGHT + ROW_GAP;
  let best = 1;
  let bestError = Number.POSITIVE_INFINITY;
  for (let columns = 1; columns <= perSide; columns += 1) {
    const width = (columns * sides + 1) * cellWidth;
    const height = Math.ceil(perSide / columns) * cellHeight;
    // Compare ratios logarithmically so "twice as wide" and "half as wide"
    // count as equally wrong.
    const error = Math.abs(Math.log(width / height / CANVAS_ASPECT));
    if (error < bestError) {
      bestError = error;
      best = columns;
    }
  }
  return best;
}

export interface ViewportWindow {
  /** React Flow's translation, in screen pixels. */
  x: number;
  y: number;
  zoom: number;
  /** The canvas element's size, in screen pixels. */
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The slice of flow coordinates the canvas currently shows. */
function windowOf(view: ViewportWindow) {
  const minX = -view.x / view.zoom;
  const minY = -view.y / view.zoom;
  return {
    minX,
    minY,
    maxX: minX + view.width / view.zoom,
    maxY: minY + view.height / view.zoom,
  };
}

function boxInView(
  position: Point,
  size: { width: number; height: number },
  view: ViewportWindow,
): boolean {
  if (view.zoom <= 0) return false;
  const { minX, minY, maxX, maxY } = windowOf(view);
  return (
    position.x < maxX &&
    position.x + size.width > minX &&
    position.y < maxY &&
    position.y + size.height > minY
  );
}

/**
 * Whether any node still shows inside the viewport. When none does, the user
 * has panned into empty paper and cannot know which way home is — the canvas
 * offers a way back instead of waiting for them to find the fit control.
 */
export function anyNodeInView(
  nodes: readonly {
    position: Point;
    measured?: { width?: number; height?: number };
  }[],
  view: ViewportWindow,
): boolean {
  return nodes.some((node) =>
    boxInView(
      node.position,
      {
        width: node.measured?.width ?? NODE_WIDTH,
        height: node.measured?.height ?? NODE_HEIGHT,
      },
      view,
    ),
  );
}

export type ViewShift =
  /** The paper did not move under the reader; leave the camera alone. */
  | { kind: "hold" }
  /** Move the camera by this much, in flow units, to keep the anchor still. */
  | { kind: "follow"; dx: number; dy: number }
  /** Nothing the reader was watching survived; show the whole grove again. */
  | { kind: "fit" };

/**
 * How the camera should answer a layout that moved beneath it. Tearing one plot
 * down rebalances the entire fan, so a card the reader was watching can slide a
 * row, jump a column, or flip to the other side of the trunk while the camera
 * stays put — which is how a canvas ends up parked on empty paper. Following the
 * card nearest the centre keeps that reader's view looking untouched.
 */
export function viewShift(
  before: ReadonlyMap<string, Point>,
  after: ReadonlyMap<string, Point>,
  view: ViewportWindow,
): ViewShift {
  if (before.size === 0 || after.size === 0 || view.zoom <= 0) {
    return { kind: "hold" };
  }
  const size = { width: NODE_WIDTH, height: NODE_HEIGHT };
  const watched = [...before].filter(([, position]) =>
    boxInView(position, size, view),
  );
  // Already off in the weeds before the layout changed: the way back is the
  // rescue the canvas offers, not a camera that moves on its own.
  if (watched.length === 0) return { kind: "hold" };

  const survivors = watched.filter(([key]) => after.has(key));
  if (survivors.length === 0) return { kind: "fit" };

  const centre = {
    x: (view.width / 2 - view.x) / view.zoom,
    y: (view.height / 2 - view.y) / view.zoom,
  };
  const anchor = survivors.reduce((closest, candidate) =>
    distanceToCentre(candidate[1], centre) <
    distanceToCentre(closest[1], centre)
      ? candidate
      : closest,
  );
  const moved = after.get(anchor[0]);
  if (!moved) return { kind: "hold" };
  const dx = moved.x - anchor[1].x;
  const dy = moved.y - anchor[1].y;
  return dx === 0 && dy === 0 ? { kind: "hold" } : { kind: "follow", dx, dy };
}

function distanceToCentre(position: Point, centre: Point): number {
  const dx = position.x + NODE_WIDTH / 2 - centre.x;
  const dy = position.y + NODE_HEIGHT / 2 - centre.y;
  return dx * dx + dy * dy;
}
