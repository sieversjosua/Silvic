export const automationProtocolVersion = 2 as const;

export interface AutomationPeer {
  name: "silvic-cli" | "silvic-codex-plugin" | "silvic-desktop";
  version: string;
}

export type AutomationMethod =
  | "snapshot"
  | "status"
  | "adoptionPlan"
  | "adopt"
  | "provision"
  | "start"
  | "stop"
  | "wait"
  | "logs";

export interface AutomationRequest {
  jsonrpc: "2.0";
  protocolVersion: typeof automationProtocolVersion;
  client: AutomationPeer;
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
      server: AutomationPeer;
      jsonrpc: "2.0";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      protocolVersion: typeof automationProtocolVersion;
      server: AutomationPeer;
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
      `This Silvic client uses automation protocol ${String(value["protocolVersion"])}; the installed app requires protocol ${automationProtocolVersion}. Update the Silvic Codex plugin or CLI to the same version as the app.`,
      {
        requested: value["protocolVersion"],
        supported: [automationProtocolVersion],
        action:
          "Install the Codex plugin artifact from the matching Silvic GitHub release, then start a new Codex task.",
      },
    );
  }
  const id = value["id"];
  const method = value["method"];
  const params = value["params"];
  const client = value["client"];
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 100 ||
    !isAutomationMethod(method) ||
    !isAutomationPeer(client) ||
    !isRecord(params)
  ) {
    throw new AutomationError("INVALID_REQUEST", "Request shape is invalid.");
  }
  return {
    jsonrpc: "2.0",
    protocolVersion: automationProtocolVersion,
    client,
    id,
    method,
    params,
  };
}

export function assertCompatibleClient(
  request: AutomationRequest,
  serverVersion: string,
): void {
  if (request.client.version === serverVersion) return;
  throw new AutomationError(
    "INCOMPATIBLE_CLIENT",
    `Silvic ${serverVersion} cannot serve ${request.client.name} ${request.client.version}. Install the Codex plugin or CLI from Silvic ${serverVersion}.`,
    {
      client: request.client,
      server: { name: "silvic-desktop", version: serverVersion },
      protocolVersion: automationProtocolVersion,
      action:
        "Install the Codex plugin artifact from the matching Silvic GitHub release, then start a new Codex task.",
    },
  );
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
    value === "start" ||
    value === "stop" ||
    value === "wait" ||
    value === "logs"
  );
}

function isAutomationPeer(value: unknown): value is AutomationPeer {
  return (
    isRecord(value) &&
    (value["name"] === "silvic-cli" ||
      value["name"] === "silvic-codex-plugin" ||
      value["name"] === "silvic-desktop") &&
    typeof value["version"] === "string" &&
    value["version"].length > 0 &&
    value["version"].length <= 100
  );
}
