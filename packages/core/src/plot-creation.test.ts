import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { LocalCommandRunner } from "./command-runner";
import { EnvironmentService } from "./environment-service";
import { resolvePlotAddress } from "./plot-address";
import { plotPort } from "./ports";
import { Provisioner } from "./provisioner";
import { readRecipe } from "./recipe";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execute("git", [...args], { cwd });
}

/** The whole path a plot takes: recipe, address, worktree, provisioning. */
it("creates a plot and provisions it from the repository's recipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-plot-"));
  temporaryDirectories.push(directory);
  const repository = join(directory, "syntwin-mono");

  await git(directory, ["init", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.email", "silvic@example.com"]);
  await git(repository, ["config", "user.name", "Silvic"]);
  await writeFile(
    join(repository, "silvic.json"),
    JSON.stringify({
      plots: { directory: "../plots" },
      commands: {
        web: { run: "npm run dev", url: true, autoStart: true },
      },
      provision: [
        {
          label: "Write environment",
          run: 'printf "URL=%s\\nPLOT=%s\\n" "$SILVIC_URL" "$SILVIC_PLOT" > .env.local',
        },
      ],
    }),
  );
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "-m", "Initial"]);

  const recipe = await readRecipe(repository);
  expect(recipe.project).toBe("syntwin-mono");
  expect(recipe.directory).toBe(join(directory, "plots"));

  const plot = "owner-onboarding";
  const port = plotPort(recipe.project, plot);
  const { url } = resolvePlotAddress({
    commands: recipe.commands,
    plot,
    project: recipe.project,
    port,
  });
  const destinationPath = join(recipe.directory, plot);

  const runner = new LocalCommandRunner();
  await new EnvironmentService(runner).create({
    sourcePath: repository,
    destinationPath,
    branch: "feature/owner-onboarding",
    mode: "worktree",
  });

  const results = await new Provisioner(runner).run(recipe.provision, {
    root: destinationPath,
    sourceRoot: repository,
    project: recipe.project,
    plot,
    branch: "feature/owner-onboarding",
    url,
  });

  expect(results.map((step) => step.exitCode)).toEqual([0]);
  expect(await readFile(join(destinationPath, ".env.local"), "utf8")).toBe(
    `URL=${url}\nPLOT=${plot}\n`,
  );
  expect(url).toBe("https://web-owner-onboarding-syntwin-mono.localhost");
  // The address must be reproducible from the same inputs alone.
  expect(plotPort(recipe.project, plot)).toBe(port);
});

it("never makes a plot depend on a work-cli setup script", async () => {
  const directory = await mkdtemp(join(tmpdir(), "silvic-work-cli-plot-"));
  temporaryDirectories.push(directory);
  const repository = join(directory, "like-photo");

  await git(directory, ["init", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.email", "silvic@example.com"]);
  await git(repository, ["config", "user.name", "Silvic"]);
  await writeFile(join(repository, ".gitignore"), ".env.local\n");
  await writeFile(join(repository, "bun.lock"), "");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { dev: "next dev" } }),
  );
  await mkdir(join(repository, "convex"));
  await writeFile(join(repository, "convex", "schema.ts"), "export {};\n");
  await writeFile(
    join(repository, "work.config.js"),
    `module.exports = {
      project: "like-photo",
      worktrees: {
        dir: "../like-photo.worktrees",
        setup: "sh scripts/work-setup.sh",
      },
      commands: {
        web: { run: "npm run dev", autoStart: true, route: true },
        convex: { run: "npx convex dev", autoStart: true },
      },
    }\n`,
  );
  await git(repository, [
    "add",
    ".gitignore",
    "bun.lock",
    "package.json",
    "convex",
    "work.config.js",
  ]);
  await git(repository, ["commit", "-m", "Initial"]);

  const recipe = await readRecipe(repository);
  const plot = "catalog-preview";
  const destinationPath = join(recipe.directory, plot);
  const runner = new LocalCommandRunner();
  await new EnvironmentService(runner).create({
    sourcePath: repository,
    destinationPath,
    branch: "feature/catalog-preview",
    mode: "worktree",
  });
  expect(recipe.provision).toEqual([
    { label: "Install dependencies", run: "bun install" },
    { convex: { name: "dev/{plot}" } },
  ]);
  expect(Object.keys(recipe.commands)).toEqual(["web", "convex"]);
  expect(recipe.commands["web"]?.autoStart).toBe(true);
  expect(recipe.commands["convex"]?.autoStart).toBe(true);
});
