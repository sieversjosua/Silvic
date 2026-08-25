import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Must stay independent from Electron so shell clients resolve the same path. */
export function automationStateDirectory(): string {
  const override = process.env["SILVIC_AUTOMATION_DIR"];
  if (override) return override;
  return platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Silvic")
    : join(homedir(), ".config", "Silvic");
}

export function automationSocketPath(
  stateDirectory = automationStateDirectory(),
): string {
  return join(stateDirectory, "automation.sock");
}
