import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { performUpdateAction, UpdateButton } from "./Updater";

describe("UpdateButton", () => {
  it("makes an available version an explicit sidebar action", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: {
          phase: "available",
          currentVersion: "0.1.0",
          availableVersion: "0.1.1",
        },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Silvic 0.1.0");
    expect(markup).toContain("Update to 0.1.1");
    expect(markup).toContain('data-tone="available"');
  });

  it("turns a downloaded release into a restart action", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: {
          phase: "ready",
          currentVersion: "0.1.0",
          availableVersion: "0.1.1",
        },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Restart to update");
    expect(markup).not.toContain("Update to 0.1.1");
  });

  it.each([
    [{ phase: "idle", currentVersion: "0.1.0" }, "Check for updates"],
    [{ phase: "checking", currentVersion: "0.1.0" }, "Checking…"],
    [
      {
        phase: "downloading",
        currentVersion: "0.1.0",
        availableVersion: "0.1.1",
        progressPercent: 49,
      },
      "Downloading 49%",
    ],
    [
      {
        phase: "error",
        currentVersion: "0.1.0",
        message: "Release offline",
      },
      "Retry update",
    ],
  ] as const)("explains update state %# in place", (state, label) => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, { state, onAction: vi.fn() }),
    );

    expect(markup).toContain(label);
  });

  it("identifies a development build without offering a broken action", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: { phase: "unsupported", currentVersion: "0.1.0" },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Development build");
    expect(markup).not.toContain("<button");
  });

  it("maps each visible action to exactly one desktop update command", async () => {
    const actions = {
      check: vi.fn(async () => undefined),
      download: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
    };

    await performUpdateAction(
      {
        phase: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.1.1",
      },
      actions,
    );
    await performUpdateAction(
      {
        phase: "ready",
        currentVersion: "0.1.0",
        availableVersion: "0.1.1",
      },
      actions,
    );

    expect(actions.check).not.toHaveBeenCalled();
    expect(actions.download).toHaveBeenCalledOnce();
    expect(actions.install).toHaveBeenCalledOnce();
  });
});
