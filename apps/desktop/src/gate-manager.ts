import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";

import { GateRoutePublisher, type GateRouteLink } from "@silvic/core";
import {
  GATE_HOST,
  GateClient,
  diagnoseGate,
  gateStateDirectory,
  installLaunchAgent,
  installPrivileged,
  type GateWake,
} from "@silvic/gate";

/**
 * The app's half of the Silvic gate: it publishes routes the supervisor
 * discovers, answers "is local HTTPS ready?" for the UI, runs the one-time
 * setup, and receives wake events when someone visits a sleeping plot's URL.
 */
export class GateManager {
  readonly client: GateClient;
  readonly publisher: GateRoutePublisher;

  constructor(onWake: (wake: GateWake) => void) {
    this.client = new GateClient({ onWake });
    const link: GateRouteLink = {
      set: (route) => this.client.routeSet(route),
      suspend: (name) => this.client.routeSuspend(name),
    };
    this.publisher = new GateRoutePublisher({ link });
  }

  /** Short-lived because the one-time setup may finish while Silvic is open. */
  private check: { checkedAt: number; result: Promise<string | undefined> } = {
    checkedAt: 0,
    result: Promise.resolve(undefined),
  };

  async available(): Promise<boolean> {
    return (await this.issue()) === undefined;
  }

  /** What still stands between this machine and working named HTTPS URLs. */
  issue(): Promise<string | undefined> {
    if (Date.now() - this.check.checkedAt < 1_500) return this.check.result;
    const result = diagnoseGate({
      socketStatus: async () => (await this.client.status()) !== undefined,
      probe: (url) => this.probeThroughGate(url),
    }).then((diagnosis) =>
      diagnosis.healthy
        ? undefined
        : diagnosis.failures.map((failure) => failure.advice).join(" "),
    );
    this.check = { checkedAt: Date.now(), result };
    return result;
  }

  /**
   * Both halves of the install, in the order that needs the fewest prompts:
   * the LaunchAgent first (no privileges; the daemon mints its CA on first
   * start), then the pf redirect and CA trust behind one admin dialog.
   */
  async setup(): Promise<void> {
    await installLaunchAgent(gateRuntime());
    await this.awaitDaemon(15_000);
    await installPrivileged();
    this.check = { checkedAt: 0, result: Promise.resolve(undefined) };
  }

  async removeRoute(name: string): Promise<void> {
    try {
      await this.client.routeRemove(name);
    } catch {
      // A dead gate has nothing to forget.
    }
  }

  private async awaitDaemon(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.client.status()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "The Silvic gate service did not come up. Check that Silvic is allowed to run login items, then try again.",
    );
  }

  /**
   * Dialled at the loopback directly: the probe must prove the pf redirect
   * and the gate, not macOS name resolution. TLS is verified against the
   * gate's own CA — reachability and trust are separate diagnoses.
   */
  private probeThroughGate(url: string): Promise<boolean> {
    const target = new URL(url);
    let authority: Buffer;
    try {
      authority = readFileSync(join(gateStateDirectory(), "ca", "ca.pem"));
    } catch {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port: 443,
          servername: target.hostname,
          ca: authority,
          headers: { host: target.hostname, connection: "close" },
          path: "/",
          method: "GET",
        },
        (response) => {
          response.resume();
          resolve(
            response.statusCode !== undefined && response.statusCode < 500,
          );
        },
      );
      request.setTimeout(2_000, () => request.destroy());
      request.once("error", () => resolve(false));
      request.end();
    });
  }
}

/** Where launchd finds a Node runtime and the gate script, dev and packaged. */
function gateRuntime(): { nodeExecutable: string; gateScript: string } {
  return {
    nodeExecutable: process.execPath,
    gateScript: app.isPackaged
      ? join(
          process.resourcesPath,
          "app.asar.unpacked",
          "out",
          "main",
          "gate.mjs",
        )
      : join(app.getAppPath(), "out", "main", "gate.mjs"),
  };
}

export { GATE_HOST };
export type { GateWake };
