import { describe, expect, it, vi } from "vitest";

import type { PlotProgress } from "@silvic/contracts";

import { PlotProgressReporter } from "./plot-progress";

function reporter() {
  const sent: PlotProgress[] = [];
  const progress = new PlotProgressReporter(
    "feature/test1",
    [
      { id: "checkout", label: "Create the linked worktree" },
      { id: "provision:0", label: "Install dependencies" },
      { id: "survey", label: "Survey the new plot" },
    ],
    (payload) => sent.push(payload),
  );
  return { progress, sent, latest: () => sent[sent.length - 1] };
}

describe("PlotProgressReporter", () => {
  it("announces every step, including the ones still to come", () => {
    const { progress, latest } = reporter();

    progress.announce();

    expect(latest()?.branch).toBe("feature/test1");
    expect(latest()?.steps.map((step) => step.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("sends the whole plan on every change, so an event cannot be missed", () => {
    const { progress, latest } = reporter();

    progress.began("checkout");
    progress.finished("checkout", 412);
    progress.began("provision:0");

    expect(latest()?.steps).toEqual([
      {
        id: "checkout",
        label: "Create the linked worktree",
        status: "done",
        durationMs: 412,
      },
      {
        id: "provision:0",
        label: "Install dependencies",
        status: "running",
      },
      { id: "survey", label: "Survey the new plot", status: "pending" },
    ]);
  });

  it("shows the newest line a running step printed, without terminal control codes", () => {
    vi.useFakeTimers();
    try {
      const { progress, latest } = reporter();
      progress.began("provision:0");

      progress.wrote(
        "provision:0",
        "Progress: resolved 12\r[2mProgress: resolved 340[22m\n",
      );
      vi.runAllTimers();

      expect(latest()?.steps[1]?.detail).toBe("Progress: resolved 340");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces output but never delays a change of status", () => {
    vi.useFakeTimers();
    try {
      const { progress, sent } = reporter();
      progress.began("provision:0");
      const afterStart = sent.length;

      for (let index = 0; index < 50; index += 1) {
        progress.wrote("provision:0", `line ${index}\n`);
      }
      expect(sent.length).toBe(afterStart);

      vi.runAllTimers();
      expect(sent.length).toBe(afterStart + 1);
      expect(sent[sent.length - 1]?.steps[1]?.detail).toBe("line 49");

      progress.finished("provision:0", 10);
      expect(sent.length).toBe(afterStart + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores output from a step that is no longer running", () => {
    vi.useFakeTimers();
    try {
      const { progress, latest } = reporter();
      progress.began("provision:0");
      progress.finished("provision:0", 10);

      progress.wrote("provision:0", "a late line\n");
      vi.runAllTimers();

      expect(latest()?.steps[1]?.detail).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blames the running step when the failure came from around the command", () => {
    const { progress, latest } = reporter();
    progress.began("checkout");

    progress.stumbled("git worktree add failed: fatal: invalid reference");

    expect(latest()?.steps[0]).toEqual({
      id: "checkout",
      label: "Create the linked worktree",
      status: "failed",
      detail: "git worktree add failed: fatal: invalid reference",
    });
  });

  it("has nothing to blame when the failure happened before any step ran", () => {
    const { progress, sent } = reporter();
    progress.announce();

    progress.stumbled("Choose a discovered Workspace");

    expect(sent).toHaveLength(1);
  });

  it("drops a coalesced send once the creation has settled", () => {
    vi.useFakeTimers();
    try {
      const { progress, sent } = reporter();
      progress.began("provision:0");
      progress.wrote("provision:0", "still going\n");
      const before = sent.length;

      progress.settled();
      vi.runAllTimers();

      expect(sent.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
