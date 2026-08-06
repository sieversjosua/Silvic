import { describe, expect, it } from "vitest";

import type {
  ProjectSnapshot,
  SilvicSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { mergeSnapshots, withoutWorkspace } from "./snapshot-merge";

const workspace = (
  path: string,
  branch: string,
  isPrimary: boolean,
): WorkspaceSnapshot => ({
  workspaceId: path,
  projectId: "github.com/example/like.photo",
  path,
  repositoryName: "like.photo",
  branch,
  name: branch,
  locationKind: "checkout",
  isPrimary,
  git: {
    branch,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  },
  observations: [],
});

const project = (
  name: string,
  rootPath: string,
  workspaces: readonly WorkspaceSnapshot[],
): ProjectSnapshot => ({
  id: "github.com/example/like.photo",
  name,
  rootPath,
  origin: "git@github.com:example/like.photo.git",
  workspaces,
  branches: workspaces.map((entry) => entry.branch),
  remoteBranches: [],
});

describe("mergeSnapshots", () => {
  it("updates one checkout without replacing the project's identity or siblings", () => {
    const primary = workspace("/repos/like.photo", "main", true);
    const selected = workspace(
      "/repos/49_sievate_images",
      "49_sievate_images",
      false,
    );
    const observedSelected: WorkspaceSnapshot = {
      ...selected,
      observations: [
        {
          connectorId: "local-context",
          workspaceId: selected.workspaceId,
          kind: "runtime",
          state: "active",
          label: "node",
          url: "http://localhost:3456",
        },
      ],
    };
    const current: SilvicSnapshot = {
      projects: [
        project("like.photo", primary.path, [
          primary,
          observedSelected,
          workspace("/plots/other", "other", false),
        ]),
      ],
      connectorFailures: [],
      refreshedAt: "before",
    };
    const refreshedSelected = {
      ...selected,
      isPrimary: true,
      git: { ...selected.git, unstaged: 2 },
    };
    const incoming: SilvicSnapshot = {
      projects: [
        project("49_sievate_images", selected.path, [refreshedSelected]),
      ],
      connectorFailures: [],
      refreshedAt: "after",
    };

    const merged = mergeSnapshots(current, incoming);

    expect(merged.projects[0]?.name).toBe("like.photo");
    expect(merged.projects[0]?.rootPath).toBe(primary.path);
    expect(merged.projects[0]?.workspaces).toHaveLength(3);
    expect(
      merged.projects[0]?.workspaces.find(
        (entry) => entry.path === selected.path,
      )?.git.unstaged,
    ).toBe(2);
    expect(
      merged.projects[0]?.workspaces.find(
        (entry) => entry.path === selected.path,
      )?.observations,
    ).toEqual(observedSelected.observations);
    expect(
      merged.projects[0]?.workspaces.filter((entry) => entry.isPrimary),
    ).toEqual([primary]);
  });
});

describe("withoutWorkspace", () => {
  const primary = workspace("/repos/like.photo", "main", true);
  const torn = workspace(
    "/plots/49_sievate_images",
    "49_sievate_images",
    false,
  );
  const kept = workspace("/plots/other", "other", false);
  const snapshot: SilvicSnapshot = {
    projects: [project("like.photo", primary.path, [primary, torn, kept])],
    connectorFailures: [],
    refreshedAt: "now",
  };

  it("drops the torn-down plot and leaves the rest of the project alone", () => {
    const after = withoutWorkspace(snapshot, torn.path);

    expect(after.projects[0]?.workspaces.map((entry) => entry.path)).toEqual([
      primary.path,
      kept.path,
    ]);
    expect(after.projects[0]?.name).toBe("like.photo");
    expect(after.projects[0]?.branches).toEqual(snapshot.projects[0]?.branches);
  });

  it("recognises the same directory written another way", () => {
    const after = withoutWorkspace(snapshot, "/plots/./49_sievate_images");

    expect(after.projects[0]?.workspaces.map((entry) => entry.path)).toEqual([
      primary.path,
      kept.path,
    ]);
  });

  it("changes nothing when the path belongs to no plot", () => {
    expect(withoutWorkspace(snapshot, "/plots/elsewhere")).toEqual(snapshot);
  });
});
