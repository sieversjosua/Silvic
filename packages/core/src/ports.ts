import { createHash } from "node:crypto";

/** Avoids the privileged range below 1024 and the ephemeral range above 32767. */
const firstPort = 3_000;
const portCount = 6_000;

/**
 * The same plot always gets the same port. Stability is the point: a plot's URL
 * ends up registered with identity providers and pasted into browsers, so it
 * must survive restarts and rediscovery.
 *
 * `taken` lets a caller exclude ports already claimed by other plots or by
 * something else on the machine; the search then walks deterministically so the
 * result still only depends on the inputs.
 */
export function plotPort(
  project: string,
  plot: string,
  taken: ReadonlySet<number> = new Set(),
): number {
  const digest = createHash("sha256").update(`${project}/${plot}`).digest();
  const offset = digest.readUInt32BE(0) % portCount;
  for (let step = 0; step < portCount; step += 1) {
    const port = firstPort + ((offset + step) % portCount);
    if (!taken.has(port)) return port;
  }
  throw new Error("No free port remains in the plot range");
}

/** The address a plot answers on, given its port. */
export function plotUrl(port: number): string {
  return `http://localhost:${port}`;
}

/**
 * Where a plot's local WorkOS emulator listens: a fixed offset past the plot
 * range, so the two can never collide and the result stays below the ephemeral
 * range. Derived rather than allocated, for the same reason as `plotPort` —
 * the number ends up in the plot's environment file and has to survive
 * restarts and rediscovery.
 */
export function workosEmulatePort(plotPort: number): number {
  return plotPort + 20_000;
}
