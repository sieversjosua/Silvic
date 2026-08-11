import { describe, expect, it } from "vitest";

import {
  updateMenuPresentation,
  updateMenuPresentations,
} from "./application-menu";

describe("updateMenuPresentations", () => {
  it("keeps Check for Updates visible when an update is available", () => {
    expect(
      updateMenuPresentations({
        phase: "available",
        currentVersion: "0.1.5",
        availableVersion: "0.1.6",
      }),
    ).toEqual([
      { label: "Check for Updates…", enabled: false },
      {
        label: "Download Update 0.1.6…",
        enabled: true,
        action: "download",
      },
    ]);
  });
});

describe("updateMenuPresentation", () => {
  it.each([
    [
      { phase: "relocation-required", currentVersion: "0.1.5" },
      { label: "Move Silvic to Applications…", action: "relocate" },
    ],
    [
      { phase: "idle", currentVersion: "0.1.5" },
      { label: "Check for Updates…", action: "check" },
    ],
    [
      {
        phase: "available",
        currentVersion: "0.1.5",
        availableVersion: "0.1.6",
      },
      { label: "Download Update 0.1.6…", action: "download" },
    ],
    [
      {
        phase: "ready",
        currentVersion: "0.1.5",
        availableVersion: "0.1.6",
      },
      { label: "Restart to Install Update", action: "install" },
    ],
    [
      {
        phase: "installing",
        currentVersion: "0.1.5",
        availableVersion: "0.1.6",
      },
      { label: "Installing Update…" },
    ],
    [
      { phase: "unsupported", currentVersion: "0.1.5" },
      { label: "Check for Updates…" },
    ],
  ] as const)(
    "maps update state %# into a native menu item",
    (state, expected) => {
      expect(updateMenuPresentation(state as never)).toEqual({
        ...expected,
        enabled: "action" in expected,
      });
    },
  );
});
