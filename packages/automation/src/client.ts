import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import {
  AutomationError,
  automationProtocolVersion,
  isRecord,
  type AutomationMethod,
} from "./protocol";
import { automationSocketPath } from "./state-dir";

export class AutomationClient {
  constructor(
    private readonly options: {
      socketPath?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  call<T>(
    method: AutomationMethod,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const id = randomUUID();
    const path = this.options.socketPath ?? automationSocketPath();
    const readinessTimeout =
      method === "wait" && typeof params["timeoutMs"] === "number"
        ? params["timeoutMs"]
        : 60_000;
    const timeoutMs =
      this.options.timeoutMs ??
      (method === "wait"
        ? Math.min(readinessTimeout + 5_000, 605_000)
        : 65_000);
    return new Promise<T>((resolve, reject) => {
      const socket = connect({ path });
      socket.setEncoding("utf8");
      let buffered = "";
      let settled = false;
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new AutomationError(
              "CONTROL_TIMEOUT",
              `Silvic did not answer within ${timeoutMs} ms.`,
            ),
          ),
        );
      }, timeoutMs);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        socket.destroy();
        callback();
      };
      const aborted = () =>
        finish(() =>
          reject(new AutomationError("CANCELLED", "Operation was cancelled.")),
        );
      if (options.signal?.aborted) {
        aborted();
        return;
      }
      options.signal?.addEventListener("abort", aborted, { once: true });
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", protocolVersion: automationProtocolVersion, id, method, params })}\n`,
        );
      });
      socket.on("data", (chunk: string) => {
        buffered += chunk;
        if (buffered.length > 1_000_000) {
          finish(() =>
            reject(
              new AutomationError(
                "INVALID_REPLY",
                "Silvic returned an oversized response.",
              ),
            ),
          );
          return;
        }
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        let reply: ReturnType<typeof parseReply>;
        try {
          reply = parseReply(buffered.slice(0, newline), id);
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        if (reply.ok) finish(() => resolve(reply.result as T));
        else {
          finish(() =>
            reject(
              new AutomationError(
                reply.error.code,
                reply.error.message,
                reply.error.details,
              ),
            ),
          );
        }
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            new AutomationError(
              "SILVIC_UNAVAILABLE",
              error.code === "ENOENT" || error.code === "ECONNREFUSED"
                ? "Silvic is not running. Open Silvic and try again."
                : error.message,
            ),
          ),
        );
      });
    });
  }
}

function parseReply(
  line: string,
  id: string,
):
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: string; message: string; details?: unknown };
    } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AutomationError("INVALID_REPLY", "Silvic returned invalid JSON.");
  }
  if (
    !isRecord(value) ||
    value["jsonrpc"] !== "2.0" ||
    value["protocolVersion"] !== automationProtocolVersion ||
    value["id"] !== id ||
    typeof value["ok"] !== "boolean"
  ) {
    throw new AutomationError(
      "INVALID_REPLY",
      "Silvic returned an invalid reply.",
    );
  }
  if (value["ok"]) return { ok: true, result: value["result"] };
  const error = value["error"];
  if (
    !isRecord(error) ||
    typeof error["code"] !== "string" ||
    typeof error["message"] !== "string"
  ) {
    throw new AutomationError(
      "INVALID_REPLY",
      "Silvic returned an invalid error.",
    );
  }
  return {
    ok: false,
    error: {
      code: error["code"],
      message: error["message"],
      ...(error["details"] === undefined ? {} : { details: error["details"] }),
    },
  };
}
