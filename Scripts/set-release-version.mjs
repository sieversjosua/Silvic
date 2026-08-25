import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { format } from "prettier";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: pnpm release:version <semver>");
}

for (const relativePath of [
  "package.json",
  "apps/desktop/package.json",
  "apps/cli/package.json",
  "plugins/silvic/.codex-plugin/plugin.json",
]) {
  const path = resolve(relativePath);
  const contents = JSON.parse(await readFile(path, "utf8"));
  contents.version = version;
  await writeFile(
    path,
    await format(JSON.stringify(contents), { filepath: path }),
  );
}

console.log("Silvic release version is now " + version);
