import { describe, expect, it, vi } from "vitest";

import { createKeyLayers, keyIntent } from "./shortcuts";

const escape = { key: "Escape" };
const confirm = { key: "Enter", metaKey: true };

describe("keyIntent", () => {
  it("reads Escape and the accelerator with Enter", () => {
    expect(keyIntent(escape)).toBe("dismiss");
    expect(keyIntent(confirm)).toBe("confirm");
    expect(keyIntent({ key: "Enter", ctrlKey: true })).toBe("confirm");
  });

  it("leaves a bare Enter to the control that has focus", () => {
    expect(keyIntent({ key: "Enter" })).toBeUndefined();
  });

  it("ignores keys no layer claims", () => {
    expect(keyIntent({ key: "n", metaKey: true })).toBeUndefined();
    expect(keyIntent({ key: "a" })).toBeUndefined();
  });

  it("stays out of an input method's way", () => {
    expect(keyIntent({ key: "Enter", metaKey: true, isComposing: true })).toBe(
      undefined,
    );
    expect(keyIntent({ key: "Escape", isComposing: true })).toBeUndefined();
  });
});

describe("createKeyLayers", () => {
  it("asks nobody when nothing is open", () => {
    expect(createKeyLayers().handle(escape)).toBe(false);
  });

  it("dismisses the innermost layer, not the one behind it", () => {
    const layers = createKeyLayers();
    const dialog = vi.fn();
    const picker = vi.fn();
    layers.add({ dismiss: dialog });
    layers.add({ dismiss: picker });

    expect(layers.handle(escape)).toBe(true);
    expect(picker).toHaveBeenCalledOnce();
    expect(dialog).not.toHaveBeenCalled();
  });

  it("returns to the dialog once the picker inside it closes", () => {
    const layers = createKeyLayers();
    const dialog = vi.fn();
    layers.add({ dismiss: dialog });
    const closePicker = layers.add({ dismiss: vi.fn() });
    closePicker();

    layers.handle(escape);
    expect(dialog).toHaveBeenCalledOnce();
  });

  it("keeps a working dialog put instead of passing Escape behind it", () => {
    const layers = createKeyLayers();
    const behind = vi.fn();
    layers.add({ dismiss: behind });
    // Mid-teardown: the dialog offers neither key but still owns them.
    layers.add({});

    expect(layers.handle(escape)).toBe(true);
    expect(behind).not.toHaveBeenCalled();
  });

  it("runs the front layer's primary action on the accelerator", () => {
    const layers = createKeyLayers();
    const save = vi.fn();
    layers.add({ dismiss: vi.fn(), confirm: save });

    expect(layers.handle(confirm)).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("leaves unclaimed keys alone so the app can still use them", () => {
    const layers = createKeyLayers();
    layers.add({ dismiss: vi.fn() });

    expect(layers.handle({ key: "n", metaKey: true })).toBe(false);
  });
});
