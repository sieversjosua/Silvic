import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sessionRefreshIntervalMs,
  startSessionRefreshLoop,
} from "./session-refresh";

describe("startSessionRefreshLoop", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps visible session observations fresh without polling in background", async () => {
    vi.useFakeTimers();
    let visible = true;
    const refresh = vi.fn();
    const stop = startSessionRefreshLoop({
      isVisible: () => visible,
      refresh,
    });

    await vi.advanceTimersByTimeAsync(sessionRefreshIntervalMs);
    expect(refresh).toHaveBeenCalledTimes(1);

    visible = false;
    await vi.advanceTimersByTimeAsync(sessionRefreshIntervalMs * 2);
    expect(refresh).toHaveBeenCalledTimes(1);

    visible = true;
    stop();
    await vi.advanceTimersByTimeAsync(sessionRefreshIntervalMs);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
