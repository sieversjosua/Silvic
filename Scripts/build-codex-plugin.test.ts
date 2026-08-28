import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
let outputRoot: string;

beforeAll(async () => {
  outputRoot = await mkdtemp(join(tmpdir(), "silvic-plugin-release-"));
  execFileSync("pnpm", ["--filter", "@silvic/cli", "build"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  await executeFile(
    "node",
    ["Scripts/build-codex-plugin.mjs", "--output", outputRoot],
    { cwd: repositoryRoot },
  );
});

afterAll(async () => {
  await rm(outputRoot, { recursive: true, force: true });
});

it("builds a versions-equal installable marketplace artifact", async () => {
  const version = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  const archive = join(outputRoot, `Silvic-Codex-Plugin-${version}.tar.gz`);
  const listing = await executeFile("tar", ["-tzf", archive]);

  expect(listing.stdout).toContain("/.agents/plugins/marketplace.json");
  expect(listing.stdout).toContain("/plugins/silvic/.codex-plugin/plugin.json");
  expect(listing.stdout).toContain("/plugins/silvic/bin/silvic");
  expect(await readFile(`${archive}.sha256`, "utf8")).toMatch(
    new RegExp(`^[0-9a-f]{64}  Silvic-Codex-Plugin-${version}\\.tar\\.gz\\n$`),
  );
});

it("ships the complete adoption and provisioning MCP catalog", async () => {
  const bundle = await readFile(
    join(repositoryRoot, "plugins/silvic/bin/silvic.mjs"),
    "utf8",
  );

  expect(bundle).toContain('"plan_plot_adoption"');
  expect(bundle).toContain('"adopt_plot"');
  expect(bundle).toContain('"provision_plot"');
});
