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

    expect(markup).toContain("Silvic 0.1.1");
    expect(markup).toContain('class="app-update-label">Update</span>');
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

    expect(markup).toContain('class="app-update-label">Restart</span>');
    expect(markup).not.toContain(">Update<");
  });

  it.each([
    [{ phase: "idle", currentVersion: "0.1.0" }, "Check updates"],
    [{ phase: "checking", currentVersion: "0.1.0" }, "Checking…"],
    [
      {
        phase: "downloading",
        currentVersion: "0.1.0",
        availableVersion: "0.1.1",
        progressPercent: 49,
      },
      "49%",
    ],
    [
      {
        phase: "error",
        currentVersion: "0.1.0",
        message: "Release offline",
      },
      "Retry",
    ],
  ] as const)("explains update state %# in place", (state, label) => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, { state, onAction: vi.fn() }),
    );

    expect(markup).toContain(label);
  });

  it("keeps a completed check in the compact button's accessible copy", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: { phase: "current", currentVersion: "0.1.0" },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain(
      'aria-label="Silvic 0.1.0. Check updates. Up to date"',
    );
    expect(markup).not.toContain(">Up to date<");
  });

  it("combines version and action into one compact sidebar button", () => {
    const markup = renderToStaticMarkup(
      createElement(UpdateButton, {
        state: { phase: "current", currentVersion: "0.1.0" },
        onAction: vi.fn(),
      }),
    );

    expect(markup).toContain(
      '<span class="app-update-version">Silvic 0.1.0</span><span class="app-update-label">Check updates</span>',
    );
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).not.toContain(">Up to date<");
  });

  it("keeps the failure reason accessible without adding another line", () => {
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
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain(">Release offline<");
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

    expect(markup).toContain('class="app-update-label">Install</span>');
    expect(markup).not.toContain("Check updates");
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
