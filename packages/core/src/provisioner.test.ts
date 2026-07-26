import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalCommandRunner } from "./command-runner";
import {
  Provisioner,
  provisionDiagnosis,
  provisionEnvironment,
  readConvexTarget,
  remedyCommand,
} from "./provisioner";

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

  it("builds a deployment reference from the plot name", async () => {
    const root = await plotRoot();
    const source = await plotRoot();
    await writeFile(
      join(source, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:x # team: syntwin, project: mono\n",
    );

    // `echo` stands in for the convex CLI so the command itself is observable.
    const [step] = await provisioner.run(
      [{ convex: { name: "dev/{plot}" } }],
      {
        root,
        sourceRoot: source,
        project: "syntwin-mono",
        plot: "owner-onboarding",
        packageManager: "bun",
      },
    );

    expect(step?.label).toBe("Convex deployment");
    expect(step?.command).toBe(
      "bunx convex deployment create 'syntwin:mono:dev/owner-onboarding' --type dev --select",
    );
  });

  it("prefers explicit team and project over the source checkout", async () => {
    const root = await plotRoot();
    const source = await plotRoot();
    await writeFile(
      join(source, ".env.local"),
      "CONVEX_DEPLOYMENT=dev:x # team: ignored, project: ignored\n",
    );

    const [step] = await provisioner.run(
      [{ convex: { team: "chosen", project: "explicitly", name: "dev/{plot}" } }],
      { root, sourceRoot: source, project: "p", plot: "a" },
    );

    expect(step?.command).toContain("'chosen:explicitly:dev/a'");
    // No package manager set, so the neutral runner is used.
    expect(step?.command.startsWith("npx convex")).toBe(true);
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
