/**
 * The Silvic gate daemon entry. launchd runs this file with the installed
 * app's binary as a plain Node runtime (ELECTRON_RUN_AS_NODE=1), so it must
 * not touch Electron. It is bundled self-contained and unpacked from the
 * asar; see docs/GATE.md.
 */
import { startGate } from "@silvic/gate";

const gate = await startGate({
  version: process.env["SILVIC_GATE_VERSION"] ?? "bundled",
});

const finish = async (): Promise<void> => {
  await gate.close();
  process.exit(0);
};
process.on("SIGTERM", () => void finish());
process.on("SIGINT", () => void finish());
