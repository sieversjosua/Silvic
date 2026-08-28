import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, it } from "vitest";

import { requiredMcpTools } from "./release-contract.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
let outputRoot: string;
let appPath: string;

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
  appPath = join(outputRoot, "Silvic.app");
  await mkdir(join(appPath, "Contents/MacOS"), { recursive: true });
  await mkdir(join(appPath, "Contents/Resources/bin"), { recursive: true });
  await mkdir(join(appPath, "Contents/Resources/lib"), { recursive: true });
  await symlink(process.execPath, join(appPath, "Contents/MacOS/Silvic"));
  await cp(
    join(repositoryRoot, "apps/cli/bin/silvic"),
    join(appPath, "Contents/Resources/bin/silvic"),
  );
  await cp(
    join(repositoryRoot, "apps/cli/dist/silvic.mjs"),
    join(appPath, "Contents/Resources/lib/silvic.mjs"),
  );
  await mkdir(join(appPath, "Contents/Resources/codex-marketplace"), {
    recursive: true,
  });
  await cp(
    join(repositoryRoot, ".agents"),
    join(appPath, "Contents/Resources/codex-marketplace/.agents"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "plugins"),
    join(appPath, "Contents/Resources/codex-marketplace/plugins"),
    { recursive: true },
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

  const extracted = join(
    outputRoot,
    "codex-plugin",
    `Silvic-Codex-Plugin-${version}`,
  );
  const marketplace = JSON.parse(
    await readFile(join(extracted, ".agents/plugins/marketplace.json"), "utf8"),
  );
  const instructions = await readFile(join(extracted, "INSTALL.md"), "utf8");
  expect(marketplace.name).toBe("silvic");
  expect(instructions).toContain("codex plugin add silvic@silvic");
  expect(
    instructions.indexOf("codex plugin marketplace list --json"),
  ).toBeLessThan(instructions.indexOf("codex plugin marketplace add"));
  expect(instructions).toContain("codex plugin marketplace remove silvic");
  expect(instructions).not.toContain(`silvic-${version.replaceAll(".", "-")}`);
  expect(instructions).not.toContain("remove only that entry");
});

it("uses the shared release contract for exact tag parity", async () => {
  const version = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  await expect(
    executeFile(
      "node",
      ["Scripts/validate-codex-plugin.mjs", "--tag", `v${version}`],
      { cwd: repositoryRoot },
    ),
  ).resolves.toMatchObject({ stdout: expect.stringContaining(version) });
  await expect(
    executeFile(
      "node",
      ["Scripts/validate-codex-plugin.mjs", "--tag", "v9.9.9"],
      { cwd: repositoryRoot },
    ),
  ).rejects.toThrow(`does not match v${version}`);
});

it("runs the deterministic app fixture and extracted plugin MCP without Node", async () => {
  const version = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  ).version;
  const result = await executeFile(
    "node",
    [
      "Scripts/verify-packaged-distribution.mjs",
      "--app",
      appPath,
      "--plugin-archive",
      join(outputRoot, `Silvic-Codex-Plugin-${version}.tar.gz`),
    ],
    { cwd: repositoryRoot },
  );

  expect(result.stdout).toContain(
    `Silvic ${version} packaged CLI, symlink, signed marketplace source, extracted plugin, MCP initialize, and ${requiredMcpTools.length} tools passed without Node on PATH.`,
  );
});
