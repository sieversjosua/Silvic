import type { ProjectSnapshot, WorkspaceSnapshot } from "@silvic/contracts";

import { workspaceState } from "./state";

export const NODE_WIDTH = 268;
export const NODE_HEIGHT = 184;
const COLUMN_GAP = 108;
const ROW_GAP = 22;
/** Roughly the proportions of the canvas area between rail and inspector. */
const CANVAS_ASPECT = 1.2;
/** Keep worktrees whose agent session was touched during the last three days. */
export const RECENT_SESSION_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;

export type LineageEvidence = "recorded" | "inferred" | "unrecorded";

export interface Placement {
  key: string;
  workspace?: WorkspaceSnapshot;
  hiddenCount?: number;
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
  const retained = placements.reduce(
    (count, placement) => count + (previous.has(placement.key) ? 1 : 0),
    0,
  );
  // A fold, search, or large teardown is a different map rather than a small
  // update to the old one. Reusing a sparse minority as immovable anchors
  // leaves holes on every transition and makes the grove grow indefinitely.
  const preservesPopulation =
    previous.size > 0 &&
    retained / placements.length >= 0.5 &&
    retained / previous.size >= 0.5;
  const anchors: ReadonlyMap<string, Point> = preservesPopulation
    ? previous
    : new Map();
  const result = new Map<string, Placement>();
  const columns = Map.groupBy(
    placements,
    (placement) => (anchors.get(placement.key) ?? placement.position).x,
  );

