import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalCommandRunner,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "./command-runner";
import {
  Provisioner,
  provisionCompleted,
  provisionDiagnosis,
  remedyCommand,
} from "./provisioner";
import { readConvexTarget } from "./convex-provisioner";
import { provisionEnvironment } from "./provision-environment";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function plotRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "silvic-provision-"));
  temporaryDirectories.push(root);
  return root;
}

const context = (root: string) => ({
  root,
  sourceRoot: "/repos/syntwin-mono",
  project: "syntwin-mono",
  plot: "owner-onboarding",
  branch: "feature/owner-onboarding",
  url: "http://localhost:3456",
});

describe("provisionEnvironment", () => {
  it("also emits the work-cli names so existing hooks keep working", () => {
    const environment = provisionEnvironment(context("/plots/onboarding"));

    expect(environment["SILVIC_ROOT"]).toBe("/plots/onboarding");
    expect(environment["SILVIC_PLOT"]).toBe("owner-onboarding");
    // scripts/work-setup.ts reads these exact names.
    expect(environment["WORK_ROOT"]).toBe("/plots/onboarding");
    expect(environment["WORK_WORKSPACE"]).toBe("owner-onboarding");
    expect(environment["WORK_SOURCE_ROOT"]).toBe("/repos/syntwin-mono");
    expect(environment["WORK_URL"]).toBe("http://localhost:3456");
    expect(environment["WORK_WEB_URL"]).toBe("http://localhost:3456");
    expect(environment["WORK_BRANCH"]).toBe("feature/owner-onboarding");
    expect(environment["HOST"]).toBe("localhost");
  });

  it("omits values that are not known rather than sending blanks", () => {
    const environment = provisionEnvironment({
      root: "/plots/x",
      sourceRoot: "/repos/x",
      project: "x",
      plot: "x",
    });

    expect(environment["WORK_URL"]).toBeUndefined();
    expect(environment["WORK_BRANCH"]).toBeUndefined();
    expect(environment["SILVIC_WORKOS_PORT"]).toBeUndefined();
  });

  it("publishes where a WorkOS emulator would listen once the port is known", () => {
    const environment = provisionEnvironment({
      ...context("/plots/onboarding"),
      port: 3456,
    });

    expect(environment["SILVIC_WORKOS_PORT"]).toBe("23456");
  });
});

