import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceTarget } from "@silvic/contracts";
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "@silvic/core";

import {
  createWorkCliConnector,
  parseDoctor,
  parseStatus,
  routeUrl,
} from "./index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const doctorOutput = [
  "git\tok\t/Users/me/01_Local_Workspace/SynTwin",
  "config\tok\tsyntwin-mono",
  "setup\tbun scripts/work-setup.ts",
  "portless\tok",
  "tmux\tmissing",
  "workd\tstopped",
  "command\tweb\tauto\trouted",
  "command\tconvex\tauto\tlocal",
].join("\n");

describe("parseDoctor", () => {
  it("reads the project slug and which commands are routed", () => {
    const setup = parseDoctor(doctorOutput);

    expect(setup?.project).toBe("syntwin-mono");
    expect(setup?.portless).toBe(true);
    // Tab separated, so the setup command keeps its spaces.
    expect(setup?.setup).toBe("bun scripts/work-setup.ts");
    expect(setup?.commands).toEqual([
      { id: "web", autoStart: true, routed: true },
      { id: "convex", autoStart: true, routed: false },
    ]);
  });

  it("reports nothing when the directory is not a work project", () => {
    expect(parseDoctor("git\tok\t/tmp\nconfig\tmissing")).toBeUndefined();
    expect(parseDoctor("")).toBeUndefined();
  });
});

describe("routeUrl", () => {
  it("builds the address a plot answers on before it is started", () => {
    expect(routeUrl("web", "codex-70b0", "syntwin-mono")).toBe(
      "https://web-codex-70b0-syntwin-mono.localhost",
    );
  });
});

describe("parseStatus", () => {
  it("reads a tracked command row", () => {
    expect(
      parseStatus(
        "running syntwin-mono/codex-70b0 web tmux h1 https://web.localhost",
      ),
    ).toEqual([
      {
        project: "syntwin-mono",
        workspace: "codex-70b0",
        command: "web",
        status: "running",
        runner: "tmux",
        url: "https://web.localhost",
      },
    ]);
  });

  it("skips anything that is not a tracked command", () => {
    expect(parseStatus("no tracked commands")).toEqual([]);
  });
});

describe("work-cli connector", () => {
  const target: WorkspaceTarget = {
    workspaceId: "workspace-1",
    projectId: "project-1",
    path: "/Users/me/.codex/worktrees/70b0/SynTwin",
    repositoryName: "SynTwin",
    branch: "(detached)",
  };

  async function stateRootWith(root: string): Promise<string> {
    const stateRoot = await mkdtemp(join(tmpdir(), "silvic-work-cli-"));
    temporaryDirectories.push(stateRoot);
    const directory = join(
      stateRoot,
      "projects",
      "syntwin-mono",
      "workspaces",
      "codex-70b0",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "state.json"),
      JSON.stringify({
        project: "syntwin-mono",
        workspace: "codex-70b0",
        root,
      }),
    );
    return stateRoot;
  }

  it("reports the routed URL even when nothing is running", async () => {
    const stateRoot = await stateRootWith(target.path);
    const runner = new ScriptedRunner({
      doctor: doctorOutput,
      status: "no tracked commands",
    });

    const observations = await createWorkCliConnector(
      runner,
      stateRoot,
    ).observe(target);

    // The unrouted `convex` command has no address, so it stays hidden until it
    // is actually running.
    expect(observations).toEqual([
      {
        connectorId: "work-cli",
        workspaceId: "workspace-1",
        kind: "runtime",
        state: "quiet",
        label: "web",
        detail: "Not started · work up",
        url: "https://web-codex-70b0-syntwin-mono.localhost",
      },
    ]);
  });

  it("marks a command active once work reports it running", async () => {
    const stateRoot = await stateRootWith(target.path);
    const runner = new ScriptedRunner({
      doctor: doctorOutput,
      status:
        "running syntwin-mono/codex-70b0 web tmux h1 https://web-codex-70b0-syntwin-mono.localhost",
    });

    const [web] = await createWorkCliConnector(runner, stateRoot).observe(
      target,
    );

    expect(web?.state).toBe("active");
    expect(web?.detail).toBe("running via tmux");
    expect(web?.url).toBe("https://web-codex-70b0-syntwin-mono.localhost");
  });

  it("stays silent for a worktree work-cli does not track", async () => {
    const stateRoot = await stateRootWith("/somewhere/else");
    const runner = new ScriptedRunner({
      doctor: doctorOutput,
      status: "no tracked commands",
    });

    await expect(
      createWorkCliConnector(runner, stateRoot).observe(target),
    ).resolves.toEqual([]);
  });
});

class ScriptedRunner implements CommandRunner {
  constructor(private readonly responses: { doctor: string; status: string }) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    const stdout = request.arguments?.includes("doctor")
      ? this.responses.doctor
      : this.responses.status;
    return { exitCode: 0, stdout, stderr: "" };
  }
}
