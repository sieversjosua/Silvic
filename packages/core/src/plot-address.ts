import { createHash } from "node:crypto";

import type { PlotCommand } from "@silvic/contracts";

import { plotUrl } from "./ports";

export interface PlotAddress {
  /** The origin written into local and provider environments. */
  url: string;
  /** Whether serving this address requires the local HTTPS router. */
  named: boolean;
}

export interface PlotAddressRequest {
  commands: Readonly<Record<string, PlotCommand>>;
  plot: string;
  project: string;
  port: number;
}

/** Serving commands are named by default; a recipe can explicitly opt out. */
export function routes(command: PlotCommand): boolean {
  return command.url === true && command.portless !== false;
}

/**
 * The shape work-cli established: `{command}-{plot}-{project}.localhost`.
 * Long plots are shortened in their variable segment only, preserving the
 * fixed command prefix and project suffix used by wildcard redirect patterns.
 */
export function routeNameFor(
  command: { id: string; routeName?: string | undefined },
  plot: string,
  project: string,
): string {
  const prefix = stableSegment(command.routeName ?? command.id, 12);
  const plotSegment = routeSegment(plot);
  const suffix = stableSegment(project, 24);
  const full = `${prefix}-${plotSegment}-${suffix}`;
  if (full.length <= 63) return full;

  const fingerprint = createHash("sha256")
    .update(plotSegment)
    .digest("hex")
    .slice(0, 8);
  const fixedLength = prefix.length + suffix.length + fingerprint.length + 3;
  const availablePlotLength = Math.max(1, 63 - fixedLength);
  const shortenedPlot =
    plotSegment.slice(0, availablePlotLength).replace(/-+$/g, "") || "plot";
  return `${prefix}-${shortenedPlot}-${fingerprint}-${suffix}`;
}

/** Resolve the browser/auth origin before provisioning or starting anything. */
export function resolvePlotAddress(request: PlotAddressRequest): PlotAddress {
  const serving =
    request.commands["web"]?.url === true
      ? (["web", request.commands["web"]] as const)
      : Object.entries(request.commands).find(
          ([, command]) => command.url === true,
        );
  if (!serving || !routes(serving[1])) {
    return { url: plotUrl(request.port), named: false };
  }
  return {
    url: `https://${routeNameFor(
      {
        id: serving[0],
        ...(serving[1].routeName ? { routeName: serving[1].routeName } : {}),
      },
      request.plot,
      request.project,
    )}.localhost`,
    named: true,
  };
}

function routeSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "plot"
  );
}

function stableSegment(value: string, maximum: number): string {
  const segment = routeSegment(value);
  if (segment.length <= maximum) return segment;
  const fingerprint = createHash("sha256")
    .update(segment)
    .digest("hex")
    .slice(0, 8);
  return `${segment.slice(0, maximum - 9).replace(/-+$/g, "")}-${fingerprint}`;
}
