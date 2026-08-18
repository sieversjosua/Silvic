import { access, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

import {
  plotResourceProviderCatalog,
  type PackageManager,
  type PlotResourceDefinition,
  type PlotResourceProvider,
  type RecipeSuggestion,
  type Recipe,
  type RepositoryFindings,
} from "@silvic/contracts";

import { workosEmulateCommand } from "./workos-provisioner";
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

  const packageMetadata = await readPackageMetadata(join(root, "package.json"));
  const scripts = packageMetadata?.scripts;
  // Prefer a repository's explicit browser process over its umbrella runner.
  // The latter often starts the browser app and its sidecars together, even
  // though Silvic supervises those sidecars as separate commands.
  const devScript = ["dev:web", "web:dev", "dev", "develop", "start"].find(
    (name) => scripts?.[name],
  );
  if (devScript) findings.devScript = devScript;
  if (scripts) findings.scripts = scripts;
  if (findings.packageManager === undefined && scripts) {
    findings.packageManager = "npm";
  }
  const providers = detectProviders(
    packageMetadata?.packages ?? [],
    scripts ?? {},
  );
  if (providers.length > 0) findings.providers = providers;

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
  for (const candidate of ["workos.emulate.yaml", "workos.emulate.yml"]) {
    if (await exists(join(root, candidate))) {
      findings.workosSeed = candidate;
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
  // An opt-in suggestion is an offer, not an inference: it redirects the plot
  // away from real services, so only an explicit recipe may carry it.
  const provision = suggestedSteps(findings)
    .filter((suggestion) => !suggestion.optIn)
    .map((suggestion) => suggestion.step)
    .filter((step) => step !== undefined);
  const commands = Object.fromEntries(
    suggestedCommands(findings)
      .filter((suggestion) => !suggestion.optIn)
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
  const resources = suggestedResources(findings, commands);
  if (Object.keys(resources).length > 0) recipe.resources = resources;
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
  if (findings.providers?.includes("workos")) {
    suggestions.push({
      id: "workos",
      label: "WorkOS emulator",
      detail: "Point WORKOS_* at a plot-local emulator; no real WorkOS account",
      step: { workos: { callbackPath: "/callback" } },
      optIn: true,
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

function suggestedResources(
  findings: RepositoryFindings,
  commands: Readonly<Record<string, unknown>>,
): Record<string, PlotResourceDefinition> {
  return Object.fromEntries(
    (findings.providers ?? []).map((provider) => {
      const id = provider === "livekit" ? "agent" : provider;
      const definition = providerResource(provider);
      return [
        id,
        id in commands
          ? id === "workos"
            ? // A workos command is always the emulator, and an emulator per
              // plot is the one honest reading of `isolated` for WorkOS.
              {
                ...definition,
                isolation: "isolated" as const,
                command: id,
                detail: "A local emulator; no real WorkOS environment",
              }
            : { ...definition, command: id }
          : {
              ...definition,
              isolation: "manual" as const,
              detail: "Detected in package.json; not configured by Silvic",
            },
      ];
    }),
  );
}

function providerResource(
  provider: PlotResourceProvider,
): PlotResourceDefinition {
  const { kind, isolation } = plotResourceProviderCatalog[provider];
  return { provider, kind, isolation };
}

function providerCommand(
  provider: PlotResourceProvider,
  findings: RepositoryFindings,
): readonly [string, string] | undefined {
  const scripts = Object.entries(findings.scripts ?? {});
  const matches = (name: string, run: string, terms: readonly string[]) => {
    const value = `${name} ${run}`.toLowerCase();
    return terms.some((term) => value.includes(term));
  };
  if (provider === "livekit") {
    const entry = scripts.find(([name, run]) =>
      matches(name, run, ["livekit", "agent:dev"]),
    );
    return entry ? ["agent", entry[0]] : undefined;
  }
  if (provider === "stripe") {
    const entry = scripts.find(([name, run]) =>
      matches(name, run, ["stripe:listen", "stripe listen"]),
    );
    return entry ? ["stripe", entry[0]] : undefined;
  }
  if (provider === "cloudflare") {
    const entry = scripts.find(([name, run]) =>
      matches(name, run, ["wrangler dev", "cloudflare:dev"]),
    );
    return entry ? ["cloudflare", entry[0]] : undefined;
  }
  if (provider === "workos") {
    const entry = scripts.find(([name, run]) =>
      matches(name, run, [
        "workos-emulate",
        "@workos/emulate",
        "workos:emulate",
      ]),
    );
    return entry ? ["workos", entry[0]] : undefined;
  }
  return undefined;
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
  for (const provider of findings.providers ?? []) {
    const candidate = providerCommand(provider, findings);
    if (!candidate) continue;
    const [id, script] = candidate;
    if (suggestions.some((suggestion) => suggestion.command?.id === id))
      continue;
    suggestions.push({
      id: `provider:${provider}`,
      label: id,
      detail: runScript(manager, script),
      command: {
        id,
        command: { run: runScript(manager, script), autoStart: true },
      },
    });
  }
  // A repository with no emulator script of its own is still offered one, in
  // Silvic's words — but only as an offer: taking it points the plot at a
  // local emulator instead of the real WorkOS environment.
  if (
    findings.providers?.includes("workos") &&
    !suggestions.some((suggestion) => suggestion.command?.id === "workos")
  ) {
    const run = workosEmulateCommand(findings.workosSeed);
    suggestions.push({
      id: "provider:workos",
      label: "workos",
      detail: run,
      command: { id: "workos", command: { run, autoStart: true } },
      optIn: true,
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

async function readPackageMetadata(path: string): Promise<
  | {
      scripts?: Record<string, string>;
      packages: readonly string[];
    }
  | undefined
> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    const scripts = stringRecord(value.scripts);
    const packages = [
      ...Object.keys(stringRecord(value.dependencies) ?? {}),
      ...Object.keys(stringRecord(value.devDependencies) ?? {}),
    ];
    return { ...(scripts ? { scripts } : {}), packages };
  } catch {
    // A repository without a readable package.json simply tells us less.
  }
  return undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value);
  if (!entries.every(([, item]) => typeof item === "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function detectProviders(
  packages: readonly string[],
  scripts: Readonly<Record<string, string>>,
): readonly PlotResourceProvider[] {
  const evidence = `${packages.join(" ")} ${Object.entries(scripts)
    .flat()
    .join(" ")}`.toLowerCase();
  const candidates: ReadonlyArray<
    readonly [PlotResourceProvider, readonly string[]]
  > = [
    ["livekit", ["@livekit/", "livekit-"]],
    ["stripe", ["stripe"]],
    ["cloudflare", ["wrangler", "@cloudflare/"]],
    ["vercel", ["vercel", "@vercel/"]],
    ["clerk", ["@clerk/"]],
    ["workos", ["@workos-inc/", "workos"]],
  ];
  return candidates
    .filter(([, terms]) => terms.some((term) => evidence.includes(term)))
    .map(([provider]) => provider);
}
