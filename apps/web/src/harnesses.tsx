import { Pin } from "lucide-react";

import type { HarnessId } from "@silvic/contracts";

import { HarnessMark } from "./providers";

const harnessMenu = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["t3-code", "T3 Code"],
  ["opencode", "OpenCode"],
  ["vscode", "VS Code"],
  ["terminal", "Terminal"],
  ["finder", "Finder"],
] as const;

export function harnessLabel(id: string): string {
  return harnessMenu.find(([candidate]) => candidate === id)?.[1] ?? id;
}

/**
 * Every harness row can be made the default for the Open button. The control
 * sits on the left so the current default is scannable down the menu's edge,
 * and it stays visible only for the one that is set.
 */
export function HarnessRows({
  defaultHarness,
  onOpen,
  onSetDefault,
}: {
  defaultHarness: HarnessId;
  onOpen(id: HarnessId): void;
  onSetDefault(id: HarnessId): void;
}) {
  return (
    <>
      {harnessMenu.map(([id, label]) => (
        <div
          className="harness-row"
          key={id}
          data-default={id === defaultHarness || undefined}
        >
          <button
            type="button"
            className="harness-default"
            aria-label={`Open with ${label} by default`}
            title="Make this the default"
            aria-pressed={id === defaultHarness}
            onClick={(event) => {
              event.stopPropagation();
              onSetDefault(id);
            }}
          >
            <Pin size={11} />
          </button>
          <button
            type="button"
            role="menuitem"
            className="harness-open"
            onClick={() => onOpen(id)}
          >
            <HarnessMark id={id} />
            {label}
          </button>
        </div>
      ))}
    </>
  );
}
