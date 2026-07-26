import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalCommandRunner } from "./command-runner";
import {
  Provisioner,
  provisionEnvironment,
  readConvexTarget,
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
      { onStep: (step) => seen.push(step.label) },
    );

    expect(results).toHaveLength(2);
    expect(results[1]?.exitCode).toBe(3);
    expect(results[1]?.output).toContain("boom");
    // The step after the failure never ran.
    expect(seen).toEqual(["Step 1", "Breaks"]);
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
