import { useEffect, useRef, useState } from "react";

/** Enough of a keystroke to decide what it asks for. */
export type Chord = {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  /** An Enter or Escape that belongs to an input method, not to Silvic. */
  readonly isComposing?: boolean;
};

/**
 * ⌘ on macOS, Ctrl everywhere else. Silvic ships as a Mac app, but the same
 * interface runs in an ordinary browser while developing, and it should not
 * need a different set of keys in the head.
 */
export function accelerated(chord: Chord): boolean {
  return chord.metaKey === true || chord.ctrlKey === true;
}

/** What a keystroke asks the layer in front for. */
export function keyIntent(chord: Chord): "dismiss" | "confirm" | undefined {
  if (chord.isComposing) return undefined;
  if (chord.key === "Escape") return "dismiss";
  if (chord.key === "Enter" && accelerated(chord)) return "confirm";
  return undefined;
}

/**
 * The two things anything in front can be asked to do without the mouse.
 * `undefined` is a state rather than an omission: the layer is still there and
 * still owns the key, it just has nothing to do with it right now.
 */
export type KeyLayer = {
  /** Escape. Undefined while a run is in flight and must not be lost. */
  dismiss?: (() => void) | undefined;
  /** ⌘↵. Undefined whenever the primary button would be disabled. */
  confirm?: (() => void) | undefined;
};

/**
 * Escape means the closest thing on screen, not the biggest one: an issue
 * picker inside the new-plot dialog has to close before the dialog behind it
 * does, or a stray keystroke throws away everything already typed.
 *
 * Layers register as they open, and only the last one registered — the
 * innermost — is ever asked. Nothing falls through: a dialog that has
 * suppressed its own keys because it is working stays put rather than handing
 * Escape to whatever is behind it.
 */
export function createKeyLayers() {
  const stack: KeyLayer[] = [];
  return {
    add(layer: KeyLayer): () => void {
      stack.push(layer);
      return () => {
        const at = stack.lastIndexOf(layer);
        if (at !== -1) stack.splice(at, 1);
      };
    },
    /** Whether a layer claimed the keystroke, so the caller can stop it here. */
    handle(chord: Chord): boolean {
      const intent = keyIntent(chord);
      const front = stack.at(-1);
      if (!intent || !front) return false;
      front[intent]?.();
      return true;
    },
  };
}

const layers = createKeyLayers();

const onLayerKey = (event: KeyboardEvent) => {
  if (layers.handle(event)) event.preventDefault();
};

// One listener for every layer. Each of them calling `handle` would run the
// front layer once per open dialog.
let listening = 0;

function listen(): () => void {
  if (listening === 0) window.addEventListener("keydown", onLayerKey);
  listening += 1;
  return () => {
    listening -= 1;
    if (listening === 0) window.removeEventListener("keydown", onLayerKey);
  };
}

/**
 * Registers whatever is in front for Escape and ⌘↵, for as long as it has
 * something to do. Handlers are read at the moment the key is pressed, so a
 * dialog can pass fresh closures on every render without shuffling the order
 * layers opened in.
 */
export function useKeyLayer(keys: KeyLayer): void {
  const latest = useRef(keys);
  latest.current = keys;
  const [layer] = useState<KeyLayer>(() => ({
    dismiss: () => latest.current.dismiss?.(),
    confirm: () => latest.current.confirm?.(),
  }));
  const active = keys.dismiss !== undefined || keys.confirm !== undefined;

  useEffect(() => {
    if (!active) return;
    const remove = layers.add(layer);
    const stop = listen();
    return () => {
      remove();
      stop();
    };
  }, [active, layer]);
}

/**
 * A key that belongs to the whole app rather than to whatever is in front.
 * Pass `undefined` while the command does not apply — a dialog is open, or
 * there is no project to act in — so the keystroke keeps its ordinary meaning.
 */
export function useAccelerator(
  key: string,
  run: (() => void) | undefined,
): void {
  const latest = useRef(run);
  latest.current = run;
  const active = run !== undefined;

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== key) return;
      if (!accelerated(event) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      latest.current?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [key, active]);
}
