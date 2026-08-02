import { describe, expect, it } from "vitest";

import { resolveDisplayName } from "./workspace-names";

describe("resolveDisplayName", () => {
  const detached = "/Users/me/.codex/worktrees/70b0/SynTwin";

  it("names a detached harness worktree from its directory evidence", () => {
    expect(resolveDisplayName({ path: detached, gitName: "SynTwin" })).toBe(
      "codex-70b0",
    );
  });

  it("keeps a recorded name that already says something", () => {
    expect(
      resolveDisplayName({
        path: "/repos/mono.worktrees/owner-onboarding",
        recorded: "feature/owner-onboarding",
        gitName: "feature/owner-onboarding",
      }),
    ).toBe("feature/owner-onboarding");
  });

  it("prefers an exact-CWD agent session title over an opaque harness id", () => {
    expect(
      resolveDisplayName({
        path: detached,
        sessionName: "Fix owner onboarding",
        gitName: "SynTwin",
      }),
    ).toBe("Fix owner onboarding");
  });

  it("distinguishes T3 worktrees by their final identifier", () => {
    expect(
      resolveDisplayName({
        path: "/Users/me/.t3/worktrees/SynTwin/a81f",
        gitName: "SynTwin",
      }),
    ).toBe("t3-a81f");
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
    expect(
      resolveDisplayName({
        path: "/Users/me/01_Local_Workspace/SynTwin",
        gitName: "SynTwin",
      }),
    ).toBe("SynTwin");
  });
});
