import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readWorkCliNames, resolveDisplayName } from "./work-cli-names";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveDisplayName", () => {
  const detached = "/Users/me/.codex/worktrees/70b0/SynTwin";

  it("names a detached harness worktree after its work-cli slug", () => {
    // Every detached worktree of this repository is otherwise called "SynTwin".
    expect(
      resolveDisplayName({
        path: detached,
        recorded: "SynTwin",
        workCliName: "codex-70b0",
        gitName: "SynTwin",
      }),
    ).toBe("codex-70b0");
  });

  it("falls back to the harness directory when work-cli knows nothing", () => {
    expect(
      resolveDisplayName({ path: detached, gitName: "SynTwin" }),
    ).toBe("codex-70b0");
  });

  it("keeps a recorded name that already says something", () => {
    expect(
      resolveDisplayName({
        path: "/repos/mono.worktrees/owner-onboarding",
        recorded: "feature/owner-onboarding",
        workCliName: "feature-owner-onboarding",
        gitName: "feature/owner-onboarding",
      }),
    ).toBe("feature/owner-onboarding");
  });

  it("keeps an informative branch name over a path guess", () => {
    expect(
      resolveDisplayName({
        path: "/Users/me/.codex/worktrees/2466/SynTwin",
        gitName: "cicd",
      }),
    ).toBe("cicd");
  });

  it("never guesses from the path of an ordinary checkout", () => {
    // The parent here is a workspace folder, not a worktree container.
    expect(
      resolveDisplayName({
        path: "/Users/me/01_Local_Workspace/SynTwin",
        gitName: "SynTwin",
      }),
    ).toBe("SynTwin");
  });
});

describe("readWorkCliNames", () => {
  it("maps every workspace root to its slug", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "silvic-work-cli-"));
    temporaryDirectories.push(stateRoot);
    const workspaces = join(stateRoot, "projects", "syntwin-mono", "workspaces");
    for (const [slug, root] of [
      ["codex-70b0", "/Users/me/.codex/worktrees/70b0/SynTwin"],
      ["multi-tenant", "/Users/me/repos/mono.worktrees/multi-tenant"],
    ] as const) {
      await mkdir(join(workspaces, slug), { recursive: true });
      await writeFile(
        join(workspaces, slug, "state.json"),
        JSON.stringify({ project: "syntwin-mono", workspace: slug, root }),
      );
    }

    const names = await readWorkCliNames(stateRoot);

    expect(names.get("/Users/me/.codex/worktrees/70b0/SynTwin")).toBe(
      "codex-70b0",
    );
    expect(names.get("/Users/me/repos/mono.worktrees/multi-tenant")).toBe(
      "multi-tenant",
    );
  });

  it("survives a missing state directory and unreadable files", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "silvic-work-cli-"));
    temporaryDirectories.push(stateRoot);
    const broken = join(stateRoot, "projects", "mono", "workspaces", "bad");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "state.json"), "{ not json");

    await expect(readWorkCliNames(stateRoot)).resolves.toEqual(new Map());
    await expect(
      readWorkCliNames(join(stateRoot, "does-not-exist")),
    ).resolves.toEqual(new Map());
  });
});
