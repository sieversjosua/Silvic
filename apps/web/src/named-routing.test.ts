import { describe, expect, it, vi } from "vitest";

import { namedRoutingReady, pollNamedRouting } from "./named-routing";

const blocked = {
  name: "plot",
  path: "/tmp/plot",
  url: "https://web-plot-project.localhost",
  port: 4100,
  advice: "Set up portless",
};

const ready = {
  name: "plot",
  path: "/tmp/plot",
  url: "https://web-plot-project.localhost",
  port: 4100,
};

describe("pollNamedRouting", () => {
  it("only allows creation after a successful route preview", () => {
    expect(namedRoutingReady(undefined)).toBe(false);
    expect(namedRoutingReady(blocked)).toBe(false);
    expect(namedRoutingReady(ready)).toBe(true);
  });

  it("rechecks until the named route is ready", async () => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce(blocked)
      .mockResolvedValueOnce(ready);
    const onPreview = vi.fn();
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      pollNamedRouting({ preview, onPreview, wait, isCancelled: () => false }),
    ).resolves.toBe("ready");

    expect(wait).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(onPreview).toHaveBeenNthCalledWith(1, blocked);
    expect(onPreview).toHaveBeenNthCalledWith(2, ready);
  });

  it("stops after the configured attempt limit", async () => {
    const preview = vi.fn().mockResolvedValue(blocked);

    await expect(
      pollNamedRouting({
        preview,
        onPreview: vi.fn(),
        wait: vi.fn().mockResolvedValue(undefined),
        isCancelled: () => false,
        maxAttempts: 3,
      }),
    ).resolves.toBe("timed-out");

    expect(preview).toHaveBeenCalledTimes(3);
  });

  it("does not preview after the dialog is closed", async () => {
    const preview = vi.fn().mockResolvedValue(ready);

    await expect(
      pollNamedRouting({
        preview,
        onPreview: vi.fn(),
        wait: vi.fn().mockResolvedValue(undefined),
        isCancelled: () => true,
      }),
    ).resolves.toBe("cancelled");

    expect(preview).not.toHaveBeenCalled();
  });
});
