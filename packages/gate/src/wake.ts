import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type {
  GateWakeResult,
  GateWakeStatus,
  WakeEvent,
} from "./control-protocol";
import type { GateRoute } from "./route-store";

/**
 * A holding page polls every second; the plot takes tens of seconds to rise.
 * Debouncing per route keeps that polling from stampeding the app, and from
 * relaunching it while the person is busy quitting it.
 */
export class Waker {
  private readonly attempts = new Map<
    string,
    { requestId: string; failures: number; status: GateWakeStatus }
  >();

  constructor(
    private readonly options: {
      broadcast(event: WakeEvent): boolean;
      log(message: string): void;
      debounceMs?: number;
      launchApp?(routeName: string, requestId: string): void;
      now?(): number;
    },
  ) {}

  status(route: string): GateWakeStatus | undefined {
    const attempt = this.attempts.get(route);
    if (
      attempt?.status.outcome === "starting" &&
      this.now() >= attempt.status.retryAt
    ) {
      this.result(route, attempt.requestId, {
        outcome: "failed",
        message:
          "Silvic did not report a wake result. Open Silvic and check this plot.",
      });
      attempt.status.outcome = "no-response";
    }
    return attempt?.status;
  }

  result(route: string, requestId: string, result: GateWakeResult): void {
    const attempt = this.attempts.get(route);
    if (
      !attempt ||
      attempt.requestId !== requestId ||
      !["starting", "no-response"].includes(attempt.status.outcome)
    )
      return;
    const success =
      result.outcome === "started" || result.outcome === "already-running";
    attempt.failures = success
      ? 0
      : attempt.failures + (attempt.status.outcome === "no-response" ? 0 : 1);
    const pause = success
      ? (this.options.debounceMs ?? 30_000)
      : result.outcome === "plot-missing" || result.outcome === "not-owned"
        ? 30 * 60_000
        : Math.min(30_000 * 2 ** Math.min(attempt.failures - 1, 4), 5 * 60_000);
    attempt.status = {
      ...result,
      message: result.message.slice(0, 1500),
      retryAt: this.now() + pause,
    };
    this.options.log(
      `wake result ${route} ${requestId}: ${result.outcome}: ${result.message.replace(/[\r\n]/g, " ").slice(0, 1500)}`,
    );
  }

  retry(route: GateRoute): void {
    this.attempts.delete(route.name);
    this.wake(route);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  wake(route: GateRoute): void {
    const status = this.status(route.name);
    if (status && this.now() < status.retryAt) return;
    const requestId = randomUUID();
    const failures = this.attempts.get(route.name)?.failures ?? 0;
    if (this.attempts.size >= 1024) {
      const oldest = this.attempts.keys().next().value;
      if (oldest) this.attempts.delete(oldest);
    }
    this.attempts.set(route.name, {
      requestId,
      failures,
      status: {
        outcome: "starting",
        message: "Silvic is starting this environment.",
        retryAt: this.now() + 60_000,
      },
    });
    const event: WakeEvent = {
      type: "wake",
      route: route.name,
      requestId,
      ...(route.plotPath ? { plotPath: route.plotPath } : {}),
      ...(route.commandId ? { commandId: route.commandId } : {}),
    };
    if (this.options.broadcast(event)) {
      this.options.log(`wake ${route.name} ${requestId}: sent to the app`);
      return;
    }
    this.options.log(`wake ${route.name} ${requestId}: launching Silvic`);
    (this.options.launchApp ?? launchSilvic)(route.name, requestId);
  }
}

function launchSilvic(routeName: string, requestId: string): void {
  const child = spawn(
    "open",
    [
      "-b",
      "dev.silvic.app",
      "--args",
      `--silvic-wake=${routeName}`,
      `--silvic-wake-request=${requestId}`,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.once("error", () => undefined);
  child.unref();
}
