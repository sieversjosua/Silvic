import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import {
  parseControlRequest,
  type ControlReply,
  type GateEvent,
} from "./control-protocol";
import type { RouteStore } from "./route-store";

export interface ControlServer {
  /** Sends a wake to every connected client; false when nobody listens. */
  broadcast(event: GateEvent): boolean;
  close(): Promise<void>;
}

export function startControlServer({
  socketPath,
  store,
  version,
  log,
}: {
  socketPath: string;
  store: RouteStore;
  version: string;
  log(message: string): void;
}): Promise<ControlServer> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      // A malformed client must not grow the buffer forever.
      if (buffered.length > 64_000) {
        socket.destroy();
        return;
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const reply = handle(line);
        if (reply) socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => clients.delete(socket));
  });

  const handle = (line: string): ControlReply | undefined => {
    const request = parseControlRequest(line);
    if (!request) {
      log(`control: rejected ${line.slice(0, 200)}`);
      return undefined;
    }
    switch (request.type) {
      case "status":
        return {
          id: request.id,
          type: "status",
          version,
          routes: store.list(),
        };
      case "route-set": {
        const { id: _id, type: _type, ...route } = request;
        store.set(route);
        log(`route ${route.name} -> ${route.host}:${route.port}`);
        return { id: request.id, type: "ok" };
      }
      case "route-suspend":
        store.clearUpstream(request.name);
        log(`route ${request.name} suspended`);
        return { id: request.id, type: "ok" };
      case "route-remove":
        store.remove(request.name);
        log(`route ${request.name} removed`);
        return { id: request.id, type: "ok" };
    }
  };

  // A previous daemon's socket file blocks listen(); it is dead by
  // definition when this one starts, since launchd runs a single instance.
  rmSync(socketPath, { force: true });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, readableAll: false }, () => {
      server.off("error", reject);
      resolve({
        broadcast(event) {
          const line = `${JSON.stringify(event)}\n`;
          let delivered = false;
          for (const client of clients) {
            if (client.writable) {
              client.write(line);
              delivered = true;
            }
          }
          return delivered;
        },
        close: () => closeControlServer(server, clients, socketPath),
      });
    });
  });
}

function closeControlServer(
  server: Server,
  clients: ReadonlySet<Socket>,
  socketPath: string,
): Promise<void> {
  for (const client of clients) client.destroy();
  return new Promise((resolve) => {
    server.close(() => {
      rmSync(socketPath, { force: true });
      resolve();
    });
  });
}
