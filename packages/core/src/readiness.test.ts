import { describe, expect, it } from "vitest";

import { waitForReadiness } from "./readiness";

describe("waitForReadiness", () => {
  it("retries until the preview answers", async () => {
    let elapsed = 0;
    let attempts = 0;

    const result = await waitForReadiness({
      url: "https://auth-callback.localhost",
      probe: async () => ++attempts >= 3,
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => elapsed,
      intervalMs: 200,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ status: "ready", durationMs: 400 });
    expect(attempts).toBe(3);
  });

  it("settles as failed when the deadline expires", async () => {
    let elapsed = 0;
    let attempts = 0;

    const result = await waitForReadiness({
      url: "https://auth-callback.localhost",
      probe: async () => {
        attempts += 1;
        return false;
      },
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => elapsed,
      intervalMs: 200,
      timeoutMs: 450,
    });

    expect(result).toEqual({
      status: "failed",
      durationMs: 450,
      detail: "The preview did not respond within 450 ms.",
    });
    expect(attempts).toBe(3);
  });

  it("keeps the latest probe failure as useful context", async () => {
    let elapsed = 0;

    const result = await waitForReadiness({
      url: "https://auth-callback.localhost",
      probe: async () => {
        throw new Error("connection refused");
      },
      wait: async (milliseconds) => {
        elapsed += milliseconds;
      },
      now: () => elapsed,
      intervalMs: 100,
      timeoutMs: 100,
    });

    expect(result.detail).toBe(
      "The preview did not respond within 100 ms. Last check: connection refused",
    );
  });
});
