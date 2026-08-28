import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertBundledToolCatalog,
  readReleaseContract,
} from "./release-contract.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const outputArgument = process.argv.indexOf("--output");
const outputRoot = resolve(
  outputArgument >= 0 && process.argv[outputArgument + 1]
    ? process.argv[outputArgument + 1]
    : join(repositoryRoot, "release"),
);

const { version } = await readReleaseContract(repositoryRoot);
const pluginRoot = join(repositoryRoot, "plugins/silvic");
await assertBundledToolCatalog(pluginRoot);

const directoryName = `Silvic-Codex-Plugin-${version}`;
const stagingRoot = join(outputRoot, "codex-plugin");
const bundleRoot = join(stagingRoot, directoryName);
const archive = join(outputRoot, `${directoryName}.tar.gz`);
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(join(bundleRoot, ".agents/plugins"), { recursive: true });
await mkdir(join(bundleRoot, "plugins"), { recursive: true });
await cp(pluginRoot, join(bundleRoot, "plugins/silvic"), { recursive: true });
await chmod(join(bundleRoot, "plugins/silvic/bin/silvic"), 0o755);
await chmod(join(bundleRoot, "plugins/silvic/bin/silvic.mjs"), 0o755);

const marketplaceName = "silvic";
await cp(
  join(repositoryRoot, ".agents/plugins/marketplace.json"),
  join(bundleRoot, ".agents/plugins/marketplace.json"),
);
await writeFile(
  join(bundleRoot, "INSTALL.md"),
  `# Install Silvic Codex Plugin ${version}\n\nThis rollback and manual-distribution bundle must be used with Silvic Desktop ${version}. Verify the adjacent SHA-256 file before extracting it. Normal Desktop updates use the signed marketplace inside Silvic.app instead.\n\nQuit all Codex tasks using Silvic. First run \`codex plugin marketplace list --json\`. If it already reports a source named \`silvic\`, confirm that its root is this extracted ${directoryName} directory; otherwise stop instead of replacing it. Then, from the directory containing this extracted folder, add the stable marketplace and selector:\n\n\`\`\`sh\ncodex plugin marketplace add \"$PWD/${directoryName}\"\ncodex plugin add silvic@${marketplaceName}\n\`\`\`\n\nFor a deliberate manual rollback from the app-bound source, first verify that the existing \`silvic\` root is exactly \`/Applications/Silvic.app/Contents/Resources/codex-marketplace\` (or the same path under \`~/Applications\`) and that its plugin manifest names the Silvic repository. Only then run \`codex plugin marketplace remove silvic\` before the two commands above. Return to normal Desktop updates by performing the same checks on this extracted source, removing only marketplace \`silvic\`, and adding the app-bound path again.\n\nTo migrate an old Silvic selector, first confirm \`codex plugin list --json\` reports \`silvic@silvic\` at version ${version}; then remove only the confirmed old \`silvic@personal\` or \`silvic@silvic-0-1-*\` selector whose source manifest names the Silvic repository. Fully restart Codex and open a new task. The plugin uses the runtime packaged in /Applications/Silvic.app and does not require Node on PATH.\n`,
);

await mkdir(outputRoot, { recursive: true });
await rm(archive, { force: true });
await executeFile("tar", ["-czf", archive, "-C", stagingRoot, directoryName]);
const digest = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
process.stdout.write(`${archive}\n`);
