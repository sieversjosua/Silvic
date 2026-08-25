import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, Socket, type Server } from "node:net";
import { dirname } from "node:path";

import {
  automationProtocolVersion,
  errorBody,
  parseAutomationRequest,
  type AutomationRequest,
} from "./protocol";
import { automationSocketPath } from "./state-dir";

export interface AutomationServer {
  close(): Promise<void>;
}

export async function startAutomationServer({
  socketPath = automationSocketPath(),
  handle,
}: {
  socketPath?: string;
  handle(request: AutomationRequest, signal: AbortSignal): Promise<unknown>;
}): Promise<AutomationServer> {
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffered = "";
    let answered = false;
    const cancellation = new AbortController();
    socket.on("data", (chunk: string) => {
      if (answered) return;
      buffered += chunk;
      if (buffered.length > 64_000) {
        socket.destroy();
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      answered = true;
      const line = buffered.slice(0, newline);
      void answer(socket, line, handle, cancellation.signal);
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      cancellation.abort();
      clients.delete(socket);
    });
  });

  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error(`Another Silvic automation server owns ${socketPath}.`);
  }
  await rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: socketPath, readableAll: false }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  return {
    close: () => closeServer(server, clients, socketPath),
  };
}

async function answer(
  socket: Socket,
  line: string,
  handle: (request: AutomationRequest, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  let id = "invalid";
  try {
    const request = parseAutomationRequest(line);
    id = request.id;
    const result = await handle(request, signal);
    socket.end(
      `${JSON.stringify({ jsonrpc: "2.0", protocolVersion: automationProtocolVersion, id, ok: true, result })}\n`,
    );
  } catch (error) {
    socket.end(
      `${JSON.stringify({ jsonrpc: "2.0", protocolVersion: automationProtocolVersion, id, ok: false, error: errorBody(error) })}\n`,
    );
  }
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 200);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.connect({ path: socketPath });
  });
}

function closeServer(
  server: Server,
  clients: ReadonlySet<Socket>,
  socketPath: string,
): Promise<void> {
  for (const client of clients) client.destroy();
  return new Promise((resolve) => {
    server.close(() => {
      void rm(socketPath, { force: true }).finally(resolve);
    });
  });
}
