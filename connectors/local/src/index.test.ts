import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import {
  createLocalContextConnector,
  readT3Sessions,
  parseCodexSessions,
  readClaudeSessions,
  sessionMatches,
  sessionObservation,
  transcriptTitle,
} from "./index";

class FakeRunner implements CommandRunner {
  listening = true;
  sqlite = "[]";
  readonly requests: CommandRequest[] = [];

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    if (request.executable === "lsof" && request.arguments?.includes("-Fpcn")) {
      return {
        exitCode: 0,
        stdout: this.listening ? "p42\ncnode\nn*:3456\n" : "",
        stderr: "",
      };
    }
    if (request.executable === "lsof") {
      return { exitCode: 0, stdout: "p42\nn/plots/app\n", stderr: "" };
    }
    if (request.executable === "ps") {
      return {
        exitCode: 0,
        stdout: request.arguments?.includes("-axo")
          ? "  42  23\n  23  1\n"
          : "  42  23\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: this.sqlite, stderr: "" };
  }
}

/** No home-directory harness records: this test is about the process scan. */
function hermeticSources() {
  return {
    claudeProjects: mkdtempSync(join(tmpdir(), "silvic-no-claude-")),
    t3Database: join(tmpdir(), "silvic-no-t3-database.sqlite"),
  };
}

describe("createLocalContextConnector", () => {
  it("can discard a stale runtime cache immediately", async () => {
    const runner = new FakeRunner();
    const connector = createLocalContextConnector(runner, hermeticSources());
    const target = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      path: "/plots/app",
      repositoryName: "app",
      branch: "test",
    };

    expect(await connector.observe(target)).toEqual([
      expect.objectContaining({
        metadata: {
          processId: 42,
          processGroupId: 23,
          processLineage: [42, 23, 1],
        },
      }),
    ]);
    expect(
      runner.requests.filter(
        (request) =>
          request.executable === "lsof" && request.arguments?.includes("-d"),
      ),
    ).toHaveLength(1);
    expect(
      runner.requests.filter(
        (request) =>
          request.executable === "ps" && request.arguments?.includes("-p"),
      ),
    ).toHaveLength(1);
    runner.listening = false;
    expect(await connector.observe(target)).toHaveLength(1);

    expect(connector.invalidate).toBeTypeOf("function");
    connector.invalidate?.();

    expect(await connector.observe(target)).toEqual([]);
  });

  it("reads Claude Code transcripts as sessions of the plot they ran in", () => {
    const root = mkdtempSync(join(tmpdir(), "silvic-claude-"));
    const folder = join(root, "-plots-mono-billing");
    mkdirSync(folder);
    const older = join(folder, "11111111-1111-1111-1111-111111111111.jsonl");
    const newest = join(folder, "22222222-2222-2222-2222-222222222222.jsonl");
    writeFileSync(
      older,
      `${JSON.stringify({ type: "user", cwd: "/plots/mono-billing" })}\n`,
    );
    writeFileSync(
      newest,
      [
        JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
        JSON.stringify({
          type: "user",
          cwd: "/plots/mono-billing/apps/web",
          message: {
            role: "user",
            content: "<command-name>/loop</command-name>",
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "Fix the billing rail" }],
          },
        }),
      ].join("\n"),
    );
    const when = 1_786_610_000;
    utimesSync(older, when - 600, when - 600);
    utimesSync(newest, when, when);

    // Only the newest transcript speaks for the folder: the same person may
    // have worked there a hundred times, and the view asks "when last".
    expect(readClaudeSessions(root, when * 1_000)).toEqual([
      {
        id: "22222222-2222-2222-2222-222222222222",
        cwd: "/plots/mono-billing/apps/web",
        title: "Fix the billing rail",
        updatedAtMs: when * 1_000,
        harness: "claude",
      },
    ]);
  });

  it("leaves transcripts alone once they are older than any recent view", () => {
    const root = mkdtempSync(join(tmpdir(), "silvic-claude-"));
    const folder = join(root, "-plots-ancient");
    mkdirSync(folder);
    const transcript = join(
      folder,
      "33333333-3333-3333-3333-333333333333.jsonl",
    );
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "user", cwd: "/plots/ancient" })}\n`,
    );
    const when = 1_786_610_000;
    utimesSync(transcript, when, when);

    expect(
      readClaudeSessions(root, (when + 30 * 24 * 60 * 60) * 1_000),
    ).toEqual([]);
  });

  it("titles a Claude Code session with the first thing a person typed", () => {
    const head = [
      JSON.stringify({ type: "assistant", message: { content: "hello" } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Caveat: this session was resumed" },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "  Make the\n grove readable  " }],
        },
      }),
    ].join("\n");

    expect(transcriptTitle(head)).toBe("Make the grove readable");
    expect(transcriptTitle("not json at all")).toBeUndefined();
  });

  it("reads T3 Code threads as sessions of the worktree they belong to", async () => {
    const database = join(
      mkdtempSync(join(tmpdir(), "silvic-t3-")),
      "state.sqlite",
    );
    writeFileSync(database, "");
    const runner = new FakeRunner();
    runner.sqlite = JSON.stringify([
      {
        id: "thread-1",
        cwd: "/plots/mono-billing",
        title: "Fix the billing rail",
        updatedAtMs: 1_786_610_000_123,
      },
    ]);

    await expect(readT3Sessions(runner, database)).resolves.toEqual([
      {
        id: "thread-1",
        cwd: "/plots/mono-billing",
        title: "Fix the billing rail",
        updatedAtMs: 1_786_610_000_123,
        harness: "t3-code",
      },
    ]);
    // A database that is not there is the ordinary case on a machine without
    // T3 Code, not a failure worth reporting.
    await expect(
      readT3Sessions(runner, join(tmpdir(), "silvic-absent.sqlite")),
    ).resolves.toEqual([]);
  });

  it("counts a Codex session anywhere inside the worktree as plot activity", () => {
    const task = (cwd: string) =>
      ({
        id: "task",
        cwd,
        title: "Fix billing",
        updatedAtMs: 1_786_610_000_123,
        harness: "codex",
      }) as const;
    expect(
      sessionMatches("/plots/mono-billing", task("/plots/mono-billing")),
    ).toBe(true);
    expect(
      sessionMatches(
        "/plots/mono-billing",
        task("/plots/mono-billing/apps/web"),
      ),
    ).toBe(true);
    // A sibling plot sharing the prefix is not inside.
    expect(
      sessionMatches("/plots/mono-billing", task("/plots/mono-billing-v2")),
    ).toBe(false);
    expect(sessionMatches("/plots/mono-billing", task("/plots/other"))).toBe(
      false,
    );
  });

  it("counts a session recorded in a worktree container holding one repo", () => {
    const task = (cwd: string) =>
      ({
        id: "task",
        cwd,
        title: "Fix billing",
        updatedAtMs: 1_786_610_000_123,
        harness: "codex",
      }) as const;
    const soleRepo = (cwd: string) =>
      cwd === "/w/65e0" ? "/w/65e0/mono" : undefined;
    // Codex records ~/.codex/worktrees/65e0 as the cwd of a session working
    // in the mono repository it created inside.
    expect(sessionMatches("/w/65e0/mono", task("/w/65e0"), soleRepo)).toBe(
      true,
    );
    // A folder of many repositories claims none of them.
    expect(sessionMatches("/dev/mono", task("/dev"), () => undefined)).toBe(
      false,
    );
  });

  it("keeps the Codex task activity timestamp used by the grove", () => {
    const [task] = parseCodexSessions(
      JSON.stringify([
        {
          id: "task-1",
          cwd: "/plots/app",
          title: "Make the grove readable",
          updatedAtMs: 1_786_610_000_123,
        },
        {
          id: "invalid",
          cwd: "/plots/old",
          title: "Missing timestamp",
        },
      ]),
    );
    expect(task).toEqual({
      id: "task-1",
      cwd: "/plots/app",
      title: "Make the grove readable",
      updatedAtMs: 1_786_610_000_123,
      harness: "codex",
    });
    if (!task) throw new Error("the valid task should be parsed");
    expect(
      sessionObservation(
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          path: "/plots/app",
          repositoryName: "app",
          branch: "agent/grove",
        },
        task,
      ).metadata,
    ).toEqual({ taskId: "task-1", updatedAtMs: 1_786_610_000_123 });
  });

  it("recognises a Codex thread whose rollout is held open", () => {
    const [task] = parseCodexSessions(
      JSON.stringify([
        {
          id: "task-1",
          cwd: "/plots/app",
          title: "Make the grove readable",
          updatedAtMs: 1_786_610_000_123,
          rolloutPath: "/codex/sessions/task-1.jsonl",
        },
      ]),
      new Set(["/codex/sessions/task-1.jsonl"]),
    );

    expect(task?.active).toBe(true);
  });

  it("marks open or recently moving harness sessions as active", () => {
    const now = 1_786_610_300_000;
    const target = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      path: "/plots/app",
      repositoryName: "app",
      branch: "agent/grove",
    };
    const session = (updatedAtMs: number, active?: boolean) => ({
      id: "task-1",
      cwd: "/plots/app",
      title: "Make the grove readable",
      updatedAtMs,
      harness: "codex" as const,
      ...(active === undefined ? {} : { active }),
    });

    expect(sessionObservation(target, session(now - 30_000), now).state).toBe(
      "active",
    );
    expect(
      sessionObservation(target, session(now - 10 * 60_000), now).state,
    ).toBe("ready");
    expect(
      sessionObservation(target, session(now - 10 * 60_000, true), now).state,
    ).toBe("active");
  });
});