describe("Provisioner", () => {
  const provisioner = new Provisioner(new LocalCommandRunner());

  it("runs steps in order, in the plot, with the contract available", async () => {
    const root = await plotRoot();

    const results = await provisioner.run(
      [
        { run: "echo first > order.txt", label: "First" },
        { run: "echo second >> order.txt" },
        { run: 'printf "%s|%s" "$WORK_WORKSPACE" "$SILVIC_URL" > env.txt' },
      ],
      context(root),
    );

    expect(results.map((step) => step.exitCode)).toEqual([0, 0, 0]);
    expect(results[0]?.label).toBe("First");
    expect(results[1]?.label).toBe("Step 2");
    expect(await readFile(join(root, "order.txt"), "utf8")).toBe(
      "first\nsecond\n",
    );
    expect(await readFile(join(root, "env.txt"), "utf8")).toBe(
      "owner-onboarding|http://localhost:3456",
    );
  });

  it("stops at the first failure and reports which step it was", async () => {
    const root = await plotRoot();
    const seen: string[] = [];

    const results = await provisioner.run(
      [
        { run: "echo ok" },
        { run: "echo boom >&2; exit 3", label: "Breaks" },
        { run: "touch should-not-exist" },
      ],
      context(root),
      { onStep: (step, index) => seen.push(`${index}:${step.label}`) },
    );

    expect(results).toHaveLength(2);
    expect(results[1]?.exitCode).toBe(3);
    expect(results[1]?.output).toContain("boom");
    // The step after the failure never ran.
    expect(seen).toEqual(["0:Step 1", "1:Breaks"]);
    await expect(
      readFile(join(root, "should-not-exist"), "utf8"),
    ).rejects.toThrow();
  });

  it("reports each step as it finishes rather than only at the end", async () => {
    const root = await plotRoot();
    const seen: number[] = [];

    await provisioner.run(
      [{ run: "true" }, { run: "true" }, { run: "true" }],
      context(root),
      { onStep: (step) => seen.push(step.exitCode) },
    );

    expect(seen).toEqual([0, 0, 0]);
  });

  it("reports a step starting, its output, then its result", async () => {
    const root = await plotRoot();
    const events: string[] = [];

    await provisioner.run(
      [
        { run: "echo installing; echo warning >&2", label: "Install" },
        { run: "true", label: "Build" },
      ],
      context(root),
      {
        onStepStart: ({ index, command }) =>
          events.push(`start ${index} ${command}`),
        onStepOutput: ({ index, chunk }) =>
          events.push(`output ${index} ${chunk.trim()}`),
        onStep: (result, index) => events.push(`done ${index} ${result.label}`),
      },
    );

    // A step announces itself before it can print anything, and the result is
    // only reported once its output has been seen.
    expect(events[0]).toBe("start 0 echo installing; echo warning >&2");
    expect(events.slice(1, 3).sort()).toEqual([
      "output 0 installing",
      "output 0 warning",
    ]);
    expect(events.slice(3)).toEqual([
      "done 0 Install",
      "start 1 true",
      "done 1 Build",
    ]);
  });

  it("explains a Convex CLI too old for a deployment per plot, and offers the fix", () => {
    const diagnosis = provisionDiagnosis(
      { convex: { name: "dev/{plot}" } },
      "error: unknown command 'deployment'\n\nUsage: convex <command> [options]",
    );

    expect(diagnosis?.advice).toContain("convex 1.40");
    expect(diagnosis?.remedy?.id).toBe("convex-cli");
  });

  it("has nothing to add to a failure it does not recognise", () => {
    expect(
      provisionDiagnosis(
        { convex: { name: "dev/{plot}" } },
        "network unreachable",
      ),
    ).toBeUndefined();
    // A shell step is the repository's own command, not one Silvic wrote.
    expect(
      provisionDiagnosis({ run: "npm ci" }, "unknown command 'deployment'"),
    ).toBeUndefined();
  });

  it("repairs with the package manager the repository uses", () => {
    expect(remedyCommand("convex-cli", "pnpm")).toBe("pnpm add convex@1.40");
    expect(remedyCommand("convex-cli", "bun")).toBe("bun add convex@1.40");
    expect(remedyCommand("convex-cli", "yarn")).toBe("yarn add convex@1.40");
    // npm is the assumption when a repository has not said otherwise.
    expect(remedyCommand("convex-cli", undefined)).toBe(
      "npm install convex@1.40",
    );
  });

  it("asks for the version that gained the feature, never the newest", () => {
    // Reaching for @latest breaks a repository whose other packages peer-depend
    // on a Convex range: the CLI updates and nothing installs afterwards.
    expect(remedyCommand("convex-cli", "npm")).not.toContain("latest");
    // 1.40 is the first that accepts `team:project:ref`, which a plot needs:
    // it has no .env.local naming the project.
    expect(remedyCommand("convex-cli", "npm")).toContain("@1.40");
  });

  it("explains a CLI that cannot find the project a plot belongs to", () => {
    const diagnosis = provisionDiagnosis(
      { convex: { name: "dev/{plot}" } },
      "- Creating dev deployment...\n✖ No project configured. Run `npx convex dev` to set up a project",
    );

    expect(diagnosis?.advice).toContain("1.40");
    expect(diagnosis?.remedy?.id).toBe("convex-cli");
  });

  it("names the package that pins Convex when the install is refused", () => {
    const diagnosis = provisionDiagnosis(
      { run: "npm install" },
      [
        "npm error code ERESOLVE",
        "npm error While resolving: @convex-dev/workflow@0.2.6",
        'npm error   peer convex@">=1.25.0 <1.35.0" from @convex-dev/workflow@0.2.6',
      ].join("\n"),
    );

    expect(diagnosis?.advice).toContain("@convex-dev/workflow@0.2.6");
    // Silvic cannot pick another project's dependency versions for it.
    expect(diagnosis?.remedy).toBeUndefined();
  });

  it("does nothing when a repository declares no provisioning", async () => {
    const root = await plotRoot();

    await expect(provisioner.run([], context(root))).resolves.toEqual([]);
  });
});

describe("provisionCompleted", () => {
  it("only hands a plot to runtimes after every declared step succeeded", () => {
    const steps = [{ run: "install" }, { run: "configure" }];
    const success = (label: string) => ({
      label,
      command: label,
      exitCode: 0,
      output: "",
      durationMs: 1,
    });

    expect(provisionCompleted(steps, [success("install")])).toBe(false);
    expect(
      provisionCompleted(steps, [
        success("install"),
        { ...success("configure"), exitCode: 1 },
      ]),
    ).toBe(false);
    expect(
      provisionCompleted(steps, [success("install"), success("configure")]),
    ).toBe(true);
  });
});

