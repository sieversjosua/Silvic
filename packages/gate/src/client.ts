import { connect, type Socket } from "node:net";

import type {
  ControlReply,
  ControlRequest,
  WakeEvent,
} from "./control-protocol";
import type { GateRoute } from "./route-store";
import { controlSocketPath, gateStateDirectory } from "./state-dir";

export interface GateStatus {
  version: string;
  routes: readonly GateRoute[];
}

export interface GateWake {
  route: string;
  plotPath?: string;
  commandId?: string;
}

/** Omit distributed over the request union, so each variant keeps its shape. */
type ControlRequestBody = ControlRequest extends infer Request
  ? Request extends ControlRequest
    ? Omit<Request, "id">
    : never
  : never;

/**
 * The app side of the control socket. One connection is kept open so wake
 * events can arrive; requests reconnect on demand when the daemon restarted
 * underneath us (an app update replaces the daemon file and launchd restarts
 * it).
 */
export class GateClient {
  private socket: Socket | undefined;
  private buffered = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(reply: ControlReply): void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly options: {
      socketPath?: string;
      onWake?(wake: GateWake): void;
      timeoutMs?: number;
    } = {},
  ) {}

  private get socketPath(): string {
    return this.options.socketPath ?? controlSocketPath(gateStateDirectory());
  }

  async status(): Promise<GateStatus | undefined> {
    try {
      const reply = await this.request({ type: "status" });
      return reply.type === "status"
        ? { version: reply.version, routes: reply.routes }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async routeSet(route: {
    name: string;
    host: "127.0.0.1" | "::1";
    port: number;
    plotPath?: string;
    commandId?: string;
  }): Promise<void> {
    const reply = await this.request({ type: "route-set", ...route });
    if (reply.type === "error") throw new Error(reply.message);
  }

  async routeSuspend(name: string): Promise<void> {
    await this.request({ type: "route-suspend", name });
  }

  async routeRemove(name: string): Promise<void> {
    await this.request({ type: "route-remove", name });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, type: "error", message: "Gate connection closed" });
    }
    this.pending.clear();
  }

  private async request(body: ControlRequestBody): Promise<ControlReply> {
    const socket = await this.connected();
    const id = this.nextId++;
    const message = { id, ...body } as ControlRequest;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, type: "error", message: "The gate did not answer." });
      }, this.options.timeoutMs ?? 3_000);
      timer.unref();
      this.pending.set(id, { resolve, timer });
      socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  private connected(): Promise<Socket> {
    const existing = this.socket;
    if (existing && !existing.destroyed) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const socket = connect({ path: this.socketPath });
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.socket = socket;
        this.buffered = "";
        resolve(socket);
      });
      socket.once("error", (error) => {
        if (this.socket === socket) this.socket = undefined;
        reject(error);
      });
      socket.on("data", (chunk: string) => this.receive(chunk));
      socket.once("close", () => {
        if (this.socket === socket) this.socket = undefined;
      });
    });
  }

  private receive(chunk: string): void {
    this.buffered = `${this.buffered}${chunk}`;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const message = parsed as ControlReply | WakeEvent;
      if (message.type === "wake") {
        this.options.onWake?.({
          route: message.route,
          ...(message.plotPath ? { plotPath: message.plotPath } : {}),
          ...(message.commandId ? { commandId: message.commandId } : {}),
        });
        continue;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      waiting.resolve(message);
    }
  }
}
