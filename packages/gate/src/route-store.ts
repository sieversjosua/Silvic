import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GateRoute {
  /** The single DNS label under .localhost, `web-checkout-flow-shop`. */
  name: string;
  /** Loopback family the upstream answered on. */
  host?: "127.0.0.1" | "::1";
  /** Where the dev server currently listens. Absent while it is down. */
  port?: number;
  /** The plot that owns this route, for waking it. */
  plotPath?: string;
  /** The recipe command that serves it, `web`. */
  commandId?: string;
  updatedAt: string;
}

/**
 * The durable half of a route is its identity — name, plot, command. The
 * upstream port is weather: dev servers move on every restart, so a stale
 * port is expected and only means "wake the plot and wait for a fresh one".
 */
export class RouteStore {
  private readonly routes = new Map<string, GateRoute>();
  private readonly file: string;

  constructor(
    stateDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(stateDirectory, "routes.json");
    for (const route of readRoutes(this.file)) {
      this.routes.set(route.name, route);
    }
  }

  list(): readonly GateRoute[] {
    return [...this.routes.values()];
  }

  find(name: string): GateRoute | undefined {
    return this.routes.get(name);
  }

  set(route: Omit<GateRoute, "updatedAt">): GateRoute {
    // One route per plot command: when a plot's name derivation improves,
    // the freshly published name replaces the stale one instead of leaving
    // a second URL that fights over the same upstream.
    if (route.plotPath && route.commandId) {
      for (const existing of this.routes.values()) {
        if (
          existing.name !== route.name &&
          existing.plotPath === route.plotPath &&
          existing.commandId === route.commandId
        ) {
          this.routes.delete(existing.name);
        }
      }
    }
    const previous = this.routes.get(route.name);
    const next: GateRoute = {
      ...previous,
      ...route,
      updatedAt: this.now().toISOString(),
    };
    this.routes.set(route.name, next);
    this.persist();
    return next;
  }

  /** The upstream vanished but the route identity should keep waking it. */
  clearUpstream(name: string): void {
    const route = this.routes.get(name);
    if (!route || route.port === undefined) return;
    const { port: _gone, host: _family, ...identity } = route;
    this.routes.set(name, {
      ...identity,
      updatedAt: this.now().toISOString(),
    });
    this.persist();
  }

  remove(name: string): void {
    if (!this.routes.delete(name)) return;
    this.persist();
  }

  private persist(): void {
    const draft = `${this.file}.tmp`;
    writeFileSync(draft, `${JSON.stringify(this.list(), undefined, 2)}\n`);
    renameSync(draft, this.file);
  }
}

function readRoutes(file: string): readonly GateRoute[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRoute);
  } catch {
    // A torn write must not brick the daemon; routes re-register on start.
    return [];
  }
}

function isRoute(value: unknown): value is GateRoute {
  if (typeof value !== "object" || value === null) return false;
  const route = value as Record<string, unknown>;
  return (
    typeof route["name"] === "string" &&
    /^[a-z0-9-]{1,63}$/.test(route["name"]) &&
    (route["port"] === undefined ||
      (typeof route["port"] === "number" &&
        Number.isSafeInteger(route["port"]) &&
        route["port"] > 0 &&
        route["port"] <= 65_535)) &&
    (route["host"] === undefined ||
      route["host"] === "127.0.0.1" ||
      route["host"] === "::1") &&
    (route["plotPath"] === undefined ||
      typeof route["plotPath"] === "string") &&
    (route["commandId"] === undefined ||
      typeof route["commandId"] === "string") &&
    typeof route["updatedAt"] === "string"
  );
}
