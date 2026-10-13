import { expect, it, vi } from "vitest";
import type { WakeEvent } from "./control-protocol";
import { Waker } from "./wake";

it("backs off failed wakes, ignores stale acknowledgements and permits manual retry", () => {
  let now = 1;
  const events: WakeEvent[] = [];
  const log = vi.fn();
  const waker = new Waker({
    now: () => now,
    log,
    broadcast: (event) => {
      events.push(event);
      return true;
    },
  });
  const route = { name: "web-demo", updatedAt: "2026-10-13" };
  waker.wake(route);
  const first = events[0]?.requestId;
  if (!first) throw new Error("Missing request ID");
  waker.result(route.name, first, {
    outcome: "failed",
    message: "Authentication failed",
  });
  now += 29_999;
  waker.wake(route);
  expect(events).toHaveLength(1);
  now++;
  waker.wake(route);
  expect(events).toHaveLength(2);
  const second = events[1]?.requestId;
  if (!second) throw new Error("Missing retry ID");
  waker.result(route.name, first, { outcome: "started", message: "stale" });
  expect(waker.status(route.name)?.outcome).toBe("starting");
  waker.result(route.name, second, {
    outcome: "failed",
    message: "Connection failed",
  });
  expect(waker.status(route.name)?.retryAt).toBe(now + 60_000);
  waker.retry(route);
  expect(events).toHaveLength(3);
  const third = events[2]?.requestId;
  if (!third) throw new Error("Missing manual retry ID");
  waker.result(route.name, third, {
    outcome: "plot-missing",
    message: "Plot removed",
  });
  expect(waker.status(route.name)?.retryAt).toBe(now + 30 * 60_000);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("wake result web-demo"),
  );
});

it("backs off a connected app that never acknowledges a wake", () => {
  let now = 0;
  const broadcast = vi.fn(() => true);
  const waker = new Waker({ now: () => now, log: () => undefined, broadcast });
  const route = { name: "no-app", updatedAt: "2026-10-13" };
  waker.wake(route);
  expect(broadcast).toHaveBeenCalledOnce();
  now = 60_000;
  waker.wake(route);
  expect(waker.status(route.name)?.outcome).toBe("no-response");
  expect(broadcast).toHaveBeenCalledOnce();
  now = 90_000;
  waker.wake(route);
  expect(broadcast).toHaveBeenCalledTimes(2);
});

it("counts a timed-out attempt only once when its failure arrives late", () => {
  let now = 0;
  let requestId: string | undefined;
  const waker = new Waker({
    now: () => now,
    log: () => undefined,
    broadcast: (event) => {
      requestId = event.requestId;
      return true;
    },
  });
  const route = { name: "late-ack", updatedAt: "2026-10-13" };
  waker.wake(route);
  if (!requestId) throw new Error("Missing request ID");
  now = 60_000;
  expect(waker.status(route.name)?.outcome).toBe("no-response");
  waker.result(route.name, requestId, {
    outcome: "failed",
    message: "late failure",
  });
  expect(waker.status(route.name)?.retryAt).toBe(now + 30_000);
  waker.result(route.name, requestId, {
    outcome: "failed",
    message: "duplicate failure",
  });
  expect(waker.status(route.name)?.retryAt).toBe(now + 30_000);
  waker.retry(route);
  now += 60_000;
  expect(waker.status(route.name)?.outcome).toBe("no-response");
  waker.result(route.name, requestId, {
    outcome: "started",
    message: "late success",
  });
  expect(waker.status(route.name)?.outcome).toBe("started");
});
