import type { Connector, ConnectorObservation } from "@silvic/contracts";
import type { CommandRunner } from "@silvic/core";

interface PullRequestResponse {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  statusCheckRollup: readonly {
    status?: string;
    conclusion?: string;
    state?: string;
  }[];
}

export function createGitHubConnector(runner: CommandRunner): Connector {
  return {
    manifest: {
      id: "github",
      name: "GitHub",
      kind: "service",
      capabilities: ["observe"],
    },
    observe: async (target, context) => {
      const result = await runner.run({
        executable: "gh",
        arguments: [
          "pr",
          "view",
          "--json",
          "number,title,state,isDraft,url,statusCheckRollup",
        ],
        cwd: target.path,
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || result.stdout.trim();
        const normalized = message.toLowerCase();
        if (
          normalized.includes("no pull request") ||
          normalized.includes("could not resolve to a pullrequest")
        ) {
          return [];
        }
        throw new Error(message || "GitHub CLI is unavailable");
      }
      const response = parsePullRequest(result.stdout);
      const checks = summarizeChecks(response.statusCheckRollup);
      const observationState = stateForPullRequest(response, checks);
      return [
        {
          connectorId: "github",
          workspaceId: target.workspaceId,
          kind: "review",
          state: observationState,
          label: labelForPullRequest(response, checks),
          detail: response.title,
          url: response.url,
          metadata: {
            number: response.number,
            draft: response.isDraft,
            state: response.state,
            checks,
          },
        } satisfies ConnectorObservation,
      ];
    },
  };
}

function parsePullRequest(output: string): PullRequestResponse {
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("number" in value) ||
    !("title" in value) ||
    !("state" in value) ||
    !("isDraft" in value) ||
    !("url" in value) ||
    !("statusCheckRollup" in value) ||
    typeof value.number !== "number" ||
    typeof value.title !== "string" ||
    typeof value.state !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.url !== "string" ||
    !Array.isArray(value.statusCheckRollup)
  ) {
    throw new Error("GitHub returned an unreadable pull-request response");
  }
  return value as unknown as PullRequestResponse;
}

function summarizeChecks(
  checks: PullRequestResponse["statusCheckRollup"],
): "success" | "failure" | "pending" | "unknown" {
  if (checks.length === 0) return "unknown";
  const failing = new Set([
    "FAILURE",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);
  if (
    checks.some((check) => failing.has(check.conclusion ?? check.state ?? ""))
  ) {
    return "failure";
  }
  const pending = new Set([
    "PENDING",
    "EXPECTED",
    "QUEUED",
    "IN_PROGRESS",
    "WAITING",
  ]);
  if (checks.some((check) => pending.has(check.status ?? check.state ?? ""))) {
    return "pending";
  }
  const successful = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  return checks.every((check) =>
    successful.has(check.conclusion ?? check.state ?? ""),
  )
    ? "success"
    : "unknown";
}

function stateForPullRequest(
  response: PullRequestResponse,
  checks: ReturnType<typeof summarizeChecks>,
): ConnectorObservation["state"] {
  if (response.state !== "OPEN") return "quiet";
  if (checks === "failure") return "attention";
  if (response.isDraft || checks === "pending") return "waiting";
  if (checks === "success") return "ready";
  return "unknown";
}

function labelForPullRequest(
  response: PullRequestResponse,
  checks: ReturnType<typeof summarizeChecks>,
): string {
  if (response.state !== "OPEN")
    return `PR #${response.number} is ${response.state.toLowerCase()}`;
  if (response.isDraft) return `Draft PR #${response.number}`;
  if (checks === "success") return `PR #${response.number} is green`;
  if (checks === "failure") return `PR #${response.number} checks failed`;
  if (checks === "pending") return `PR #${response.number} checks running`;
  return `PR #${response.number}`;
}
