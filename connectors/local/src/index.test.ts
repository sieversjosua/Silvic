import { describe, expect, it } from "vitest";

import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import {
  codexTaskMatches,
  codexTaskObservation,
  createLocalContextConnector,
  parseCodexTasks,
} from "./index";

class FakeRunner implements CommandRunner {
  listening = true;
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
    return { exitCode: 0, stdout: "[]", stderr: "" };
  }
}

describe("createLocalContextConnector", () => {
  it("can discard a stale runtime cache immediately", async () => {
    const runner = new FakeRunner();
    const connector = createLocalContextConnector(runner);
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

  it("counts a Codex session anywhere inside the worktree as plot activity", () => {
    const task = (cwd: string) => ({
      id: "task",
      cwd,
      title: "Fix billing",
      updatedAtMs: 1_786_610_000_123,
    });
    expect(
      codexTaskMatches("/plots/mono-billing", task("/plots/mono-billing")),
    ).toBe(true);
    expect(
      codexTaskMatches(
        "/plots/mono-billing",
        task("/plots/mono-billing/apps/web"),
      ),
    ).toBe(true);
    // A sibling plot sharing the prefix is not inside.
    expect(
      codexTaskMatches("/plots/mono-billing", task("/plots/mono-billing-v2")),
    ).toBe(false);
    expect(codexTaskMatches("/plots/mono-billing", task("/plots/other"))).toBe(
      false,
    );
  });

  it("counts a session recorded in a worktree container holding one repo", () => {
    const task = (cwd: string) => ({
      id: "task",
      cwd,
      title: "Fix billing",
      updatedAtMs: 1_786_610_000_123,
    });
    const soleRepo = (cwd: string) =>
      cwd === "/w/65e0" ? "/w/65e0/mono" : undefined;
    // Codex records ~/.codex/worktrees/65e0 as the cwd of a session working
    // in the mono repository it created inside.
    expect(codexTaskMatches("/w/65e0/mono", task("/w/65e0"), soleRepo)).toBe(
      true,
    );
    // A folder of many repositories claims none of them.
    expect(codexTaskMatches("/dev/mono", task("/dev"), () => undefined)).toBe(
      false,
    );
  });

  it("keeps the Codex task activity timestamp used by the grove", () => {
    const [task] = parseCodexTasks(
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
    });
    if (!task) throw new Error("the valid task should be parsed");
    expect(
      codexTaskObservation(
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
});
