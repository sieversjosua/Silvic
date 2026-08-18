import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The daemon and the app resolve this independently — possibly under
 * different runtimes — so it must depend on nothing but the home directory.
 * Tests point SILVIC_GATE_STATE_DIR somewhere disposable.
 */
export function gateStateDirectory(): string {
  const override = process.env["SILVIC_GATE_STATE_DIR"];
  const directory =
    override && override.trim()
      ? override
      : join(homedir(), "Library", "Application Support", "silvic-gate");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function controlSocketPath(stateDirectory: string): string {
  return join(stateDirectory, "gate.sock");
}
