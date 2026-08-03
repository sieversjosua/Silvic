import { describe, expect, it, vi } from "vitest";

import { PlotMenuTrigger } from "./Grove";

describe("PlotMenuTrigger", () => {
  it("stays independently visible and toggles the card menu", () => {
    const onToggle = vi.fn();
    const trigger = PlotMenuTrigger({
      workspaceName: "auth-callback",
      expanded: false,
      buttonRef: { current: null },
      onToggle,
    });
    const props = trigger.props as {
      className: string;
      "aria-label": string;
      "aria-haspopup": string;
      "aria-expanded": boolean;
      onClick(event: { stopPropagation(): void }): void;
    };
    const stopPropagation = vi.fn();

    expect(props.className).toBe("plot-menu-trigger");
    expect(props["aria-label"]).toBe("Actions for auth-callback");
    expect(props["aria-haspopup"]).toBe("menu");
    expect(props["aria-expanded"]).toBe(false);

    props.onClick({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("exposes the open state without relying on hover or selection", () => {
    const trigger = PlotMenuTrigger({
      workspaceName: "payments",
      expanded: true,
      buttonRef: { current: null },
      onToggle: () => undefined,
    });

    expect(trigger.props["aria-expanded"]).toBe(true);
  });
});
