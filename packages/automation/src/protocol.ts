export const automationProtocolVersion = 1 as const;

export type AutomationMethod =
  | "snapshot"
  | "status"
  | "adoptionPlan"
  | "adopt"
  | "provision"
  | "workspaceStatePlan"
  | "pruneWorkspaceState"
  | "start"
  | "stop"
  | "wait"
  | "logs";

export interface AutomationRequest {
  jsonrpc: "2.0";
  protocolVersion: typeof automationProtocolVersion;
  id: string;
  method: AutomationMethod;
  params: Record<string, unknown>;
}

export interface AutomationErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export type AutomationReply =
  | {
      protocolVersion: typeof automationProtocolVersion;
      jsonrpc: "2.0";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: typeof automationProtocolVersion;
      jsonrpc: "2.0";
      id: string;
      ok: false;
      error: AutomationErrorBody;
    };

export class AutomationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AutomationError";
  }
}

export function parseAutomationRequest(line: string): AutomationRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AutomationError("INVALID_REQUEST", "Request is not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new AutomationError("INVALID_REQUEST", "Request must be an object.");
  }
  if (value["jsonrpc"] !== "2.0") {
    throw new AutomationError("INVALID_REQUEST", "jsonrpc must be 2.0.");
  }
  if (value["protocolVersion"] !== automationProtocolVersion) {
    throw new AutomationError(
      "UNSUPPORTED_PROTOCOL",
      `Silvic automation protocol ${String(value["protocolVersion"])} is not supported.`,
      { supported: [automationProtocolVersion] },
    );
  }
  const id = value["id"];
  const method = value["method"];
  const params = value["params"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 100 ||
    !isAutomationMethod(method) ||
    !isRecord(params)
  ) {
    throw new AutomationError("INVALID_REQUEST", "Request shape is invalid.");
  }
  return {
    jsonrpc: "2.0",
    protocolVersion: automationProtocolVersion,
    id,
    method,
    params,
  };
}

export function errorBody(error: unknown): AutomationErrorBody {
  if (error instanceof AutomationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutomationMethod(value: unknown): value is AutomationMethod {
  return (
    value === "snapshot" ||
    value === "status" ||
    value === "adoptionPlan" ||
    value === "adopt" ||
    value === "provision" ||
    value === "workspaceStatePlan" ||
    value === "pruneWorkspaceState" ||
    value === "start" ||
    value === "stop" ||
    value === "wait" ||
    value === "logs"
  );
}
