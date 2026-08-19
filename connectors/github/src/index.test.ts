import { describe, expect, it } from "vitest";

import type { WorkspaceTarget } from "@silvic/contracts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import {
  createGitHubConnector,
  findGitHubPullRequest,
  listGitHubIssues,
} from "./index";

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

  it("finds one pull request by number and names the branch it proposes", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 123,
        title: "Fix authentication",
        url: "https://github.com/example/silvic/pull/123",
        state: "OPEN",
        isDraft: true,
        headRefName: "agent/auth",
        isCrossRepository: false,
        headRepository: { name: "silvic" },
        headRepositoryOwner: { login: "example" },
        author: { login: "josua" },
      }),
      stderr: "",
    });

    await expect(
      findGitHubPullRequest(runner, "/projects/silvic", 123),
    ).resolves.toEqual({
      provider: "github",
      number: 123,
      title: "Fix authentication",
      url: "https://github.com/example/silvic/pull/123",
      state: "open",
      draft: true,
      headRefName: "agent/auth",
      author: "josua",
    });
    expect(runner.requests).toEqual([
      {
        executable: "gh",
        arguments: [
          "pr",
          "view",
          "123",
          "--json",
          "number,title,url,state,isDraft,headRefName,isCrossRepository,headRepository,headRepositoryOwner,author",
        ],
        cwd: "/projects/silvic",
      },
    ]);
  });

  it("names the fork a cross-repository head branch lives in", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 9,
        title: "Contribute a fix",
        url: "https://github.com/example/silvic/pull/9",
        state: "MERGED",
        isDraft: false,
        headRefName: "patch-1",
        isCrossRepository: true,
        headRepository: { name: "silvic" },
        headRepositoryOwner: { login: "outsider" },
        author: { login: "outsider" },
      }),
      stderr: "",
    });

    await expect(
      findGitHubPullRequest(runner, "/projects/silvic", 9),
    ).resolves.toMatchObject({
      state: "merged",
      headRepository: "outsider/silvic",
    });
  });

  it("answers nothing for a number no pull request has", async () => {
    const runner = new RecordingRunner({
      exitCode: 1,
      stdout: "",
      stderr:
        "GraphQL: Could not resolve to a PullRequest with the number of 404. (repository.pullRequest)",
    });

    await expect(
      findGitHubPullRequest(runner, "/projects/silvic", 404),
    ).resolves.toBeUndefined();
  });

  it("reports a failure that is worth acting on", async () => {
    const runner = new RecordingRunner({
      exitCode: 1,
      stdout: "",
      stderr:
        "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN",
    });

    await expect(
      findGitHubPullRequest(runner, "/projects/silvic", 5),
    ).rejects.toThrow(/GH_TOKEN/);
  });

  it("maps the current branch pull request and check rollup", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          number: 42,
          title: "Fix authentication",
          state: "OPEN",
          isDraft: false,
          url: "https://github.com/example/silvic/pull/42",
          headRefName: "agent/auth",
          headRefOid: "abc123def456",
          statusCheckRollup: [
            {
              status: "COMPLETED",
              conclusion: "SUCCESS",
            },
          ],
        },
      ]),
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
          headRefOid: "abc123def456",
        },
      },
    ]);
    expect(runner.requests).toEqual([
      {
        executable: "gh",
        arguments: [
          "pr",
          "list",
          "--state",
          "all",
          "--limit",
          "100",
          "--json",
          "number,title,state,isDraft,url,statusCheckRollup,headRefOid,headRefName",
        ],
        cwd: "/projects/silvic",
        signal: undefined,
      },
    ]);
  });

  it("answers repeat observations from its shelf until invalidated", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });
    const connector = createGitHubConnector(runner);

    await connector.observe(target);
    await connector.observe(target);
    expect(runner.requests).toHaveLength(1);

    connector.invalidate?.();
    await connector.observe(target);
    expect(runner.requests).toHaveLength(2);
  });

  it("shares one project-level request across workspaces and backs off failures", async () => {
    const runner = new RecordingRunner({
      exitCode: 1,
      stdout: "",
      stderr: "temporary GitHub failure",
    });
    const connector = createGitHubConnector(runner);

    await Promise.allSettled([
      connector.observe({ ...target, workspaceId: "one", branch: "one" }),
      connector.observe({ ...target, workspaceId: "two", branch: "two" }),
    ]);
    await Promise.allSettled([
      connector.observe({ ...target, workspaceId: "one", branch: "one" }),
      connector.observe({ ...target, workspaceId: "two", branch: "two" }),
    ]);

    expect(runner.requests).toHaveLength(1);
  });

  it("does not invoke GitHub for a non-GitHub origin", async () => {
    const runner = new RecordingRunner({
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });

    await expect(
      createGitHubConnector(runner).observe({
        ...target,
        origin: "git@gitlab.com:example/silvic.git",
      }),
    ).resolves.toEqual([]);

    expect(runner.requests).toEqual([]);
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
