import { describe, expect, it } from "vitest";

import {
  applyWorkspaceStatePlan,
  planWorkspaceState,
  type WorkspaceStatePlanInput,
} from "./workspace-state";
import type { WorkspaceRecord } from "./workspace-registry";

const now = new Date("2026-08-28T12:00:00.000Z");
const old = "2026-06-01T00:00:00.000Z";

describe("workspace state reconciliation", () => {
  it("protects active, existing, session, and provider-backed stale records", () => {
    const records = [
      stale("runtime", "/gone/runtime"),
      stale("session", "/gone/session"),
      stale("existing", "/still/here"),
      stale("provider", "/gone/provider", {
        adoption: { status: "adopted", at: old, attempt: 1 },
      }),
      stale("eligible", "/gone/eligible"),
    ];
    const state = buildPlan({
      records,
      activeRuntimePaths: new Set(["/gone/runtime"]),
      activeSessionPaths: new Set(["/gone/session/apps/web"]),
      existingPaths: new Set(["/still/here"]),
    });

    expect(
      Object.fromEntries(
        state.staleRecords.map((record) => [
          record.workspaceId,
          [record.action, record.reasons],
        ]),
      ),
    ).toEqual({
      eligible: ["prune-metadata", []],
      existing: ["protect", ["existing-location"]],
      provider: ["protect", ["provider-state"]],
      runtime: ["protect", ["active-runtime"]],
      session: ["protect", ["active-session"]],
    });
  });

  it("retains newly missing metadata for 30 days and uses a stable plan id", () => {
    const records = [
      stale("recent", "/gone/recent", {
        missingSince: "2026-08-20T00:00:00.000Z",
      }),
    ];
    const first = buildPlan({ records });
    const second = buildPlan({ records });

    expect(first.staleRecords[0]).toMatchObject({
      action: "retain",
      ageDays: 8,
    });
    expect(first.planId).toBe(second.planId);
  });

  it("requires the exact plan and removes only named Silvic metadata", () => {
    const records = [
      stale("eligible", "/gone/eligible"),
      stale("protected", "/still/here"),
      active("active", "/active"),
    ];
    const state = buildPlan({
      records,
      existingPaths: new Set(["/still/here"]),
    });

    expect(() => applyWorkspaceStatePlan(records, state, "wrong")).toThrow(
      `Confirm this exact state plan with ${state.planId}.`,
    );
    const applied = applyWorkspaceStatePlan(records, state, state.planId);
    expect(applied.removed.map((record) => record.workspaceId)).toEqual([
      "eligible",
    ]);
    expect(applied.records.map((record) => record.workspaceId)).toEqual([
      "protected",
      "active",
    ]);
    expect(state.boundaries.join(" ")).toContain(
      "worktrees, directories, branches, sessions, and processes are never removed",
    );
  });
});

function buildPlan(input: WorkspaceStatePlanInput) {
  return planWorkspaceState({ ...input, now });
}

function stale(
  workspaceId: string,
  path: string,
  overrides: Partial<WorkspaceRecord> = {},
): WorkspaceRecord {
  return {
    workspaceId,
    projectId: "project",
    path,
    branch: `branch/${workspaceId}`,
    missingSince: old,
    ...overrides,
  };
}

function active(workspaceId: string, path: string): WorkspaceRecord {
  return {
    workspaceId,
    projectId: "project",
    path,
    branch: `branch/${workspaceId}`,
    lastSeenAt: now.toISOString(),
  };
}
