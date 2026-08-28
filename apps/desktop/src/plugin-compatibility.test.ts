import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  inspectPluginCompatibility,
  pluginMismatchMessage,
} from "./plugin-compatibility";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("detects a stale personal plugin and gives an exact safe update action", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "silvic-plugin-home-"));
  directories.push(homeDirectory);
  await installCachedPlugin(homeDirectory, "personal", "0.1.46");

  const status = await inspectPluginCompatibility({
    homeDirectory,
    appVersion: "0.1.53",
  });

  expect(status).toMatchObject({
    status: "outdated",
    appVersion: "0.1.53",
    installedVersions: ["0.1.46"],
  });
  expect(status.updateUrl).toContain("/v0.1.53/docs/AUTOMATION.md");
  expect(pluginMismatchMessage(status)?.detail).toContain(
    "fully restart Codex",
  );
});

it("does not warn when any installed cache matches the app", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "silvic-plugin-home-"));
  directories.push(homeDirectory);
  await installCachedPlugin(homeDirectory, "personal", "0.1.46");
  await installCachedPlugin(homeDirectory, "silvic-0-1-53", "0.1.53");

  const status = await inspectPluginCompatibility({
    homeDirectory,
    appVersion: "0.1.53",
  });

  expect(status.status).toBe("current");
  expect(pluginMismatchMessage(status)).toBeUndefined();
});

async function installCachedPlugin(
  homeDirectory: string,
  marketplace: string,
  version: string,
) {
  const directory = join(
    homeDirectory,
    ".codex/plugins/cache",
    marketplace,
    "silvic",
    version,
    ".codex-plugin",
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "plugin.json"),
    JSON.stringify({ name: "silvic", version }),
  );
}
