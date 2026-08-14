import { describe, expect, it } from "vitest";

import type {
  ConnectorObservation,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import {
  NODE_HEIGHT,
  NODE_WIDTH,
  RECENT_SESSION_WINDOW_MS,
  anyNodeInView,
  latestSessionActivity,
  layout,
  projectForQuery,
  recentActivityOrder,
  showsByDefault,
  stabilizePlacements,
  viewShift,
  type Point,
} from "./grove-layout";

function workspace(
  name: string,
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    workspaceId: name,
    projectId: "project",
    path: `/repos/${name}`,
    repositoryName: "mono",
    branch: name,
    name,
    locationKind: "worktree",
    isPrimary: false,
    git: {
      branch: name,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    observations: [],
    ...overrides,
  };
}

function project(workspaces: readonly WorkspaceSnapshot[]): ProjectSnapshot {
  return {
    id: "project",
    name: "mono",
    rootPath: "/repos/main",
    workspaces,
    branches: [],
    remoteBranches: [],
  };
}

const deployment: ConnectorObservation = {
  connectorId: "convex",
  workspaceId: "any",
  kind: "deployment",
  state: "active",
  label: "brazen-labrador-831",
};

const now = 1_786_610_000_000;
const session = (workspaceId: string, updatedAtMs: number) =>
  ({
    connectorId: "local-context",
    workspaceId,
    kind: "session",
    state: "ready",
    label: `Task in ${workspaceId}`,
    metadata: { taskId: `task-${workspaceId}`, updatedAtMs },
  }) satisfies ConnectorObservation;
const recentlyActive = (name: string, ageMs = 0) =>
  workspace(name, { observations: [session(name, now - ageMs)] });

const trunk = workspace("main", { isPrimary: true, locationKind: "checkout" });
const changed = (name: string) =>
  workspace(name, {
    git: { ...workspace(name).git, unstaged: 2 },
  });

describe("layout", () => {
  it("keeps non-matching plots out of the search bounds", () => {
    const unrelated = Array.from({ length: 39 }, (_, index) =>
      changed(`unrelated-${String(index).padStart(2, "0")}`),
    );
    const matching: WorkspaceSnapshot = {
      ...changed("website-color-scheme"),
      task: { title: "Design a website color scheme" },
    };
    const focused = projectForQuery(
      project([trunk, ...unrelated, matching]),
      "design",
    );
    const { placements } = layout(focused, true, now);

    expect(placements.map((placement) => placement.key)).toEqual([
      "main",
      "website-color-scheme",
    ]);
    expect(
      Math.max(...placements.map((placement) => placement.position.y)) -
        Math.min(...placements.map((placement) => placement.position.y)),
    ).toBeLessThanOrEqual(NODE_HEIGHT + 22);
  });

  it("splits the trunk's children onto both sides", () => {
    const kids = Array.from({ length: 6 }, (_, index) =>
      changed(`kid-${index}`),
    );
    const { placements, links } = layout(project([trunk, ...kids]), true);

    const right = placements.filter((item) => item.position.x > 0);
    const left = placements.filter((item) => item.position.x < 0);
    expect(right).toHaveLength(3);
    expect(left).toHaveLength(3);
    expect(links.filter((link) => link.side > 0)).toHaveLength(3);
    expect(links.filter((link) => link.side < 0)).toHaveLength(3);
  });

  it("centres the trunk vertically on its children", () => {
    const kids = Array.from({ length: 4 }, (_, index) =>
      changed(`kid-${index}`),
    );
    const { placements } = layout(project([trunk, ...kids]), true);

    const main = placements.find((item) => item.key === "main");
    const ys = placements
      .filter((item) => item.key !== "main")
      .map((item) => item.position.y);
    const middle = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(main?.position.y).toBeCloseTo(middle);
  });

  it("keeps every existing plot still when only one operational state changes", () => {
    const kids = Array.from({ length: 30 }, (_, index) =>
      changed(`kid-${String(index).padStart(2, "0")}`),
    );
    const before = layout(project([trunk, ...kids]), true);
    const after = layout(
      project([
        trunk,
        ...kids.map((kid) =>
          kid.workspaceId === "kid-29"
            ? { ...kid, git: { ...kid.git, conflicted: 1 } }
            : kid,
        ),
      ]),
      true,
    );

    expect(
      Object.fromEntries(
        before.placements.map(({ key, position }) => [key, position]),
      ),
    ).toEqual(
      Object.fromEntries(
        after.placements.map(({ key, position }) => [key, position]),
      ),
    );
  });

  it("keeps every existing plot still when another plot is added", () => {
    const kids = Array.from({ length: 20 }, (_, index) =>
      changed(`kid-${String(index).padStart(2, "0")}`),
    );
    const before = layout(project([trunk, ...kids]), true).placements;
    const previous = new Map(
      before.map(({ key, position }) => [key, position] as const),
    );
    const after = stabilizePlacements(
      layout(project([trunk, ...kids, changed("kid-20")]), true).placements,
      previous,
    );

    for (const placement of before) {
      expect(
        after.find((item) => item.key === placement.key)?.position,
      ).toEqual(placement.position);
    }
  });

  it("separates established cards when their measured height grows", () => {
    const placements = [
      { key: "upper", position: { x: 376, y: 0 } },
      { key: "lower", position: { x: 376, y: 206 } },
    ];
    const previous = new Map(
      placements.map(({ key, position }) => [key, position] as const),
    );
    const sizes = new Map([
      ["upper", { width: 268, height: 244 }],
      ["lower", { width: 268, height: 244 }],
    ]);

    expect(stabilizePlacements(placements, previous, sizes)).toEqual([
      { key: "upper", position: { x: 376, y: 0 } },
      { key: "lower", position: { x: 376, y: 266 } },
    ]);
  });

  it("moves a tall newcomer instead of an established plot", () => {
    const placements = [
      { key: "new", position: { x: 376, y: 0 } },
      { key: "existing", position: { x: 376, y: 206 } },
    ];
    const result = stabilizePlacements(
      placements,
      new Map([["existing", { x: 376, y: 206 }]]),
      new Map([
        ["new", { width: 268, height: 244 }],
        ["existing", { width: 268, height: 244 }],
      ]),
    );

    expect(result.find((item) => item.key === "existing")?.position).toEqual({
      x: 376,
      y: 206,
    });
    expect(result.find((item) => item.key === "new")?.position).toEqual({
      x: 376,
      y: 472,
    });
  });

  it.each([6, 12, 18, 30, 60])(
    "keeps a fan of %i roughly canvas-shaped rather than one tall stack",
    (count) => {
      const kids = Array.from({ length: count }, (_, index) =>
        changed(`kid-${index}`),
      );
      const { placements } = layout(project([trunk, ...kids]), true);
      const xs = placements.map((item) => item.position.x);
      const ys = placements.map((item) => item.position.y);

      expect(Math.min(...xs)).toBeLessThan(0);
      expect(Math.max(...xs)).toBeGreaterThan(0);
      // One column would be `count` rows tall; both sides halve that at worst.
      expect(new Set(ys).size).toBeLessThanOrEqual(Math.ceil(count / 2) + 1);

      const aspect =
        (Math.max(...xs) - Math.min(...xs) + NODE_WIDTH) /
        (Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT);
      expect(aspect).toBeGreaterThan(0.4);
      expect(aspect).toBeLessThan(2.6);
    },
  );

  it("folds worktrees without recent Codex activity into one stack", () => {
    const older = Array.from({ length: 5 }, (_, index) =>
      workspace(`older-${index}`),
    );
    const { placements } = layout(
      project([trunk, recentlyActive("recent"), ...older]),
      false,
      now,
    );

    const stack = placements.find((item) => item.key.startsWith("quiet:"));
    expect(stack?.hiddenCount).toBe(5);
    expect(placements.filter((item) => item.workspace)).toHaveLength(2);
  });

  it("shows every environment once folding is turned off", () => {
    const older = Array.from({ length: 5 }, (_, index) =>
      workspace(`older-${index}`),
    );
    const { placements } = layout(
      project([trunk, recentlyActive("recent"), ...older]),
      true,
      now,
    );

    expect(
      placements.find((item) => item.key.startsWith("quiet:")),
    ).toBeUndefined();
    expect(placements.filter((item) => item.workspace)).toHaveLength(7);
  });

  it("keeps visible plots still when an older plot becomes urgent", () => {
    const loud = Array.from({ length: 8 }, (_, index) =>
      recentlyActive(`loud-${index}`, index * 1_000),
    );
    const quiet = Array.from({ length: 3 }, (_, index) =>
      workspace(`quiet-${index}`),
    );
    const before = layout(
      project([trunk, ...loud, ...quiet]),
      false,
      now,
    ).placements;
    const previous = new Map(
      before.map(({ key, position }) => [key, position] as const),
    );
    const after = stabilizePlacements(
      layout(
        project([
          trunk,
          ...loud,
          ...quiet.map((item) =>
            item.workspaceId === "quiet-2"
              ? { ...item, git: { ...item.git, conflicted: 1 } }
              : item,
          ),
        ]),
        false,
        now,
      ).placements,
      previous,
    );

    for (const placement of before.filter(
      (item) => !item.key.startsWith("quiet:"),
    )) {
      expect(
        after.find((item) => item.key === placement.key)?.position,
      ).toEqual(placement.position);
    }
    expect(
      after.find((item) => item.key.startsWith("quiet:"))?.hiddenCount,
    ).toBe(2);
    expect(after.some((item) => item.key === "quiet-2")).toBe(true);
  });

  it("does not stretch the grove across repeated fold and search cycles", () => {
    const recent = Array.from({ length: 7 }, (_, index) =>
      recentlyActive(`recent-${index}`, index * 1_000),
    );
    const older = Array.from({ length: 32 }, (_, index) =>
      workspace(`older-${String(index).padStart(2, "0")}`),
    );
    const snapshot = project([trunk, ...recent, ...older]);
    const compact = layout(snapshot, false, now).placements;
    const expanded = layout(snapshot, true, now).placements;
    const height = (placements: readonly { position: Point }[]) => {
      const ys = placements.map((placement) => placement.position.y);
      return Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT;
    };

    let previous = new Map(
      compact.map(({ key, position }) => [key, position] as const),
    );
    let current = expanded;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      current = stabilizePlacements(expanded, previous);
      previous = new Map(
        current.map(({ key, position }) => [key, position] as const),
      );
      const folded = stabilizePlacements(compact, previous);
      previous = new Map(
        folded.map(({ key, position }) => [key, position] as const),
      );
    }

    expect(height(current)).toBeLessThanOrEqual(height(expanded));
  });

  it("does not treat a shared deployment as activity worth showing", () => {
    const attached = Array.from({ length: 4 }, (_, index) =>
      workspace(`attached-${index}`, { observations: [deployment] }),
    );
    const { placements } = layout(project([trunk, ...attached]), false, now);

    // All four are clean, so the shared Convex deployment must not keep them out
    // of the quiet stack.
    expect(
      placements.find((item) => item.key.startsWith("quiet:"))?.hiddenCount,
    ).toBe(4);
  });

  it("keeps three days of Codex activity and folds anything older", () => {
    const atCutoff = recentlyActive("at-cutoff", RECENT_SESSION_WINDOW_MS);
    const tooOld = [
      recentlyActive("old-1", RECENT_SESSION_WINDOW_MS + 1),
      workspace("old-2"),
      changed("old-3"),
    ];
    const result = layout(project([trunk, atCutoff, ...tooOld]), false, now);

    expect(showsByDefault(atCutoff, now)).toBe(true);
    expect(latestSessionActivity(atCutoff)).toBe(
      now - RECENT_SESSION_WINDOW_MS,
    );
    expect(result.placements.some((item) => item.key === "at-cutoff")).toBe(
      true,
    );
    expect(
      result.placements.find((item) => item.key.startsWith("quiet:"))
        ?.hiddenCount,
    ).toBe(3);
  });

  it("sorts visible worktrees by their latest session activity", () => {
    const result = layout(
      project([
        trunk,
        recentlyActive("oldest", 3_000),
        recentlyActive("newest", 1_000),
        recentlyActive("middle", 2_000),
      ]),
      false,
      now,
    );

    expect(
      result.placements
        .filter((item) => item.workspace && !item.workspace.isPrimary)
        .map((item) => item.key),
    ).toEqual(["newest", "middle", "oldest"]);
    expect(
      recentActivityOrder([
        recentlyActive("oldest", 3_000),
        recentlyActive("newest", 1_000),
        recentlyActive("middle", 2_000),
        workspace("without-session"),
      ]),
    ).toEqual(["newest", "middle", "oldest"]);
  });

  it("keeps urgent operational states visible without a recent task", () => {
    const conflicted = workspace("conflicted", {
      git: { ...workspace("conflicted").git, conflicted: 1 },
    });
    const runtime = workspace("running", {
      observations: [
        {
          connectorId: "local-context",
          workspaceId: "running",
          kind: "runtime",
          state: "active",
          label: "vite",
        },
      ],
    });

    expect(showsByDefault(conflicted, now)).toBe(true);
    expect(showsByDefault(runtime, now)).toBe(true);
  });

  it("still shows a recent descendant when its older parent is folded", () => {
    const olderParent: WorkspaceSnapshot = {
      ...workspace("older-parent"),
      lineage: { parentWorkspaceId: "main", evidence: "recorded" },
    };
    const recentChild: WorkspaceSnapshot = {
      ...recentlyActive("recent-child"),
      lineage: {
        parentWorkspaceId: "older-parent",
        evidence: "recorded",
      },
    };
    const result = layout(
      project([trunk, olderParent, recentChild]),
      false,
      now,
    );

    expect(result.placements.some((item) => item.key === "recent-child")).toBe(
      true,
    );
    expect(result.placements.some((item) => item.key === "older-parent")).toBe(
      false,
    );
    expect(
      result.placements.find((item) => item.key.startsWith("quiet:"))
        ?.hiddenCount,
    ).toBe(1);
    expect(result.links.find((link) => link.target === "recent-child")).toEqual(
      expect.objectContaining({ source: "main", evidence: "unrecorded" }),
    );
  });

  it("never places two nodes in the same cell", () => {
    const kids = Array.from({ length: 18 }, (_, index) =>
      changed(`kid-${index}`),
    );
    const { placements } = layout(project([trunk, ...kids]), true);

    const cells = placements.map(
      (item) => `${item.position.x}:${item.position.y}`,
    );
    expect(new Set(cells).size).toBe(placements.length);
  });

  it("never overlaps card rectangles across varied lineage trees", () => {
    let seed = 0x51_1c;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let run = 0; run < 500; run += 1) {
      const kids: WorkspaceSnapshot[] = [];
      const count = 8 + Math.floor(random() * 53);
      for (let index = 0; index < count; index += 1) {
        const name = `plot-${String(index).padStart(2, "0")}`;
        const candidates = [trunk, ...kids];
        const parent = candidates[Math.floor(random() * candidates.length)];
        kids.push({
          ...changed(name),
          lineage: {
            parentWorkspaceId: parent?.workspaceId ?? trunk.workspaceId,
            evidence: "recorded",
          },
        });
      }
      const placements = layout(project([trunk, ...kids]), true).placements;
      const overlap = placements.flatMap((left, leftIndex) =>
        placements
          .slice(leftIndex + 1)
          .flatMap((right) =>
            Math.abs(left.position.x - right.position.x) < NODE_WIDTH &&
            Math.abs(left.position.y - right.position.y) < NODE_HEIGHT
              ? [[left.key, right.key]]
              : [],
          ),
      )[0];

      expect(overlap, `lineage stress run ${run}`).toBeUndefined();
    }
  });

  it("keeps grandchildren on the side their parent was placed", () => {
    const kids = Array.from({ length: 4 }, (_, index) =>
      changed(`kid-${index}`),
    );
    const grandchild = changed("grandchild");
    const withLineage: WorkspaceSnapshot = {
      ...grandchild,
      lineage: { parentWorkspaceId: "kid-3", evidence: "recorded" },
    };
    const { placements } = layout(project([trunk, ...kids, withLineage]), true);

    const parent = placements.find((item) => item.key === "kid-3");
    const child = placements.find((item) => item.key === "grandchild");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    // Same direction of travel, one column further out.
    expect(Math.sign(child!.position.x)).toBe(Math.sign(parent!.position.x));
    expect(Math.abs(child!.position.x)).toBeGreaterThan(
      Math.abs(parent!.position.x),
    );
  });

  it("still places workspaces whose lineage forms a cycle", () => {
    const a: WorkspaceSnapshot = {
      ...changed("a"),
      lineage: { parentWorkspaceId: "b", evidence: "recorded" },
    };
    const b: WorkspaceSnapshot = {
      ...changed("b"),
      lineage: { parentWorkspaceId: "a", evidence: "recorded" },
    };
    const { placements } = layout(project([trunk, a, b]), true);

    expect(placements).toHaveLength(3);
  });
});

