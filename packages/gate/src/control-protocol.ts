import type { GateRoute } from "./route-store";

/** One JSON object per line, in both directions. */
export type ControlRequest =
  | { id: number; type: "status" }
  | {
      id: number;
      type: "route-set";
      name: string;
      host: "127.0.0.1" | "::1";
      port: number;
      plotPath?: string;
      commandId?: string;
    }
  /** The upstream stopped; keep the identity so the URL can wake it. */
  | { id: number; type: "route-suspend"; name: string }
  /** The plot is gone; forget the route entirely. */
  | { id: number; type: "route-remove"; name: string };

export type ControlReply =
  | { id: number; type: "ok" }
  | { id: number; type: "error"; message: string }
  | {
      id: number;
      type: "status";
      version: string;
      routes: readonly GateRoute[];
    };

/** Pushed to every connected client, without a request. */
export interface WakeEvent {
  type: "wake";
  route: string;
  plotPath?: string;
  commandId?: string;
}

/** A routed response the app's supervisor can safely repair. */
export interface RouteFailureEvent {
  type: "route-failure";
  route: string;
  plotPath?: string;
  commandId?: string;
  failure: "vite-stale-optimized-dependency";
}

export type GateEvent = WakeEvent | RouteFailureEvent;

export function parseControlRequest(line: string): ControlRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const message = parsed as Record<string, unknown>;
  if (typeof message["id"] !== "number") return undefined;
  const name = message["name"];
  switch (message["type"]) {
    case "status":
      return { id: message["id"], type: "status" };
    case "route-set": {
      if (typeof name !== "string" || !validRouteName(name)) return undefined;
      const port = message["port"];
      const host = message["host"];
      if (
        typeof port !== "number" ||
        !Number.isSafeInteger(port) ||
        port <= 0 ||
        port > 65_535 ||
        (host !== "127.0.0.1" && host !== "::1")
      ) {
        return undefined;
      }
      return {
        id: message["id"],
        type: "route-set",
        name,
        host,
        port,
        ...(typeof message["plotPath"] === "string"
          ? { plotPath: message["plotPath"] }
          : {}),
        ...(typeof message["commandId"] === "string"
          ? { commandId: message["commandId"] }
          : {}),
      };
    }
    case "route-suspend":
    case "route-remove":
      if (typeof name !== "string" || !validRouteName(name)) return undefined;
      return { id: message["id"], type: message["type"], name };
    default:
      return undefined;
  }
}

export function validRouteName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}
