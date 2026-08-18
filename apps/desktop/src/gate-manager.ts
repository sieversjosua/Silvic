import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
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
  installUserTrust,
  type GateDiagnosis,
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
  private check:
    { checkedAt: number; result: Promise<GateDiagnosis> } | undefined;

  async available(): Promise<boolean> {
    return (await this.issue()) === undefined;
  }

  /** What still stands between this machine and working named HTTPS URLs. */
  async issue(): Promise<string | undefined> {
    const diagnosis = await this.diagnose();
    return diagnosis.healthy
      ? undefined
      : diagnosis.failures.map((failure) => failure.advice).join(" ");
  }

  private diagnose(): Promise<GateDiagnosis> {
    if (this.check && Date.now() - this.check.checkedAt < 1_500) {
      return this.check.result;
    }
    const result = diagnoseGate({
      socketStatus: async () => (await this.client.status()) !== undefined,
      probe: (url) => this.probeThroughGate(url),
    });
    this.check = { checkedAt: Date.now(), result };
    return result;
  }

  /**
   * Both halves of the install, in the order that needs the fewest prompts:
   * the LaunchAgent first (no privileges; the daemon mints its CA on first
   * start), then the pf redirect and CA trust behind one admin dialog.
   * Explicitly requested, so it always prompts again.
   */
  async setup(): Promise<void> {
    await this.ensureAgent();
    this.privilegedAttempted = true;
    this.trustAttempted = true;
    await installPrivileged();
    await installUserTrust();
    this.forget();
  }

  /**
   * The silent half only: get a daemon running, whatever it takes. The
   * LaunchAgent is the preferred home (it survives logouts), but macOS can
   * quietly refuse to start new background items on managed machines — so
   * when launchd does not deliver, the gate is spawned directly from this
   * app instead of becoming a hard dependency. Every step is written to
   * gate-setup.log, because a silent failure here once cost a day.
   */
  async ensureAgent(): Promise<void> {
    if (await this.client.status()) return;
    this.note("gate unreachable; installing the launch agent");
    try {
      await installLaunchAgent(gateRuntime());
    } catch (error) {
      this.note(`launch agent install failed: ${describe(error)}`);
    }
    if (await this.pollDaemon(5_000)) {
      this.note("gate came up via the launch agent");
      this.forget();
      return;
    }
    if (!this.fallbackSpawned) {
      this.fallbackSpawned = true;
      this.note("launch agent did not come up; spawning the gate directly");
      const runtime = gateRuntime();
      const child = spawn(runtime.nodeExecutable, [runtime.gateScript], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => undefined);
      child.unref();
    }
    if (await this.pollDaemon(10_000)) {
      this.note("gate came up via direct spawn");
      this.forget();
      return;
    }
    this.note("gate did not come up at all");
    throw new Error(
      `The Silvic gate service did not start. macOS may be blocking Silvic's background item — check System Settings → General → Login Items & Extensions, then press Start again.${this.gateLogTail()}`,
    );
  }

  private privilegedAttempted = false;
  private trustAttempted = false;
  private fallbackSpawned = false;
  private ensureInFlight: Promise<void> | undefined;

  /**
   * Makes the gate ready without being asked, escalating only as far as
   * needed: the silent agent install first, the administrator dialog only
   * when 443 or certificate trust is still missing. Called from
   * user-initiated paths (Start, plot creation, a URL wake), so a password
   * prompt appearing here is the person's own action. `reprompt` marks an
   * explicit click, which may show the dialog again; background paths ask
   * at most once per app run.
   */
  ensureReady({
    reprompt = false,
  }: { reprompt?: boolean } = {}): Promise<void> {
    if (reprompt) {
      this.privilegedAttempted = false;
      this.trustAttempted = false;
    }
    this.ensureInFlight ??= this.escalate().finally(() => {
      this.ensureInFlight = undefined;
    });
    return this.ensureInFlight;
  }

  private async escalate(): Promise<void> {
    if ((await this.diagnose()).healthy) return;
    await this.ensureAgent();
    const diagnosis = await this.diagnose();
    if (diagnosis.healthy) return;
    const failing = new Set(diagnosis.failures.map((failure) => failure.check));
    // Only the dialogs the diagnosis actually calls for: the administrator
    // prompt when 443 does not reach the gate, the trust prompt when the
    // certificate is not accepted yet.
    if (failing.has("proxy-443") && !this.privilegedAttempted) {
      this.privilegedAttempted = true;
      this.note("requesting the one-time administrator setup");
      try {
        await installPrivileged();
      } catch (error) {
        this.note(`administrator setup failed: ${describe(error)}`);
        throw new Error(
          `The one-time HTTPS setup was not completed: ${describe(error)}. Press Start to try again.`,
        );
      }
      this.note("administrator setup completed");
      this.forget();
    }
    if (failing.has("certificate-trusted") && !this.trustAttempted) {
      this.trustAttempted = true;
      this.note("requesting certificate trust");
      try {
        await installUserTrust();
      } catch (error) {
        this.note(`certificate trust failed: ${describe(error)}`);
        throw new Error(
          `The HTTPS certificate was not trusted: ${describe(error)}. Press Start to try again.`,
        );
      }
      this.note("certificate trusted");
      this.forget();
    }
  }

  private forget(): void {
    this.check = undefined;
  }

  async removeRoute(name: string): Promise<void> {
    try {
      await this.client.routeRemove(name);
    } catch {
      // A dead gate has nothing to forget.
    }
  }

  private async pollDaemon(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.client.status()) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /** Setup breadcrumbs beside the app's other logs; grep-able after the fact. */
  private note(step: string): void {
    try {
      appendFileSync(
        join(app.getPath("userData"), "gate-setup.log"),
        `${new Date().toISOString()} ${step}\n`,
      );
    } catch {
      // Diagnostics must never break the setup they describe.
    }
  }

  private gateLogTail(): string {
    try {
      const tail = readFileSync(join(gateStateDirectory(), "gate.log"), "utf8")
        .trimEnd()
        .split("\n")
        .slice(-3)
        .join(" · ");
      return tail ? ` Gate log: ${tail}` : "";
    } catch {
      return "";
    }
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
