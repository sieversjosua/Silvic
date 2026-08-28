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

const marketplaceName = `silvic-${version.replace(/[^0-9A-Za-z_-]/g, "-")}`;
await writeFile(
  join(bundleRoot, ".agents/plugins/marketplace.json"),
  `${JSON.stringify(
    {
      name: marketplaceName,
      interface: { displayName: `Silvic ${version}` },
      plugins: [
        {
          name: "silvic",
          source: { source: "local", path: "./plugins/silvic" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    },
    undefined,
    2,
  )}\n`,
);
await writeFile(
  join(bundleRoot, "INSTALL.md"),
  `# Install Silvic Codex Plugin ${version}\n\nThis bundle must be used with Silvic Desktop ${version}. Verify the adjacent SHA-256 file before extracting it.\n\nQuit all Codex tasks using Silvic. Run \`codex plugin list\`; if an older Silvic plugin is installed, copy its complete \`silvic@marketplace\` selector and remove only that entry with \`codex plugin remove silvic@marketplace\`. Then, from the directory containing this extracted folder:\n\n\`\`\`sh\ncodex plugin marketplace add \"$PWD/${directoryName}\"\ncodex plugin add silvic@${marketplaceName}\n\`\`\`\n\nFully restart Codex and open a new task. The plugin uses the runtime packaged in /Applications/Silvic.app and does not require Node on PATH.\n`,
);

await mkdir(outputRoot, { recursive: true });
await rm(archive, { force: true });
await executeFile("tar", ["-czf", archive, "-C", stagingRoot, directoryName]);
const digest = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
process.stdout.write(`${archive}\n`);
