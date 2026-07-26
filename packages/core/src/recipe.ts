import { readFile } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";

import { recipeSchema, type PlotCommand, type ProvisionStep } from "@silvic/contracts";

export const recipeFileName = "silvic.json";

export interface ResolvedRecipe {
  /** Slug used in plot names, ports and URLs. */
  project: string;
  /** Absolute directory new plots are created in. */
  directory: string;
  commands: Readonly<Record<string, PlotCommand>>;
  provision: readonly ProvisionStep[];
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
    return defaults(root, fallbackProject, false);
  }

  const recipe = recipeSchema.safeParse(parsed);
  if (!recipe.success) {
    // A malformed recipe must not make the repository unusable.
    return defaults(root, fallbackProject, false);
  }

  const project = recipe.data.project
    ? slug(recipe.data.project)
    : fallbackProject;
  const configured = defaults(root, project, true);
  const directory = recipe.data.plots?.directory
    ? resolve(root, recipe.data.plots.directory)
    : configured.directory;
  return {
    project,
    directory,
    commands: recipe.data.commands ?? {},
    provision: recipe.data.provision ?? [],
    configured: true,
  };
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
    provision: [],
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
