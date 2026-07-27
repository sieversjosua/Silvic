import { describe, expect, it } from "vitest";

import type {
  ConnectorObservation,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { NODE_HEIGHT, NODE_WIDTH, layout } from "./grove-layout";

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
  };
}

const deployment: ConnectorObservation = {
  connectorId: "convex",
  workspaceId: "any",
  kind: "deployment",
  state: "active",
  label: "brazen-labrador-831",
};

const trunk = workspace("main", { isPrimary: true, locationKind: "checkout" });
const changed = (name: string) =>
  workspace(name, {
    git: { ...workspace(name).git, unstaged: 2 },
  });

describe("layout", () => {
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

  it("folds quiet environments into one stack", () => {
    const quiet = Array.from({ length: 5 }, (_, index) =>
      workspace(`quiet-${index}`),
    );
    const { placements } = layout(project([trunk, changed("busy"), ...quiet]), false);

    const stack = placements.find((item) => item.key.startsWith("quiet:"));
    expect(stack?.quietCount).toBe(5);
    expect(placements.filter((item) => item.workspace)).toHaveLength(2);
  });

  it("shows every environment once folding is turned off", () => {
    const quiet = Array.from({ length: 5 }, (_, index) =>
      workspace(`quiet-${index}`),
    );
    const { placements } = layout(project([trunk, changed("busy"), ...quiet]), true);

    expect(placements.find((item) => item.key.startsWith("quiet:"))).toBeUndefined();
    expect(placements.filter((item) => item.workspace)).toHaveLength(7);
  });

  it("does not treat a shared deployment as activity worth showing", () => {
    const attached = Array.from({ length: 4 }, (_, index) =>
      workspace(`attached-${index}`, { observations: [deployment] }),
    );
    const { placements } = layout(project([trunk, ...attached]), false);

    // All four are clean, so the shared Convex deployment must not keep them out
    // of the quiet stack.
    expect(
      placements.find((item) => item.key.startsWith("quiet:"))?.quietCount,
    ).toBe(4);
  });

  it("never places two nodes in the same cell", () => {
    const kids = Array.from({ length: 18 }, (_, index) =>
      changed(`kid-${index}`),
    );
    const { placements } = layout(project([trunk, ...kids]), true);

    const cells = placements.map((item) => `${item.position.x}:${item.position.y}`);
    expect(new Set(cells).size).toBe(placements.length);
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
    const { placements } = layout(
      project([trunk, ...kids, withLineage]),
      true,
    );

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
