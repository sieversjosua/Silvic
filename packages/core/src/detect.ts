import { access, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

import type {
  PackageManager,
  ProvisionStep,
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
  if (findings.packageManager === undefined && scripts) {
    findings.packageManager = "npm";
  }

  findings.convex =
    (await exists(join(root, "convex"))) ||
    (await exists(join(root, "convex.json")));
  findings.workConfig =
    (await exists(join(root, "work.config.js"))) ||
    (await exists(join(root, "work.config.ts")));
  for (const candidate of [".env.example", ".env.local.example", ".env.sample"]) {
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
  const manager = findings.packageManager;
  const provision: ProvisionStep[] = [];

  if (manager) {
    provision.push({
      label: "Install dependencies",
      run: `${manager} install`,
    });
  }
  if (findings.envExample) {
    provision.push({
      label: "Environment file",
      run: `cp "$SILVIC_SOURCE_ROOT/.env.local" .env.local 2>/dev/null || cp ${findings.envExample} .env.local`,
    });
  }
  if (findings.convex) {
    provision.push({ convex: { name: "dev/{plot}" } });
  }

  const recipe: Recipe = {};
  if (manager) recipe.packageManager = manager;
  if (provision.length > 0) recipe.provision = provision;
  if (findings.devScript && manager) {
    recipe.commands = {
      web: {
        run:
          manager === "npm"
            ? `npm run ${findings.devScript}`
            : `${manager} run ${findings.devScript}`,
        url: true,
        autoStart: true,
      },
    };
  }
  return recipe;
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
