// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PlotProcess } from "@silvic/contracts";

import { managedActivePlots, StopAllPlotsButton } from "./StopAllPlotsButton";

const process = (
  plotPath: string,
  status: PlotProcess["status"] = "running",
  ownership?: PlotProcess["ownership"],
): PlotProcess => ({
  plotPath,
  id: "web",
  status,
  ...(ownership ? { ownership } : {}),
});

describe("StopAllPlotsButton", () => {
  it("counts active managed plots once and ignores external runtimes", () => {
    expect(
      managedActivePlots([
        process("/plots/one"),
        { ...process("/plots/one"), id: "worker" },
        process("/plots/two", "starting"),
        process("/plots/three", "stopped"),
        process("/plots/external", "running", "external"),
      ]),
    ).toBe(2);
  });

  it("is always present but disabled when no plot is active", () => {
    const markup = renderToStaticMarkup(
      createElement(StopAllPlotsButton, {
        processes: [],
        onFailure: vi.fn(),
      }),
    );

    expect(markup).toContain("Stop all plots");
    expect(markup).toContain("disabled");
  });

  it("stops every plot through the app-level command", async () => {
    const stopAllPlotCommands = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "silvic", {
      configurable: true,
      value: { stopAllPlotCommands },
    });
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(StopAllPlotsButton, {
          processes: [process("/plots/one"), process("/plots/two")],
          onFailure: vi.fn(),
        }),
      );
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
    });

    expect(stopAllPlotCommands).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Stopping all plots…");
    expect(container.querySelector("button")?.disabled).toBe(true);

    act(() => root.unmount());
  });

  it("reflects an already-running global stop", () => {
    const markup = renderToStaticMarkup(
      createElement(StopAllPlotsButton, {
        processes: [process("/plots/one", "stopping")],
        onFailure: vi.fn(),
      }),
    );

    expect(markup).toContain("Stopping all plots…");
    expect(markup).toContain('aria-label="All plots are stopping"');
    expect(markup).toContain("disabled");
  });
});
