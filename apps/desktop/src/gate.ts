/**
 * The Silvic gate daemon entry. launchd runs this file with the installed
 * app's binary as a plain Node runtime (ELECTRON_RUN_AS_NODE=1), so it must
 * not touch Electron. It is bundled self-contained and unpacked from the
 * asar; see docs/GATE.md.
 */
import { startGate } from "@silvic/gate";

/** Baked in at build time; the app compares it to restart stale daemons. */
declare const __SILVIC_GATE_VERSION__: string;

const gate = await startGate({
  version:
    typeof __SILVIC_GATE_VERSION__ === "string"
      ? __SILVIC_GATE_VERSION__
      : "dev",
});

const finish = async (): Promise<void> => {
  await gate.close();
  process.exit(0);
};
process.on("SIGTERM", () => void finish());
process.on("SIGINT", () => void finish());
