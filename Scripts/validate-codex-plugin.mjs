import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import {
  assertBundledToolCatalog,
  assertReleaseTag,
  readReleaseContract,
} from "./release-contract.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const readJson = async (path) =>
  JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
const { version } = await readReleaseContract(repositoryRoot);
const tagArgument = process.argv.indexOf("--tag");
if (tagArgument >= 0 && !process.argv[tagArgument + 1]) {
  throw new Error("Missing value for --tag.");
}
assertReleaseTag(
  version,
  tagArgument >= 0 ? process.argv[tagArgument + 1] : undefined,
);
const [manifest, mcp, marketplace] = await Promise.all([
  readJson("plugins/silvic/.codex-plugin/plugin.json"),
  readJson("plugins/silvic/.mcp.json"),
  readJson(".agents/plugins/marketplace.json"),
]);

if (
  manifest.name !== "silvic" ||
  manifest.mcpServers !== "./.mcp.json" ||
  manifest.skills !== "./skills/"
) {
  throw new Error(
    "Plugin manifest does not expose the expected MCP and skill roots.",
  );
}
const server = mcp.mcpServers?.silvic;
if (
  server?.command !== "./bin/silvic" ||
  JSON.stringify(server.args) !== JSON.stringify(["mcp"])
) {
  throw new Error(
    "Plugin MCP must start through the packaged Silvic launcher.",
  );
}
if (
  marketplace.name !== "silvic" ||
  marketplace.plugins?.[0]?.source?.path !== "./plugins/silvic"
) {
  throw new Error("Repository marketplace does not expose plugins/silvic.");
}

const launcher = resolve(repositoryRoot, "plugins/silvic/bin/silvic");
const program = resolve(repositoryRoot, "plugins/silvic/bin/silvic.mjs");
const skill = resolve(
  repositoryRoot,
  "plugins/silvic/skills/silvic-preview/SKILL.md",
);
await Promise.all([
  access(launcher, constants.X_OK),
  access(program, constants.X_OK),
  access(skill, constants.R_OK),
]);
if (((await stat(launcher)).mode & 0o111) === 0) {
  throw new Error("Plugin launcher is not executable.");
}
await assertBundledToolCatalog(resolve(repositoryRoot, "plugins/silvic"));
const skillSource = await readFile(skill, "utf8");
if (
  !/^---\s*[\s\S]*?^name:\s*silvic-preview\s*$[\s\S]*?^description:\s*\S/m.test(
    skillSource,
  )
) {
  throw new Error("Silvic preview skill frontmatter is missing or invalid.");
}

process.stdout.write(`Silvic Codex plugin ${version} is valid.\n`);
