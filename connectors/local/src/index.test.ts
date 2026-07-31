import { describe, expect, it } from "vitest";

import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import { createLocalContextConnector } from "./index";

class FakeRunner implements CommandRunner {
  listening = true;

  async run(request: CommandRequest): Promise<CommandResult> {
    if (request.executable === "lsof" && request.arguments?.includes("-Fpcn")) {
      return {
        exitCode: 0,
        stdout: this.listening ? "p42\ncnode\nn*:3456\n" : "",
        stderr: "",
      };
    }
    if (request.executable === "lsof") {
      return { exitCode: 0, stdout: "n/plots/app\n", stderr: "" };
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

    expect(await connector.observe(target)).toHaveLength(1);
    runner.listening = false;
    expect(await connector.observe(target)).toHaveLength(1);

    expect(connector.invalidate).toBeTypeOf("function");
    connector.invalidate?.();

    expect(await connector.observe(target)).toEqual([]);
  });
});
