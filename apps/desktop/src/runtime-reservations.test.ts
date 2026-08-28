import { describe, expect, it, vi } from "vitest";

import type { RuntimePortReservations } from "./runtime-reservations";
import { reserveRuntimePorts } from "./runtime-reservations";

function memoryStore(initial: RuntimePortReservations = {}) {
  let reservations = initial;
  return {
    store: {
      read: () => reservations,
      write: vi.fn((next: RuntimePortReservations) => {
        reservations = next;
      }),
    },
    current: () => reservations,
  };
}

describe("desktop runtime port reservations", () => {
  it("atomically persists unique reservations for concurrent Plot starts", async () => {
    const memory = memoryStore();
    const commands = {
      web: { run: "vite dev", url: true },
      agent: { run: "livekit-agent dev" },
    } as const;
    const starts = Array.from({ length: 5 }, (_, index) => ({
      workspaceId: `workspace_${index}`,
      plotPort: 3_100 + index,
    })).flatMap((plot) =>
      Object.keys(commands).map((commandId) => ({ ...plot, commandId })),
    );

    const results = await Promise.all(
      starts.map(async ({ workspaceId, plotPort, commandId }) => {
        await Promise.resolve();
        return reserveRuntimePorts({
          store: memory.store,
          workspaceId,
          commands,
          commandId,
          plotPort,
          claimedPlotPorts: [3_100, 3_101, 3_102, 3_103, 3_104],
        });
      }),
    );

    const ports = results.flatMap((reservation) => [
      reservation.port,
      reservation.inspectorPort,
    ]);
    expect(new Set(ports).size).toBe(20);
    expect(Object.values(memory.current())).toHaveLength(5);
    expect(Object.values(memory.current()).flatMap(Object.values)).toHaveLength(
      10,
    );
  });

  it("reuses the persisted reservation on repeated Start without rewriting", () => {
    const memory = memoryStore();
    const request = {
      store: memory.store,
      workspaceId: "workspace_repeat",
      commands: { web: { run: "vite dev", url: true } },
      commandId: "web",
      plotPort: 4_321,
      claimedPlotPorts: [4_321],
    } as const;

    const first = reserveRuntimePorts(request);
    const repeated = reserveRuntimePorts(request);

    expect(repeated).toEqual(first);
    expect(memory.store.write).toHaveBeenCalledTimes(1);
  });
});
