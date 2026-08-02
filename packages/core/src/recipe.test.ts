import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { plotPort, plotUrl } from "./ports";
import { readRecipe, readRecipeSource } from "./recipe";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository(recipe?: unknown): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "silvic-recipe-"));
  temporaryDirectories.push(parent);
  const root = join(parent, "syntwin-mono");
  await mkdtemp(root).catch(() => undefined);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root, { recursive: true });
  if (recipe !== undefined) {
    await writeFile(join(root, "silvic.json"), JSON.stringify(recipe));
  }
  return root;
}

describe("readRecipe", () => {
  it("gives a repository with no recipe a usable answer", async () => {
    const root = await repository();

    const recipe = await readRecipe(root);

    expect(recipe.project).toBe("syntwin-mono");
    expect(recipe.directory).toBe(resolve(root, "..", "syntwin-mono.plots"));
    expect(recipe.provision).toEqual([]);
    expect(recipe.configured).toBe(false);
  });

  it("reads commands, resources and ordered provisioning steps", async () => {
    const root = await repository({
      project: "SynTwin Mono",
      plots: { directory: "../elsewhere" },
      commands: { web: { run: "bun dev", url: true, autoStart: true } },
      resources: {
        auth: {
          provider: "workos",
          kind: "auth",
          isolation: "shared",
          dashboardUrl: "https://dashboard.workos.com/",
        },
      },
      provision: [
        { run: "bun install", label: "Install dependencies" },
        { run: "bun scripts/work-setup.ts" },
      ],
    });

    const recipe = await readRecipe(root);

    expect(recipe.project).toBe("syntwin-mono");
    expect(recipe.directory).toBe(resolve(root, "../elsewhere"));
    expect(recipe.commands["web"]).toEqual({
      run: "bun dev",
      url: true,
      autoStart: true,
    });
    expect(recipe.resources["auth"]).toEqual({
      provider: "workos",
      kind: "auth",
      isolation: "shared",
      dashboardUrl: "https://dashboard.workos.com/",
    });
    expect(recipe.provision).toHaveLength(2);
    expect(recipe.configured).toBe(true);
  });

  it("treats work-cli as a detection signal without executing its config", async () => {
    const root = await repository();
    await writeFile(join(root, "bun.lock"), "");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }),
    );
    await mkdir(join(root, "convex"));
    await writeFile(
      join(root, "work.config.js"),
      `require("node:fs").writeFileSync("work-config-ran", "bad");
      throw new Error("Silvic must not execute this");
      \n`,
    );

    const recipe = await readRecipe(root);
    const source = await readRecipeSource(root);

    expect(recipe.project).toBe("syntwin-mono");
    expect(recipe.directory).toBe(resolve(root, "..", "syntwin-mono.plots"));
    expect(recipe.provision).toEqual([
      { label: "Install dependencies", run: "bun install" },
      { convex: { name: "dev/{plot}" } },
    ]);
    expect(recipe.commands).toEqual({
      web: { run: "bun run dev", autoStart: true, url: true },
      convex: { run: "npx convex dev", autoStart: true },
    });
    expect(recipe.configured).toBe(false);
    expect(source.exists).toBe(false);
    expect(source.recipe.provision).toEqual(recipe.provision);
    expect(source.recipe.commands).toEqual(recipe.commands);
    await expect(access(join(root, "work-config-ran"))).rejects.toThrow();
  });

  it("falls back to defaults rather than failing on a malformed recipe", async () => {
    const root = await repository({ commands: { Web: { run: 42 } } });

    const recipe = await readRecipe(root);

    expect(recipe.configured).toBe(false);
    expect(recipe.project).toBe("syntwin-mono");
  });

  it("survives a recipe that is not valid JSON", async () => {
    const root = await repository();
    await writeFile(join(root, "silvic.json"), "{ not json");

    await expect(readRecipe(root)).resolves.toMatchObject({
      configured: false,
    });
  });
});

describe("plotPort", () => {
  it("gives the same plot the same port every time", () => {
    // A plot's URL gets registered with identity providers, so it must not move.
    const first = plotPort("syntwin-mono", "owner-onboarding");
    const second = plotPort("syntwin-mono", "owner-onboarding");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(3_000);
    expect(first).toBeLessThan(9_000);
  });

  it("gives different plots different ports", () => {
    const ports = new Set(
      ["a", "b", "c", "d", "e"].map((plot) => plotPort("syntwin-mono", plot)),
    );

    expect(ports.size).toBe(5);
  });

  it("walks deterministically past ports already claimed", () => {
    const natural = plotPort("syntwin-mono", "cicd");
    const avoided = plotPort("syntwin-mono", "cicd", new Set([natural]));

    expect(avoided).not.toBe(natural);
    expect(plotPort("syntwin-mono", "cicd", new Set([natural]))).toBe(avoided);
  });

  it("builds the address from the port", () => {
    expect(plotUrl(3456)).toBe("http://localhost:3456");
  });
});
