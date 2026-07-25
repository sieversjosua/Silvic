import { readFile } from "node:fs/promises";

const mainBundle = await readFile(
  new URL("../apps/desktop/out/main/main.js", import.meta.url),
  "utf8",
);
const preloadBundle = await readFile(
  new URL("../apps/desktop/out/preload/preload.cjs", import.meta.url),
  "utf8",
);

const forbidden = [
  "Downloading Electron binary",
  "Electron failed to install correctly",
  'path.join(__dirname, "install.js")',
];

for (const marker of forbidden) {
  if (mainBundle.includes(marker)) {
    throw new Error(
      `Desktop bundle contains Electron's package installer (${marker}). Keep "electron" external.`,
    );
  }
}

if (/^\s*import\s/m.test(preloadBundle)) {
  throw new Error(
    "Sandboxed Electron preload must be CommonJS; ESM imports prevent the bridge from loading.",
  );
}
