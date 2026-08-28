import { readFile } from "node:fs/promises";
import { join } from "node:path";

import codexPluginContract from "../packages/contracts/src/codex-plugin-contract.json" with { type: "json" };

export const releaseMetadataPaths = [
  "package.json",
  "apps/desktop/package.json",
  "apps/cli/package.json",
  "plugins/silvic/.codex-plugin/plugin.json",
];

export const requiredMcpTools = codexPluginContract.tools;

export async function readReleaseContract(repositoryRoot) {
  const metadata = await Promise.all(
    releaseMetadataPaths.map(async (path) => ({
      path,
      value: JSON.parse(await readFile(join(repositoryRoot, path), "utf8")),
    })),
  );
  const version = metadata[0].value.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Release version is not strict semver: ${String(version)}`);
  }
  if (!metadata.every((entry) => entry.value.version === version)) {
    throw new Error(
      `Release versions differ: ${metadata.map((entry) => `${entry.path}=${String(entry.value.version)}`).join(", ")}`,
    );
  }
  return { version, metadata };
}

export function assertReleaseTag(version, tag) {
  if (tag === undefined) return;
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag ${tag} does not match ${expected}.`);
  }
}

export async function assertBundledToolCatalog(pluginRoot) {
  const bundledProgram = await readFile(
    join(pluginRoot, "bin/silvic.mjs"),
    "utf8",
  );
  const missing = requiredMcpTools.filter(
    (tool) => !bundledProgram.includes(JSON.stringify(tool)),
  );
  if (missing.length > 0) {
    throw new Error(
      `Bundled plugin is missing MCP tools: ${missing.join(", ")}`,
    );
  }
}
