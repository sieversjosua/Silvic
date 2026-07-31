import { access, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

import type {
  PackageManager,
  RecipeSuggestion,
  Recipe,
  RepositoryFindings,
} from "@silvic/contracts";

const lockfiles: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * What a repository already tells us about itself. This exists so the recipe
 * editor never opens on a blank page: most projects can be described well
 * enough to start from, and the user edits rather than invents.
 */
export async function inspectRepository(
  rootPath: string,
): Promise<RepositoryFindings> {
  const root = normalize(rootPath);
  const findings: RepositoryFindings = { convex: false, workConfig: false };

  for (const [file, manager] of lockfiles) {
    if (await exists(join(root, file))) {
      findings.packageManager = manager;
      break;
    }
  }

  const scripts = await readScripts(join(root, "package.json"));
  const devScript = ["dev", "develop", "start"].find((name) => scripts?.[name]);
  if (devScript) findings.devScript = devScript;
  if (scripts) findings.scripts = scripts;
  if (findings.packageManager === undefined && scripts) {
    findings.packageManager = "npm";
  }

  findings.convex =
    (await exists(join(root, "convex"))) ||
    (await exists(join(root, "convex.json")));
  findings.workConfig =
    (await exists(join(root, "work.config.js"))) ||
    (await exists(join(root, "work.config.ts")));
  for (const candidate of [
    ".env.example",
    ".env.local.example",
    ".env.sample",
  ]) {
    if (await exists(join(root, candidate))) {
      findings.envExample = candidate;
      break;
    }
  }
  return findings;
}

/**
 * A starting point, not an answer. Everything suggested is ordinary recipe
 * content the user can edit or delete before saving.
 */
export function suggestRecipe(findings: RepositoryFindings): Recipe {
  const provision = suggestedSteps(findings)
    .map((suggestion) => suggestion.step)
    .filter((step) => step !== undefined);
  const commands = Object.fromEntries(
    suggestedCommands(findings)
      .filter((suggestion) => suggestion.command !== undefined)
      .map((suggestion) => [
        suggestion.command!.id,
        suggestion.command!.command,
      ]),
  );

  const recipe: Recipe = {};
  if (findings.packageManager) recipe.packageManager = findings.packageManager;
  if (provision.length > 0) recipe.provision = provision;
  if (Object.keys(commands).length > 0) recipe.commands = commands;
  return recipe;
}

/** How a package manager is asked to run one of a repository's own scripts. */
function runScript(
  manager: PackageManager | undefined,
  script: string,
): string {
  return manager === "npm" || manager === undefined
    ? `npm run ${script}`
    : `${manager} run ${script}`;
}

/**
 * What usually belongs in this repository's provisioning, in its own words:
 * its package manager, its scripts, the tools it actually uses. Offering a
 * blank field instead would be asking the user to tell Silvic what Silvic has
 * already read.
 */
export function suggestedSteps(
  findings: RepositoryFindings,
): readonly RecipeSuggestion[] {
  const manager = findings.packageManager;
  const suggestions: RecipeSuggestion[] = [];

  if (manager) {
    suggestions.push({
      id: "install",
      label: "Install dependencies",
      detail: `${manager} install`,
      step: { label: "Install dependencies", run: `${manager} install` },
    });
  }
  if (findings.envExample) {
    const run = `cp "$SILVIC_SOURCE_ROOT/.env.local" .env.local 2>/dev/null || cp ${findings.envExample} .env.local`;
    suggestions.push({
      id: "environment",
      label: "Environment file",
      detail: `From the source checkout, or ${findings.envExample}`,
      step: { label: "Environment file", run },
    });
  }
  if (findings.convex) {
    suggestions.push({
      id: "convex",
      label: "Convex deployment",
      detail: "A deployment of its own, named after the plot",
      step: { convex: { name: "dev/{plot}" } },
    });
  }
  for (const [name, script] of scriptsMatching(findings, [
    "codegen",
    "generate",
    "build",
    "migrate",
    "db:migrate",
    "db:push",
  ])) {
    suggestions.push({
      id: `script:${name}`,
      label: sentence(name),
      detail: script,
      step: { label: sentence(name), run: runScript(manager, name) },
    });
  }
  return suggestions;
}

/** The same reading, for the things that run for as long as you work. */
export function suggestedCommands(
  findings: RepositoryFindings,
): readonly RecipeSuggestion[] {
  const manager = findings.packageManager;
  const suggestions: RecipeSuggestion[] = [];

  if (findings.devScript) {
    suggestions.push({
      id: "web",
      label: "web",
      detail: runScript(manager, findings.devScript),
      command: {
        id: "web",
        command: {
          run: runScript(manager, findings.devScript),
          url: true,
          autoStart: true,
        },
      },
    });
  }
  if (findings.convex) {
    suggestions.push({
      id: "convex",
      label: "convex",
      detail: "npx convex dev",
      command: {
        id: "convex",
        command: { run: "npx convex dev", autoStart: true },
      },
    });
  }
  for (const [name, script] of scriptsMatching(findings, [
    "test:watch",
    "storybook",
    "typecheck:watch",
  ])) {
    suggestions.push({
      id: `script:${name}`,
      label: name.replace(/:.*$/, ""),
      detail: script,
      command: {
        id: name.replace(/[^a-z0-9-]/g, "-"),
        command: { run: runScript(manager, name) },
      },
    });
  }
  return suggestions;
}

function scriptsMatching(
  findings: RepositoryFindings,
  names: readonly string[],
): ReadonlyArray<readonly [string, string]> {
  const scripts = findings.scripts ?? {};
  return names
    .filter((name) => scripts[name])
    .map((name) => [name, scripts[name] ?? ""] as const);
}

/** `db:migrate` reads as a label when it is given back as a sentence. */
function sentence(script: string): string {
  const words = script.replace(/[:_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readScripts(
  path: string,
): Promise<Record<string, string> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "scripts" in parsed &&
      typeof parsed.scripts === "object" &&
      parsed.scripts !== null
    ) {
      return parsed.scripts as Record<string, string>;
    }
  } catch {
    // A repository without a readable package.json simply tells us less.
  }
  return undefined;
}
