import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const readJson = async (path) =>
  JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
const [root, desktop, cli, manifest, mcp, marketplace] = await Promise.all([
  readJson("package.json"),
  readJson("apps/desktop/package.json"),
  readJson("apps/cli/package.json"),
  readJson("plugins/silvic/.codex-plugin/plugin.json"),
  readJson("plugins/silvic/.mcp.json"),
  readJson(".agents/plugins/marketplace.json"),
]);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error(`Plugin version is not strict semver: ${manifest.version}`);
}
const versions = [root.version, desktop.version, cli.version, manifest.version];
if (!versions.every((version) => version === root.version)) {
  throw new Error(`Release versions differ: ${versions.join(", ")}`);
}
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
await Promise.all([
  access(launcher, constants.X_OK),
  access(program, constants.X_OK),
]);
if (((await stat(launcher)).mode & 0o111) === 0) {
  throw new Error("Plugin launcher is not executable.");
}
const bundledProgram = await readFile(program, "utf8");
for (const tool of ["plan_plot_adoption", "adopt_plot", "provision_plot"]) {
  if (!bundledProgram.includes(`\"${tool}\"`)) {
    throw new Error(`Bundled plugin is missing MCP tool ${tool}`);
  }
}

process.stdout.write(`Silvic Codex plugin ${manifest.version} is valid.\n`);
