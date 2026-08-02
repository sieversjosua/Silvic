import type {
  Connector,
  ConnectorObservation,
  IssueSummary,
} from "@silvic/contracts";
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

interface IssueResponse {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: readonly { name: string }[];
  assignees: readonly { login: string }[];
}

export async function listGitHubIssues(
  runner: CommandRunner,
  cwd: string,
  query = "",
): Promise<readonly IssueSummary[]> {
  const arguments_ = [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,title,body,url,labels,assignees",
    ...(query.trim() ? ["--search", query.trim()] : []),
  ];
  const result = await runner.run({
    executable: "gh",
    arguments: arguments_,
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        "GitHub CLI is unavailable",
    );
  }
  return parseIssues(result.stdout).map((issue) => ({
    provider: "github",
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
  }));
}

function parseIssues(output: string): readonly IssueResponse[] {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value) || !value.every(isIssueResponse)) {
    throw new Error("GitHub returned an unreadable issue response");
  }
  return value;
}

function isIssueResponse(value: unknown): value is IssueResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "number" in value &&
    typeof value.number === "number" &&
    "title" in value &&
    typeof value.title === "string" &&
    "body" in value &&
    typeof value.body === "string" &&
    "url" in value &&
    typeof value.url === "string" &&
    "labels" in value &&
    Array.isArray(value.labels) &&
    value.labels.every(
      (label) =>
        typeof label === "object" &&
        label !== null &&
        "name" in label &&
        typeof label.name === "string",
    ) &&
    "assignees" in value &&
    Array.isArray(value.assignees) &&
    value.assignees.every(
      (assignee) =>
        typeof assignee === "object" &&
        assignee !== null &&
        "login" in assignee &&
        typeof assignee.login === "string",
    )
  );
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