  for (const [, column] of columns) {
    const ordered = [...column].sort((left, right) => {
      const leftPosition = anchors.get(left.key) ?? left.position;
      const rightPosition = anchors.get(right.key) ?? right.position;
      return (
        leftPosition.y - rightPosition.y || left.key.localeCompare(right.key)
      );
    });
    const established = ordered.filter((placement) =>
      anchors.has(placement.key),
    );
    const newcomers = ordered.filter(
      (placement) => !anchors.has(placement.key),
    );
    const occupied: Array<{ y: number; height: number }> = [];
    let nextY = Number.NEGATIVE_INFINITY;
    for (const placement of established) {
      const preferred = anchors.get(placement.key) ?? placement.position;
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

/** Most recent agent-session activity attached to this exact worktree. */
export function latestSessionActivity(
  workspace: WorkspaceSnapshot,
): number | undefined {
  let latest: number | undefined;
  for (const observation of workspace.observations) {
    if (observation.kind !== "session") continue;
    const value = observation.metadata?.["updatedAtMs"];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      continue;
    }
    latest = latest === undefined ? value : Math.max(latest, value);
  }
  return latest;
}

/**
 * The default grove is a recent-work view. Operationally urgent plots stay in
 * sight even without a recent agent session, while ordinary old, changed and
 * completed worktrees can fold away.
 */
export function showsByDefault(
  workspace: WorkspaceSnapshot,
  now = Date.now(),
): boolean {
  if (workspace.isPrimary) return true;
  const tone = workspaceState(workspace).tone;
  // Discovery is not an operational emergency. A large external stack can
  // contain dozens of perfectly healthy worktrees, and marking every newly
  // discovered member as `not-adopted` gives each one the attention tone.
  // Let those fold by age unless there is separate evidence that this exact
  // worktree is active or genuinely needs attention.
  if (workspace.adoption?.status === "not-adopted" && tone === "attention") {
    const operationallyUrgent =
      workspace.git.conflicted > 0 ||
      workspace.observations.some(
        (observation) =>
          observation.state === "attention" ||
          ((observation.kind === "runtime" || observation.kind === "session") &&
            observation.state === "active"),
      );
    if (operationallyUrgent) return true;
  } else if (tone === "attention" || tone === "active" || tone === "waiting") {
    return true;
  }
  const updatedAt = latestSessionActivity(workspace);
  return updatedAt !== undefined && updatedAt >= now - RECENT_SESSION_WINDOW_MS;
}

function compareRecentActivity(
  left: WorkspaceSnapshot,
  right: WorkspaceSnapshot,
): number {
  const byActivity =
    (latestSessionActivity(right) ?? Number.NEGATIVE_INFINITY) -
    (latestSessionActivity(left) ?? Number.NEGATIVE_INFINITY);
  return byActivity || left.workspaceId.localeCompare(right.workspaceId);
}

/** Stable rank signature; timestamps only matter when they change the order. */
export function recentActivityOrder(
  workspaces: readonly WorkspaceSnapshot[],
): readonly string[] {
  return workspaces
    .filter((workspace) => latestSessionActivity(workspace) !== undefined)
    .toSorted(compareRecentActivity)
    .map((workspace) => workspace.workspaceId);
}

/** Match everything a reader can recognise as belonging to a plot. */
export function workspaceMatchesQuery(
  workspace: WorkspaceSnapshot,
  query: string,
  project?: ProjectSnapshot,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    workspace.name,
    workspace.repositoryName,
    workspace.branch,
    workspace.path,
    workspace.origin ?? "",
    project?.id ?? "",
    project?.name ?? "",
    project?.rootPath ?? "",
    project?.origin ?? "",
    project?.remoteUrl ?? "",
    workspace.purpose ?? "",
    workspace.task?.title ?? "",
    workspace.task?.description ?? "",
    workspace.task?.issue ? `#${workspace.task.issue.number}` : "",
    workspace.task?.issue?.title ?? "",
    workspace.task?.issue?.body ?? "",
    workspace.task?.issue?.url ?? "",
    ...(workspace.task?.issue?.labels ?? []),
    ...(workspace.task?.issue?.assignees ?? []),
    ...workspace.observations.flatMap((observation) => [
      observation.label,
      observation.detail ?? "",
      observation.url ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * Search lays out hits and their recorded ancestry, not every dimmed plot in
 * the project. Keeping the ancestry makes the result legible without letting
 * dozens of invisible non-matches determine the viewport bounds.
 */
export function projectForQuery(
  project: ProjectSnapshot,
  query: string,
): ProjectSnapshot {
  if (query.trim().length === 0) return project;
  const byId = new Map(
    project.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const primary =
    project.workspaces.find((workspace) => workspace.isPrimary) ??
    project.workspaces[0];
  const included = new Set<string>();
  if (primary) included.add(primary.workspaceId);

  for (const workspace of project.workspaces) {
    if (!workspaceMatchesQuery(workspace, query, project)) continue;
    let current: WorkspaceSnapshot | undefined = workspace;
    const seen = new Set<string>();
    while (current && !seen.has(current.workspaceId)) {
      seen.add(current.workspaceId);
      included.add(current.workspaceId);
      const parentId: string | undefined = current.lineage?.parentWorkspaceId;
      current = parentId ? byId.get(parentId) : undefined;
    }
  }

  return {
    ...project,
    workspaces: project.workspaces.filter((workspace) =>
      included.has(workspace.workspaceId),
    ),
  };
}

/**
 * Deterministic left-to-right layout. Depth still drives the column, but a
 * parent's children are laid out as a wrapped block instead of one tall column,
 * so a wide fan of parallel worktrees stays legible. Worktrees without recent
 * Codex activity collapse into a single stack unless the user asks to see them.
 */
export function layout(
  project: ProjectSnapshot,
  showInactive: boolean,
  now = Date.now(),
  focusedWorkspaceId?: string,
): { placements: Placement[]; links: Link[] } {
  const byId = new Map(
    project.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const primary =
    project.workspaces.find((workspace) => workspace.isPrimary) ??
    project.workspaces[0];
  if (!primary) return { placements: [], links: [] };

  const directParentOf = new Map<string, string>();
  const evidenceOf = new Map<string, LineageEvidence>();
  for (const workspace of project.workspaces) {
    if (workspace.workspaceId === primary.workspaceId) continue;
    const recorded = workspace.lineage?.parentWorkspaceId;
    const hasRecordedParent =
      recorded !== undefined &&
      recorded !== workspace.workspaceId &&
      byId.has(recorded);
    const parent = hasRecordedParent ? recorded : primary.workspaceId;
    directParentOf.set(workspace.workspaceId, parent);
    evidenceOf.set(
      workspace.workspaceId,
      hasRecordedParent
        ? (workspace.lineage?.evidence ?? "inferred")
        : "unrecorded",
    );
  }

  const included = new Set(
    project.workspaces
      .filter(
        (workspace) =>
          showInactive ||
          workspace.workspaceId === focusedWorkspaceId ||
          showsByDefault(workspace, now),
      )
      .map((workspace) => workspace.workspaceId),
  );
  included.add(primary.workspaceId);
  const nearestIncludedParent = (workspaceId: string) => {
    let candidate = directParentOf.get(workspaceId) ?? primary.workspaceId;
    const seen = new Set([workspaceId]);
    while (!included.has(candidate)) {
      if (seen.has(candidate)) return primary.workspaceId;
      seen.add(candidate);
      candidate = directParentOf.get(candidate) ?? primary.workspaceId;
    }
    return candidate;
  };
  const children = new Map<string, string[]>();
  let hiddenCount = 0;
  for (const workspace of project.workspaces) {
    if (workspace.workspaceId === primary.workspaceId) continue;
    const parent = nearestIncludedParent(workspace.workspaceId);
    if (included.has(workspace.workspaceId)) {
      children.set(parent, [
        ...(children.get(parent) ?? []),
        workspace.workspaceId,
      ]);
      if (parent !== directParentOf.get(workspace.workspaceId)) {
        evidenceOf.set(workspace.workspaceId, "unrecorded");
      }
    } else {
      hiddenCount += 1;
    }
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
      .sort(compareRecentActivity);
    // Folding is a project-level display concern, not another lineage branch.
    // One stack beside the trunk gives the reader one predictable place to
    // reveal quiet work instead of scattering several identical stacks around
    // whichever visible descendants happen to own hidden children.
    const parentHiddenCount =
      parent.id === primary.workspaceId ? hiddenCount : 0;
    if (kids.length === 0 && parentHiddenCount === 0) continue;

    const entries: Array<WorkspaceSnapshot | undefined> =
      parentHiddenCount > 0 ? [...kids, undefined] : kids;

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
          hiddenCount: parentHiddenCount,
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
    if (
      !included.has(workspace.workspaceId) ||
      visited.has(workspace.workspaceId)
    ) {
      continue;
    }
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