describe("anyNodeInView", () => {
  const card = (x: number, y: number) => ({
    position: { x, y },
    measured: { width: 268, height: 184 },
  });
  // A 1000×800 canvas with no pan and no zoom sees flow coords 0..1000/0..800.
  const view = { x: 0, y: 0, zoom: 1, width: 1000, height: 800 };

  it("sees a card inside the viewport", () => {
    expect(anyNodeInView([card(100, 100)], view)).toBe(true);
  });

  it("sees a card that only pokes into the viewport's edge", () => {
    expect(anyNodeInView([card(-260, -180)], view)).toBe(true);
  });

  it("declares lost when every card sits outside", () => {
    expect(anyNodeInView([card(2000, 2000), card(-900, 0)], view)).toBe(false);
  });

  it("accounts for pan and zoom", () => {
    // Panned so that flow coordinate 2000 lands at screen 0, at half zoom.
    const panned = { x: -1000, y: -1000, zoom: 0.5, width: 1000, height: 800 };
    expect(anyNodeInView([card(2000, 2000)], panned)).toBe(true);
    expect(anyNodeInView([card(0, 0)], panned)).toBe(false);
  });
});

describe("viewShift", () => {
  const view = { x: 0, y: 0, zoom: 1, width: 1000, height: 800 };
  const cards = (entries: Record<string, [number, number]>) =>
    new Map<string, Point>(
      Object.entries(entries).map(([key, [x, y]]) => [key, { x, y }]),
    );

  it("holds still on the first layout, where there is nothing to follow", () => {
    expect(viewShift(cards({}), cards({ a: [0, 0] }), view)).toEqual({
      kind: "hold",
    });
  });

  it("holds still when the layout did not move", () => {
    const same = cards({ a: [0, 0], b: [376, 0] });
    expect(viewShift(same, cards({ a: [0, 0], b: [376, 0] }), view)).toEqual({
      kind: "hold",
    });
  });

  it("follows the card the reader was watching", () => {
    const before = cards({ a: [100, 100] });
    const after = cards({ a: [-652, -930] });
    expect(viewShift(before, after, view)).toEqual({
      kind: "follow",
      dx: -752,
      dy: -1030,
    });
  });

  it("follows the card nearest the centre of the view", () => {
    // `far` sits at the top-left corner, `near` under the middle of the canvas.
    const before = cards({ far: [0, 0], near: [366, 308] });
    const after = cards({ far: [500, 500], near: [366, 514] });
    expect(viewShift(before, after, view)).toEqual({
      kind: "follow",
      dx: 0,
      dy: 206,
    });
  });

  it("fits the grove when everything in sight was torn down", () => {
    const before = cards({ a: [100, 100] });
    const after = cards({ b: [4000, 4000] });
    expect(viewShift(before, after, view)).toEqual({ kind: "fit" });
  });

  it("ignores cards that were already out of sight", () => {
    // The reader parked on empty paper: the rescue offers the way back, and the
    // camera must not wander off on its own while they are away.
    const before = cards({ a: [5000, 5000] });
    const after = cards({ a: [9000, 9000] });
    expect(viewShift(before, after, view)).toEqual({ kind: "hold" });
  });

  it("keeps a plot still through the teardown that rebalances the grove", () => {
    const kids = Array.from({ length: 11 }, (_, index) => `kid-${index}`);
    const before = layout(
      project([trunk, ...kids.map((name) => changed(name))]),
      true,
    );
    const after = layout(
      project([
        trunk,
        ...kids.filter((name) => name !== "kid-5").map((name) => changed(name)),
      ]),
      true,
    );
    const positions = (result: ReturnType<typeof layout>) =>
      new Map<string, Point>(
        result.placements.map((placement) => [
          placement.key,
          placement.position,
        ]),
      );
    // Parked on kid-4, which the rebalance flings from the bottom of the right
    // fan to the top of the left one.
    const watched = positions(before).get("kid-4");
    if (!watched) throw new Error("kid-4 should be placed");
    const parked = {
      x: -watched.x + 100,
      y: -watched.y + 100,
      zoom: 1,
      width: 1000,
      height: 800,
    };
    const shift = viewShift(positions(before), positions(after), parked);
    if (shift.kind !== "follow") throw new Error("the camera should follow");

    const moved = positions(after).get("kid-4");
    if (!moved) throw new Error("kid-4 should survive");
    // Following the shift leaves kid-4 on the same pixel it was watched from.
    expect(moved.x + (parked.x - shift.dx)).toBe(watched.x + parked.x);
    expect(moved.y + (parked.y - shift.dy)).toBe(watched.y + parked.y);
  });
});
