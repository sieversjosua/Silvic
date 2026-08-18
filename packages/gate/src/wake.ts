import { spawn } from "node:child_process";

import type { WakeEvent } from "./control-protocol";
import type { GateRoute } from "./route-store";

/**
 * A holding page polls every second; the plot takes tens of seconds to rise.
 * Debouncing per route keeps that polling from stampeding the app, and from
 * relaunching it while the person is busy quitting it.
 */
export class Waker {
  private readonly lastWake = new Map<string, number>();

  constructor(
    private readonly options: {
      broadcast(event: WakeEvent): boolean;
      log(message: string): void;
      debounceMs?: number;
      launchApp?(routeName: string): void;
      now?(): number;
    },
  ) {}

  wake(route: GateRoute): void {
    const now = (this.options.now ?? Date.now)();
    const last = this.lastWake.get(route.name) ?? 0;
    if (now - last < (this.options.debounceMs ?? 30_000)) return;
    this.lastWake.set(route.name, now);

    const event: WakeEvent = {
      type: "wake",
      route: route.name,
      ...(route.plotPath ? { plotPath: route.plotPath } : {}),
      ...(route.commandId ? { commandId: route.commandId } : {}),
    };
    if (this.options.broadcast(event)) {
      this.options.log(`wake ${route.name}: sent to the app`);
      return;
    }
    this.options.log(`wake ${route.name}: launching Silvic`);
    (this.options.launchApp ?? launchSilvic)(route.name);
  }
}

function launchSilvic(routeName: string): void {
  const child = spawn(
    "open",
    ["-b", "dev.silvic.app", "--args", `--silvic-wake=${routeName}`],
    { detached: true, stdio: "ignore" },
  );
  child.once("error", () => undefined);
  child.unref();
}
