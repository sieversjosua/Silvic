import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isConvexStep } from "@silvic/contracts";

import { inspectRepository, suggestRecipe } from "./detect";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function repository(
  files: Readonly<Record<string, string>>,
  directories: readonly string[] = [],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "silvic-detect-"));
  temporaryDirectories.push(root);
  for (const directory of directories) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }
  return root;
}

describe("inspectRepository", () => {
  it("recognises provider SDKs that belong in the Plot inspector", async () => {
    const root = await repository({
      "package.json": JSON.stringify({
        scripts: {
          dev: "next dev",
          "agent:dev": "tsx src/livekit-agent.ts dev",
          "stripe:listen":
            "stripe listen --forward-to localhost:3000/api/stripe",
        },
        dependencies: {
          "@clerk/nextjs": "latest",
          "@livekit/agents": "latest",
          "@workos-inc/authkit-nextjs": "latest",
          stripe: "latest",
        },
        devDependencies: { wrangler: "latest", vercel: "latest" },
      }),
    });

    const findings = await inspectRepository(root);

    expect(findings.providers).toEqual([
      "livekit",
      "stripe",
      "cloudflare",
      "vercel",
      "clerk",
      "workos",
    ]);
    expect(suggestRecipe(findings).commands).toMatchObject({
      agent: { run: "npm run agent:dev", autoStart: true },
      stripe: { run: "npm run stripe:listen", autoStart: true },
    });
    expect(suggestRecipe(findings).resources).toMatchObject({
      agent: { provider: "livekit", kind: "agent", command: "agent" },
      stripe: {
        provider: "stripe",
        kind: "payments",
        command: "stripe",
      },
      clerk: {
        provider: "clerk",
        kind: "auth",
        isolation: "manual",
        detail: "Detected in package.json; not configured by Silvic",
      },
      workos: {
        provider: "workos",
        kind: "auth",
        isolation: "manual",
      },
    });
  });

  it("reads the package manager from the lockfile, not the scripts", async () => {
    const root = await repository({
      "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
      "pnpm-lock.yaml": "",
    });

    await expect(inspectRepository(root)).resolves.toMatchObject({
      packageManager: "pnpm",
      devScript: "dev",
    });
  });

  it("assumes npm when there is a package.json but no lockfile", async () => {
    const root = await repository({
      "package.json": JSON.stringify({ scripts: { start: "node ." } }),
    });

    await expect(inspectRepository(root)).resolves.toMatchObject({
      packageManager: "npm",
      devScript: "start",
    });
  });

  it("notices Convex, an existing work-cli config and an env example", async () => {
    const root = await repository(
      { "work.config.js": "export default {}", ".env.example": "KEY=" },
      ["convex"],
    );

    await expect(inspectRepository(root)).resolves.toMatchObject({
      convex: true,
      workConfig: true,
      envExample: ".env.example",
    });
  });

  it("says little about a repository that says little", async () => {
    const root = await repository({ "README.md": "# nothing" });

    const findings = await inspectRepository(root);

    expect(findings.packageManager).toBeUndefined();
    expect(findings.devScript).toBeUndefined();
    expect(findings.convex).toBe(false);
  });
});

describe("suggestRecipe", () => {
  it("proposes install, environment and a Convex deployment", () => {
    const recipe = suggestRecipe({
      packageManager: "bun",
      devScript: "dev",
      convex: true,
      workConfig: true,
      envExample: ".env.example",
    });

    expect(recipe.packageManager).toBe("bun");
    expect(recipe.commands?.["web"]?.run).toBe("bun run dev");
    expect(recipe.provision).toHaveLength(3);
    expect(recipe.provision?.some(isConvexStep)).toBe(true);
  });

  it("proposes nothing it has no evidence for", () => {
    const recipe = suggestRecipe({ convex: false, workConfig: false });

    expect(recipe.provision).toBeUndefined();
    expect(recipe.commands).toBeUndefined();
    expect(recipe.packageManager).toBeUndefined();
  });

  it("leaves out Convex when the repository has none", () => {
    const recipe = suggestRecipe({
      packageManager: "pnpm",
      devScript: "dev",
      convex: false,
      workConfig: false,
    });

    expect(recipe.provision?.some(isConvexStep)).toBe(false);
  });
});
