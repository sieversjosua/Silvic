import { expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@silvic/contracts";

import { inferWorkspaceLineage } from "./git";

function workspace(
  id: string,
  revision: string,
  isPrimary = false,
): WorkspaceSnapshot {
  return {
    workspaceId: id,
    projectId: "project",
    path: `/repo/${id}`,
    repositoryName: "repo",
    branch: id,
    name: id,
    locationKind: isPrimary ? "checkout" : "worktree",
    isPrimary,
    git: {
      branch: id,
      revision,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    },
    observations: [],
  };
}

it("discovers the nearest checked-out ancestors of an external stack", () => {
  const result = inferWorkspaceLineage(
    [
      workspace("main", "a", true),
      workspace("base", "c"),
      workspace("leaf", "e"),
      workspace("unrelated", "u"),
    ],
    ["e d", "d c", "c b", "b a", "a", "u a"].join("\n"),
  );

  expect(result.find((item) => item.workspaceId === "base")?.lineage).toEqual({
    parentWorkspaceId: "main",
    evidence: "inferred",
  });
  expect(result.find((item) => item.workspaceId === "leaf")?.lineage).toEqual({
    parentWorkspaceId: "base",
    evidence: "inferred",
  });
  expect(
    result.find((item) => item.workspaceId === "unrelated")?.lineage,
  ).toEqual({
    parentWorkspaceId: "main",
    evidence: "inferred",
  });
});
