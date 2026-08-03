import { describe, expect, it } from "vitest";

import { runtimeStartResult } from "./runtime-start";

describe("runtimeStartResult", () => {
  it("requires every declared runtime to remain running", () => {
    expect(
      runtimeStartResult({
        commands: ["web", "convex"],
        processes: [
          { id: "web", status: "running" },
          { id: "convex", status: "running" },
        ],
        failures: {},
        durationMs: 1_000,
      }),
    ).toEqual({ status: "started", durationMs: 1_000 });
  });

  it("names thrown, stopped, and missing runtimes as failures", () => {
    const result = runtimeStartResult({
      commands: ["web", "convex", "agent"],
      processes: [
        { id: "convex", status: "failed", exitCode: 1 },
        { id: "agent", status: "stopped", advice: "worker disconnected" },
      ],
      failures: { web: "command not found" },
      durationMs: 1_000,
    });

    expect(result.status).toBe("failed");
    expect(result.failedCommands).toEqual(["web", "convex", "agent"]);
    expect(result.detail).toContain("web (command not found)");
    expect(result.detail).toContain("convex (Exited with code 1)");
    expect(result.detail).toContain("agent (worker disconnected)");
  });
});
