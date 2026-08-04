import { describe, expect, it } from "vitest";

import type { WorkspaceTarget } from "@silvic/contracts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import { createGitHubConnector, listGitHubIssues } from "./index";

const target: WorkspaceTarget = {
  workspaceId: "workspace-1",
  projectId: "github.com/example/silvic",
  path: "/projects/silvic",
  repositoryName: "silvic",
  branch: "agent/auth",
};

describe("GitHub connector", () => {
  it("lists open issues as work that can become a Plot", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 184,
          title: "Fix HEIC uploads",
          body: "HEIC images fail during conversion.",
          url: "https://github.com/example/silvic/issues/184",
          labels: [{ name: "bug" }],
          assignees: [{ login: "josua" }],
        },
      ]),
      stderr: "",
    });

    await expect(
      listGitHubIssues(runner, "/projects/silvic", "heic"),
    ).resolves.toEqual([
      {
        provider: "github",
        number: 184,
        title: "Fix HEIC uploads",
        body: "HEIC images fail during conversion.",
        url: "https://github.com/example/silvic/issues/184",
        labels: ["bug"],
        assignees: ["josua"],
      },
    ]);
    expect(runner.requests).toEqual([
      {
        executable: "gh",
        arguments: [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          "number,title,body,url,labels,assignees",
          "--search",
          "heic",
        ],
        cwd: "/projects/silvic",
      },
    ]);
  });

  it("maps the current branch pull request and check rollup", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 42,
        title: "Fix authentication",
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/example/silvic/pull/42",
        statusCheckRollup: [
          {
            status: "COMPLETED",
            conclusion: "SUCCESS",
          },
        ],
      }),
      stderr: "",
    });

    const observations = await createGitHubConnector(runner).observe(target);

    expect(observations).toEqual([
      {
        connectorId: "github",
        workspaceId: "workspace-1",
        kind: "review",
        state: "ready",
        label: "#42 green",
        detail: "Fix authentication",
        url: "https://github.com/example/silvic/pull/42",
        metadata: {
          number: 42,
          draft: false,
          state: "OPEN",
          checks: "success",
        },
      },
    ]);
    expect(runner.requests).toEqual([
      {
        executable: "gh",
        arguments: [
          "pr",
          "view",
          "--json",
          "number,title,state,isDraft,url,statusCheckRollup",
        ],
        cwd: "/projects/silvic",
        signal: undefined,
      },
    ]);
  });

  it("answers repeat observations from its shelf until invalidated", async () => {
    const runner = new RecordingRunner({
      exitCode: 1,
      stdout: "",
      stderr: "no pull request found",
    });
    const connector = createGitHubConnector(runner);

    await connector.observe(target);
    await connector.observe(target);
    expect(runner.requests).toHaveLength(1);

    connector.invalidate?.();
    await connector.observe(target);
    expect(runner.requests).toHaveLength(2);
  });
});

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];

  constructor(private readonly result: CommandResult) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    return this.result;
  }
}
