import { createHash } from "node:crypto";

import type { PlotResourceDefinition } from "@silvic/contracts";

/**
 * Side ports deliberately avoid the stable Plot range (3000-8999), the
 * derived WorkOS range (23000-28999), and macOS' ephemeral range (49152+).
 */
const sidePortRanges = [
  [9_000, 22_999],
  [30_000, 49_151],
] as const;

const sidePortCount = sidePortRanges.reduce(
  (total, [first, last]) => total + last - first + 1,
  0,
);

export interface RuntimePortReservation {
  port: number;
  inspectorPort: number;
}

/**
 * Deterministically reserves a port from Silvic's side-port ranges. Mutating
 * the caller-owned set makes several starts in the same event-loop turn
 * atomic: later starts see the reservation before either child has bound it.
 */
export function reserveRuntimeSidePort(
  identity: string,
  taken: Set<number>,
): number {
  const digest = createHash("sha256").update(identity).digest();
  const offset = digest.readUInt32BE(0) % sidePortCount;
  for (let step = 0; step < sidePortCount; step += 1) {
    const port = sidePortAt((offset + step) % sidePortCount);
    if (taken.has(port)) continue;
    taken.add(port);
    return port;
  }
  throw new Error("No free port remains in the runtime side-port ranges");
}

export function runtimeIsolationEnvironment({
  project,
  plot,
  attemptId,
  commandId,
  port,
  inspectorPort,
  resources,
  nodeOptions,
}: {
  project: string;
  plot: string;
  attemptId: string;
  commandId: string;
  port: number;
  inspectorPort: number;
  resources: Readonly<Record<string, PlotResourceDefinition>>;
  nodeOptions?: string;
}): Record<string, string> {
  const attached = Object.entries(resources)
    .filter(([, resource]) => resource.command === commandId)
    .sort(([left], [right]) => left.localeCompare(right));
  const environment: Record<string, string> = {
    SILVIC_ATTEMPT_ID: attemptId,
    SILVIC_RUNTIME_ID: commandId,
    PORT: String(port),
    SILVIC_RUNTIME_PORT: String(port),
    SILVIC_INSPECTOR_PORT: String(inspectorPort),
    // Node honours this whenever a command enables its inspector. Project
    // plugins with their own inspector must consume SILVIC_INSPECTOR_PORT.
    NODE_OPTIONS: withInspectorPort(nodeOptions, inspectorPort),
  };

  for (const [resourceId, resource] of attached) {
    const identity = runtimeResourceIdentity({
      project,
      plot,
      attemptId,
      resourceId,
    });
    environment[resourceIdentityVariable(resourceId)] = identity;
    if (resource.kind === "agent" || resource.provider === "livekit") {
      environment["SILVIC_AGENT_NAME"] = identity;
    }
    if (resource.provider === "livekit") {
      // This is a public runtime identity, never a credential. It deliberately
      // wins over inherited and recipe command environments in the supervisor.
      environment["LIVEKIT_AGENT_NAME"] = identity;
    }
  }
  return environment;
}

/** Stable, human-readable and collision-resistant across Workspace attempts. */
export function runtimeResourceIdentity({
  project,
  plot,
  attemptId,
  resourceId,
}: {
  project: string;
  plot: string;
  attemptId: string;
  resourceId: string;
}): string {
  const readable = slug(`${project}-${plot}-${resourceId}`);
  const fingerprint = createHash("sha256")
    .update(`${attemptId}/${resourceId}`)
    .digest("hex")
    .slice(0, 10);
  const prefix = readable.slice(0, 52).replace(/-+$/g, "") || "runtime";
  return `${prefix}-${fingerprint}`;
}

function resourceIdentityVariable(resourceId: string): string {
  const segment = resourceId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `SILVIC_RESOURCE_${segment || "RESOURCE"}_IDENTITY`;
}

function withInspectorPort(
  nodeOptions: string | undefined,
  inspectorPort: number,
): string {
  const withoutPort = (nodeOptions ?? "")
    .replace(/(?:^|\s)--inspect-port(?:=|\s+)\S+/g, " ")
    .trim();
  return [withoutPort, `--inspect-port=${inspectorPort}`]
    .filter(Boolean)
    .join(" ");
}

function sidePortAt(index: number): number {
  let remaining = index;
  for (const [first, last] of sidePortRanges) {
    const length = last - first + 1;
    if (remaining < length) return first + remaining;
    remaining -= length;
  }
  throw new Error("Side-port index is outside the configured ranges");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "runtime"
  );
}
