import type {
  Connector,
  ConnectorObservation,
  IssueSummary,
  WorkspaceTarget,
} from "@silvic/contracts";
import type { CommandRunner } from "@silvic/core";

interface PullRequestResponse {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  /** The branch tip GitHub merged — the proof a squash left nothing behind. */
  headRefOid: string;
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

/**
 * How long an answered pull-request lookup keeps standing in for the next one.
 * Every observation is a `gh` process and a GitHub round-trip per workspace;
 * at the interface's polling cadence that is a steady battery drain for state
 * that rarely changes within minutes. Anything that actually changes a pull
 * request goes through a forced refresh, which invalidates this cache.
 */
const observationShelfLifeMs = 120_000;

export function createGitHubConnector(runner: CommandRunner): Connector {
  const cache = new Map<
    string,
    { createdAt: number; value: Promise<readonly ConnectorObservation[]> }
  >();
  return {
    manifest: {
      id: "github",
      name: "GitHub",
      kind: "service",
      capabilities: ["observe"],
    },
    invalidate: () => {
      cache.clear();
    },
    observe: (target, context) => {
      const key = `${target.workspaceId}:${target.path}`;
      const cached = cache.get(key);
      const now = Date.now();
      if (cached && now - cached.createdAt < observationShelfLifeMs) {
        return cached.value;
      }
      const value = observePullRequest(runner, target, context);
      cache.set(key, { createdAt: now, value });
      // A failure is worth retrying, not remembering.
      value.catch(() => {
        if (cache.get(key)?.value === value) cache.delete(key);
      });
      return value;
    },
  };
}

async function observePullRequest(
  runner: CommandRunner,
  target: WorkspaceTarget,
  context: Parameters<Connector["observe"]>[1],
): Promise<readonly ConnectorObservation[]> {
  const result = await runner.run({
    executable: "gh",
    arguments: [
      "pr",
      "view",
      "--json",
      "number,title,state,isDraft,url,statusCheckRollup,headRefOid",
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
        headRefOid: response.headRefOid,
      },
    } satisfies ConnectorObservation,
  ];
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
    !("headRefOid" in value) ||
    !("statusCheckRollup" in value) ||
    typeof value.number !== "number" ||
    typeof value.title !== "string" ||
    typeof value.state !== "string" ||
    typeof value.isDraft !== "boolean" ||
    typeof value.url !== "string" ||
    typeof value.headRefOid !== "string" ||
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

/** Terse enough for a card chip; the pull request's title lives in `detail`. */
function labelForPullRequest(
  response: PullRequestResponse,
  checks: ReturnType<typeof summarizeChecks>,
): string {
  if (response.state !== "OPEN")
    return `#${response.number} ${response.state.toLowerCase()}`;
  if (response.isDraft) return `#${response.number} draft`;
  if (checks === "success") return `#${response.number} green`;
  if (checks === "failure") return `#${response.number} checks failed`;
  if (checks === "pending") return `#${response.number} checks running`;
  return `#${response.number}`;
}
