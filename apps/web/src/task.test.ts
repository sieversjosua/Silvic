import { describe, expect, it } from "vitest";

import {
  applyProvisionRun,
  branchForIssue,
  branchForPlotName,
  branchIsTaken,
  canOpenCreatedPlot,
} from "./task";

describe("branchForPlotName", () => {
  it("turns a human plot name into a stable Git branch", () => {
    expect(branchForPlotName("Auth Callback testen")).toBe(
      "auth-callback-testen",
    );
  });

  it("normalizes accents and keeps explicit branch groups", () => {
    expect(branchForPlotName("feature/Überarbeitete Grüße")).toBe(
      "feature/uberarbeitete-grusse",
    );
  });

  it("removes empty path segments and invalid punctuation", () => {
    expect(branchForPlotName(" / Pricing + Checkout / ")).toBe(
      "pricing-checkout",
    );
  });
});

describe("branchForIssue", () => {
  it("turns the selected Issue into a readable Git branch", () => {
    expect(
      branchForIssue({
        provider: "github",
        number: 184,
        title: "Fix HEIC uploads & conversion!",
        body: "",
        url: "https://github.com/example/app/issues/184",
        labels: [],
        assignees: [],
      }),
    ).toBe("issue/184-fix-heic-uploads-conversion");
  });
});

describe("canOpenCreatedPlot", () => {
  const successfulProvision = {
    label: "Install dependencies",
    command: "pnpm install",
    exitCode: 0,
    output: "",
    durationMs: 12,
  };

  it("opens the harness after provisioning and preview readiness succeed", () => {
    expect(
      canOpenCreatedPlot({
        provision: [successfulProvision],
        runtime: { status: "started", durationMs: 50 },
        readiness: { status: "ready", durationMs: 450 },
      }),
    ).toBe(true);
  });

  it("does not open when provisioning or preview readiness failed", () => {
    expect(
      canOpenCreatedPlot({
        provision: [{ ...successfulProvision, exitCode: 1 }],
        runtime: { status: "not-required", durationMs: 0 },
        readiness: { status: "not-required", durationMs: 0 },
      }),
    ).toBe(false);
    expect(
      canOpenCreatedPlot({
        provision: [successfulProvision],
        runtime: { status: "started", durationMs: 50 },
        readiness: { status: "failed", durationMs: 60_000 },
      }),
    ).toBe(false);
  });

  it("does not open when an auto-starting runtime failed", () => {
    expect(
      canOpenCreatedPlot({
        provision: [successfulProvision],
        runtime: {
          status: "failed",
          durationMs: 1_000,
          detail: "convex exited during startup",
        },
        readiness: { status: "ready", durationMs: 450 },
      }),
    ).toBe(false);
  });
});

describe("applyProvisionRun", () => {
  it("replaces stale runtime and readiness after a repair", () => {
    const repaired = applyProvisionRun(
      {
        name: "auth-callback",
        provision: [],
        runtime: { status: "not-required" as const, durationMs: 0 },
        readiness: {
          status: "not-required" as const,
          durationMs: 0,
          detail: "Provisioning did not complete",
        },
      },
      {
        provision: [],
        runtime: { status: "started", durationMs: 800 },
        readiness: { status: "ready", durationMs: 2_400 },
      },
    );

    expect(repaired.runtime.status).toBe("started");
    expect(repaired.readiness).toEqual({
      status: "ready",
      durationMs: 2_400,
    });
  });
});

describe("branchIsTaken", () => {
  it("does not reject the branch that the current creation just added", () => {
    expect(
      branchIsTaken({
        branch: "golden-path",
        branches: ["main", "golden-path"],
        creating: true,
        adopting: false,
      }),
    ).toBe(false);
  });

  it("still rejects an existing branch before creation", () => {
    expect(
      branchIsTaken({
        branch: "golden-path",
        branches: ["main", "golden-path"],
        creating: false,
        adopting: false,
      }),
    ).toBe(true);
  });
});
