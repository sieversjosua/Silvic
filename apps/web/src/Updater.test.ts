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

  it("confirms a completed check instead of silently resetting", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: { phase: "current", currentVersion: "0.1.0" },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Up to date");
    expect(markup).toContain("Check for updates");
  });

  it("stacks its copy above the action in the narrow sidebar", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: { phase: "current", currentVersion: "0.1.0" },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain(
      '<span class="app-update-copy"><span class="micro">Silvic 0.1.0</span><span class="app-update-detail" title="Up to date">Up to date</span></span><button',
    );
  });

  it("shows the failure reason in place, not only on hover", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: {
          phase: "error",
          currentVersion: "0.1.0",
          message: "Release offline",
        },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Release offline");
    expect(markup).toContain('role="status"');
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

  it("moves a packaged app before offering downloads", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: {
          phase: "relocation-required",
          currentVersion: "0.1.0",
        } as never,
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Move to Applications");
    expect(markup).not.toContain("Check for updates");
  });

  it("makes installation visibly non-interactive", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: {
          phase: "installing",
          currentVersion: "0.1.0",
          availableVersion: "0.1.1",
        } as never,
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain("Installing…");
    expect(markup).toContain('aria-disabled="true"');
  });

  it("maps each visible action to exactly one desktop update command", async () => {
    const actions = {
      check: vi.fn(async () => undefined),
      download: vi.fn(async () => undefined),
      relocate: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
    };

    await performUpdateAction(
      {
        phase: "relocation-required",
        currentVersion: "0.1.0",
      },
      actions,
    );
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
    expect(actions.relocate).toHaveBeenCalledOnce();
    expect(actions.install).toHaveBeenCalledOnce();
  });
});