describe("Convex provisioning step", () => {
  const provisioner = new Provisioner(new LocalCommandRunner());

  it("reads the team and project from the source checkout", async () => {
    const source = await plotRoot();
    await writeFile(
      join(source, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:brazen-labrador-831 # team: syntwin, project: mono\n",
    );

    await expect(readConvexTarget(source)).resolves.toEqual({
      team: "syntwin",
      project: "mono",
    });
  });

  it("prefers the selected checkout and falls back to the project root", async () => {
    const selected = await plotRoot();
    const projectRoot = await plotRoot();
    const configuredCheckout = await plotRoot();
    await writeFile(
      join(selected, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:selected # team: selected-team, project: selected-project\n",
    );
    await writeFile(
      join(projectRoot, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:primary # team: primary-team, project: primary-project\n",
    );

    await expect(readConvexTarget(selected, [projectRoot])).resolves.toEqual({
      team: "selected-team",
      project: "selected-project",
    });
    await rm(join(selected, ".env.local"));
    await expect(readConvexTarget(selected, [projectRoot])).resolves.toEqual({
      team: "primary-team",
      project: "primary-project",
    });
    await rm(join(projectRoot, ".env.local"));
    await writeFile(
      join(configuredCheckout, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:other # team: checkout-team, project: checkout-project\n",
    );
    await expect(
      readConvexTarget(selected, [projectRoot, configuredCheckout]),
    ).resolves.toEqual({
      team: "checkout-team",
      project: "checkout-project",
    });
  });

  it("skips an incomplete selected deployment and uses a configured fallback", async () => {
    const selected = await plotRoot();
    const configuredCheckout = await plotRoot();
    await writeFile(
      join(selected, ".env.local"),
      [
        "CONVEX_DEPLOYMENT=dev:missing-metadata",
        "SELECTED_LOCAL=kept",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(configuredCheckout, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:ready # team: fallback-team, project: fallback-project\n",
    );

    await expect(
      readConvexTarget(selected, [configuredCheckout]),
    ).resolves.toEqual({
      team: "fallback-team",
      project: "fallback-project",
    });
  });

  it("owns the complete isolated deployment lifecycle", async () => {
    const root = await plotRoot();
    const source = await plotRoot();
    const configuredSource = await plotRoot();
    await writeFile(
      join(source, ".env.local"),
      "SELECTED_LOCAL=kept-from-selected-checkout\n",
    );
    await writeFile(
      join(configuredSource, ".env.local"),
      [
        "CONVEX_DEPLOYMENT=dev:x # team: syntwin, project: mono",
        "NEXT_PUBLIC_CONVEX_URL=https://source.convex.cloud",
        "LOCAL_ONLY=kept",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, ".env.local"),
      "INCOMPLETE_SETUP=must-not-survive\n",
    );
    const runner = new ConvexLifecycleRunner(root);
    const nativeProvisioner = new Provisioner(runner);

    const [step] = await nativeProvisioner.run(
      [
        {
          convex: {
            name: "dev/{plot}",
            expiration: "in 7 days",
          },
        },
      ],
      {
        root,
        sourceRoot: source,
        sourceFallbackRoots: [configuredSource],
        project: "syntwin-mono",
        plot: "owner-onboarding",
        packageManager: "bun",
        url: "http://localhost:3456",
      },
    );

    expect(step?.label).toBe("Convex deployment");
    expect(step?.command).toBe("Silvic isolated Convex environment");
    expect(step?.exitCode).toBe(0);
    expect(runner.commands()).toEqual([
      "env list",
      "deployment create syntwin:mono:dev/owner-onboarding --type dev --select --expiration in 7 days",
      "deployment token create silvic-owner-onboarding --save-env",
      expect.stringMatching(/^env set --force --from-file /),
      "dev --once",
    ]);

    const local = await readFile(join(root, ".env.local"), "utf8");
    expect(local).toContain("LOCAL_ONLY=kept");
    expect(local).toContain("SELECTED_LOCAL=kept-from-selected-checkout");
    expect(local).not.toContain("INCOMPLETE_SETUP");
    expect(local).toContain(
      "CONVEX_DEPLOYMENT=dev:isolated # team: syntwin, project: mono",
    );
    expect(local).toContain("CONVEX_DEPLOY_KEY=present-but-secret");
    expect(local).toContain(
      "NEXT_PUBLIC_CONVEX_URL=https://isolated.convex.cloud",
    );
    expect(local).toContain(
      "NEXT_PUBLIC_CONVEX_SITE_URL=https://isolated.convex.site",
    );
    expect(local).toContain("CONVEX_SITE_URL=https://isolated.convex.site");
    expect(local).toContain("NEXT_PUBLIC_APP_URL=http://localhost:3456");
    expect(local).toContain("NEXT_PUBLIC_SITE_URL=http://localhost:3456");
    expect(local).not.toContain("https://source.convex.cloud");

    expect(runner.serverEnvironment).toContain("SERVER_SECRET=source-secret");
    expect(runner.serverEnvironment).toContain(
      "NEXT_PUBLIC_CONVEX_URL=https://isolated.convex.cloud",
    );
    expect(runner.serverEnvironment).toContain(
      "CONVEX_SITE_URL=https://isolated.convex.site",
    );
    expect(runner.serverEnvironment).toContain(
      "NEXT_PUBLIC_APP_URL=http://localhost:3456",
    );
    expect(runner.serverEnvironment).not.toContain("SOURCE_DEPLOYMENT_VALUE");
    expect(step?.output).not.toContain("source-secret");
    expect(step?.output).not.toContain("present-but-secret");
    expect(step?.output).toContain(
      "Using Silvic Convex CLI 1.42.3; the repository dependency stays unchanged",
    );
    expect(step?.output).toContain("A newer version of Convex is available");
  });

  it("resumes an interrupted native setup without creating another deployment or key", async () => {
    const root = await plotRoot();
    const source = await plotRoot();
    await writeFile(
      join(source, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:x # team: syntwin, project: mono\n",
    );
    await writeFile(
      join(root, ".env.local"),
      [
        "CONVEX_DEPLOYMENT=dev:isolated # team: syntwin, project: mono",
        "CONVEX_DEPLOY_KEY=already-scoped",
        "NEXT_PUBLIC_CONVEX_URL=https://isolated.convex.cloud",
        "",
      ].join("\n"),
    );
    const runner = new ConvexLifecycleRunner(root);

    const [step] = await new Provisioner(runner).run(
      [{ convex: { name: "dev/{plot}" } }],
      {
        root,
        sourceRoot: source,
        project: "syntwin-mono",
        plot: "owner-onboarding",
      },
    );

    expect(step?.exitCode).toBe(0);
    expect(runner.commands()).toEqual([
      "env list",
      expect.stringMatching(/^env set --force --from-file /),
      "dev --once",
    ]);
  });

  it("prefers explicit team and project over the source checkout", async () => {
    const root = await plotRoot();
    const source = await plotRoot();
    await writeFile(
      join(source, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:x # team: ignored, project: ignored\n",
    );

    const runner = new ConvexLifecycleRunner(root);
    const [step] = await new Provisioner(runner).run(
      [
        {
          convex: { team: "chosen", project: "explicitly", name: "dev/{plot}" },
        },
      ],
      { root, sourceRoot: source, project: "p", plot: "a" },
    );

    expect(step?.exitCode).toBe(0);
    expect(runner.commands()).toContain(
      "deployment create chosen:explicitly:dev/a --type dev --select",
    );
  });

  it("fails clearly when there is no Convex target to be found", async () => {
    const root = await plotRoot();
    const source = await plotRoot();

    await expect(
      provisioner.run([{ convex: { name: "dev/{plot}" } }], {
        root,
        sourceRoot: source,
        project: "p",
        plot: "a",
      }),
    ).rejects.toThrow(/no Convex team and project/i);
  });
});

class ConvexLifecycleRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  serverEnvironment = "";

  constructor(private readonly root: string) {}

  commands(): string[] {
    return this.requests.map((request) =>
      (request.arguments ?? []).slice(2).join(" "),
    );
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const command = (request.arguments ?? []).slice(2);
    if (command[0] === "env" && command[1] === "list") {
      return success(
        [
          "SERVER_SECRET=source-secret",
          "CONVEX_DEPLOYMENT=SOURCE_DEPLOYMENT_VALUE",
          "NEXT_PUBLIC_CONVEX_URL=https://source.convex.cloud",
          "",
        ].join("\n"),
      );
    }
    if (command[0] === "deployment" && command[1] === "create") {
      const existing = await readFile(join(this.root, ".env.local"), "utf8");
      await writeFile(
        join(this.root, ".env.local"),
        `${existing}CONVEX_DEPLOYMENT=dev:isolated # team: syntwin, project: mono\nNEXT_PUBLIC_CONVEX_URL=https://isolated.convex.cloud\n`,
      );
      return success("Deployment isolated created\n");
    }
    if (
      command[0] === "deployment" &&
      command[1] === "token" &&
      command[2] === "create"
    ) {
      const existing = await readFile(join(this.root, ".env.local"), "utf8");
      await writeFile(
        join(this.root, ".env.local"),
        `${existing}CONVEX_DEPLOY_KEY=present-but-secret\n`,
      );
      return success("Saved deploy key\n");
    }
    if (command[0] === "env" && command[1] === "set") {
      const file = command.at(-1);
      if (!file) return failure("Missing env file");
      this.serverEnvironment = await readFile(file, "utf8");
      return success("Environment variables updated\n");
    }
    if (command[0] === "dev" && command[1] === "--once") {
      return {
        exitCode: 0,
        stdout: "Convex functions ready\n",
        stderr: "A newer version of Convex is available\n",
      };
    }
    return failure(`Unexpected command: ${command.join(" ")}`);
  }
}

function success(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string): CommandResult {
  return { exitCode: 1, stdout: "", stderr };
}
