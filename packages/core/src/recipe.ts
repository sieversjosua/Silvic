import { readFile, writeFile } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";

import {
  recipeSchema,
  type PlotCommand,
  type PlotResourceDefinition,
  type ProvisionStep,
  type Recipe,
} from "@silvic/contracts";

import { inspectRepository, suggestRecipe } from "./detect";

export const recipeFileName = "silvic.json";

export interface ResolvedRecipe {
  packageManager?: import("@silvic/contracts").PackageManager;
  /** Slug used in plot names, ports and URLs. */
  project: string;
  /** Absolute directory new plots are created in. */
  directory: string;
  commands: Readonly<Record<string, PlotCommand>>;
  resources: Readonly<Record<string, PlotResourceDefinition>>;
  provision: readonly ProvisionStep[];
  automaticAdoption: boolean;
  /** False when the repository has no recipe and defaults were used. */
  configured: boolean;
}

/**
 * A repository without a recipe still gets a usable answer. Defaults put plots
 * in a sibling directory named after the project, which keeps them out of the
 * repository and out of its ignore rules.
 */
export async function readRecipe(rootPath: string): Promise<ResolvedRecipe> {
  const root = normalize(rootPath);
  const fallbackProject = slug(basename(root));
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, recipeFileName), "utf8"));
  } catch {
    return inferredRecipe(root, fallbackProject);
  }

  const recipe = recipeSchema.safeParse(parsed);
  if (!recipe.success) {
    // A malformed recipe must not make the repository unusable.
    return inferredRecipe(root, fallbackProject);
  }

  return resolveRecipe(root, fallbackProject, recipe.data);
}

async function inferredRecipe(
  root: string,
  fallbackProject: string,
): Promise<ResolvedRecipe> {
  const inferred = suggestRecipe(await inspectRepository(root));
  return {
    ...resolveRecipe(root, fallbackProject, inferred),
    configured: false,
  };
}

function resolveRecipe(
  root: string,
  fallbackProject: string,
  recipe: Recipe,
): ResolvedRecipe {
  const project = recipe.project ? slug(recipe.project) : fallbackProject;
  const configured = defaults(root, project, true);
  const directory = recipe.plots?.directory
    ? resolve(root, recipe.plots.directory)
    : configured.directory;
  return {
    project,
    directory,
    ...(recipe.packageManager ? { packageManager: recipe.packageManager } : {}),
    commands: recipe.commands ?? {},
    resources: recipe.resources ?? {},
    provision: recipe.provision ?? [],
    automaticAdoption: recipe.automation?.adoptDisposablePlots ?? false,
    configured: true,
  };
}

/**
 * What the repository actually declares, without defaults folded in. Editing
 * needs this: a field the user never set must stay unset rather than being
 * written back as though it had been chosen.
 */
export async function readRecipeSource(rootPath: string): Promise<{
  path: string;
  exists: boolean;
  recipe: Recipe;
}> {
  const path = join(normalize(rootPath), recipeFileName);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const recipe = recipeSchema.safeParse(parsed);
    if (recipe.success) return { path, exists: true, recipe: recipe.data };
    return {
      path,
      exists: true,
      recipe: suggestRecipe(await inspectRepository(normalize(rootPath))),
    };
  } catch {
    return {
      path,
      exists: false,
      recipe: suggestRecipe(await inspectRepository(normalize(rootPath))),
    };
  }
}

/** Stable, diff-friendly output: a repository file a person will read. */
export function serialiseRecipe(recipe: Recipe): string {
  return `${JSON.stringify(recipe, undefined, 2)}\n`;
}

export async function writeRecipe(
  rootPath: string,
  recipe: Recipe,
): Promise<string> {
  const path = join(normalize(rootPath), recipeFileName);
  await writeFile(path, serialiseRecipe(recipeSchema.parse(recipe)), "utf8");
  return path;
}

function defaults(
  root: string,
  project: string,
  configured: boolean,
): ResolvedRecipe {
  return {
    project,
    directory: resolve(root, "..", `${project}.plots`),
    commands: {},
    resources: {},
    provision: [],
    automaticAdoption: false,
    configured,
  };
}

/** Safe for a directory name, a port hash and a URL label. */
export function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "project"
  );
}
