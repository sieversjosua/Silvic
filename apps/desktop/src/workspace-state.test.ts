import { describe, expect, it, vi } from "vitest";

import type { SilvicSnapshot } from "@silvic/contracts";
import type { WorkspaceRecord } from "@silvic/core";
import { activeHarnessSessionWorkspaceIds } from "@silvic/connector-local";

import { WorkspaceStateService } from "./workspace-state";

const now = new Date("2026-08-28T00:00:00.000Z");
const stale: WorkspaceRecord = {
  workspaceId: "stale-record",
  projectId: "project",
  path: "/missing/workspace",
  branch: "old/attempt",
  missingSince: "2026-01-01T00:00:00.000Z",
};
const emptySnapshot: SilvicSnapshot = {
  projects: [],
  connectorFailures: [],
  refreshedAt: now.toISOString(),
};

describe("WorkspaceStateService", () => {
  it("keeps inspection genuinely read-only", async () => {
    const refreshAuthoritative = vi.fn(async () => undefined);
    const persist = vi.fn();
    const storage = vi.fn(async () => [
      {
        path: "/Users/me/.codex",
        bytes: 76_000_000_000,
        ownership: "codex" as const,
        note: "Observed only",
      },
    ]);
    const service = new WorkspaceStateService({
      records: () => [stale],
      persist,
      snapshot: () => emptySnapshot,
      refreshAuthoritative,
      existing: () => false,
      activeRuntimes: () => [],
      activeHarnessWorkspaceIds: async () => new Set(),
      providerStatePaths: () => new Set(),
      storage,
      now: () => now,
    });

    await expect(service.inspect()).resolves.toMatchObject({
      prunableRecordIds: ["stale-record"],
      storage: [{ ownership: "codex", bytes: 76_000_000_000 }],
    });
    expect(refreshAuthoritative).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(storage).toHaveBeenCalledOnce();
  });

  it("reconciles before apply and persists only an exact current plan", async () => {
    let records = [stale];
    const refreshAuthoritative = vi.fn(async () => undefined);
    const persist = vi.fn((next: readonly WorkspaceRecord[]) => {
      records = [...next];
    });
    const service = new WorkspaceStateService({
      records: () => records,
      persist,
      snapshot: () => emptySnapshot,
      refreshAuthoritative,
      existing: () => false,
      activeRuntimes: () => [],
      activeHarnessWorkspaceIds: async () => new Set(),
      providerStatePaths: () => new Set(),
      storage: async () => [],
      now: () => now,
    });
    const plan = await service.inspect();

    await expect(service.prune("wrong-plan")).rejects.toMatchObject({
      code: "STATE_PLAN_CONFIRMATION_REQUIRED",
      details: { planId: plan.planId, targets: ["stale-record"] },
    });
    expect(refreshAuthoritative).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();

    await expect(service.prune(plan.planId)).resolves.toMatchObject({
      removedRecordIds: ["stale-record"],
    });
    expect(refreshAuthoritative).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledWith([]);
    expect(records).toEqual([]);
  });

  it("protects a missing Workspace while an active Codex Session remains inside it", async () => {
    const service = new WorkspaceStateService({
      records: () => [stale],
      persist: vi.fn(),
      snapshot: () => emptySnapshot,
      refreshAuthoritative: vi.fn(async () => undefined),
      existing: () => false,
      activeRuntimes: () => [],
      activeHarnessWorkspaceIds: async (records) =>
        activeHarnessSessionWorkspaceIds(records, [
          {
            id: "active-codex-session",
            cwd: "/missing/workspace/apps/web",
            title: "Recover state safely",
            updatedAtMs: now.getTime(),
            harness: "codex",
            active: true,
          },
        ]),
      providerStatePaths: () => new Set(),
      storage: async () => [],
      now: () => now,
    });

    await expect(service.inspect()).resolves.toMatchObject({
      staleRecords: [
        {
          workspaceId: "stale-record",
          action: "protect",
          reasons: ["active-session"],
        },
      ],
      prunableRecordIds: [],
    });
  });
});
