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

it("warns for the enabled stale selector even when a matching cache exists", async () => {
  const homeDirectory = await cachedHome("0.1.46", "0.1.53");
  const status = await inspectPluginCompatibility({
    homeDirectory,
    appVersion: "0.1.53",
    installedInventory: inventory("silvic@personal", "0.1.46"),
  });

  expect(status).toMatchObject({
    status: "outdated",
    installedEvidence: "codex-plugin-list",
    activePlugins: [{ selector: "silvic@personal", version: "0.1.46" }],
    cachedVersions: ["0.1.46", "0.1.53"],
  });
  expect(pluginMismatchMessage(status)?.detail).toContain(
    "Cached versions (0.1.46, 0.1.53) are not treated as installed evidence",
  );
});

it("accepts a current enabled selector regardless of stale cache entries", async () => {
  const homeDirectory = await cachedHome("0.1.46", "0.1.53");
  const status = await inspectPluginCompatibility({
    homeDirectory,
    appVersion: "0.1.53",
    installedInventory: inventory("silvic@silvic-0-1-53", "0.1.53"),
  });

  expect(status.status).toBe("current");
  expect(pluginMismatchMessage(status)).toBeUndefined();
});

it("warns as unverified when only cache evidence is available", async () => {
  const homeDirectory = await cachedHome("0.1.53");
  const status = await inspectPluginCompatibility({
    homeDirectory,
    appVersion: "0.1.53",
    installedInventory: undefined,
  });

  expect(status).toMatchObject({
    status: "unverified",
    activePlugins: [],
    cachedVersions: ["0.1.53"],
    installedEvidence: "unavailable",
  });
  expect(pluginMismatchMessage(status)?.detail).toContain(
    "cache entry does not prove which selector is enabled",
  );
});

it("does not warn for a disabled or uninstalled selector", async () => {
  const homeDirectory = await cachedHome("0.1.46");
  const value = inventory("silvic@personal", "0.1.46");
  value.installed[0]!.enabled = false;
  const status = await inspectPluginCompatibility({
    homeDirectory,
    appVersion: "0.1.53",
    installedInventory: value,
  });

  expect(status.status).toBe("not-installed");
  expect(pluginMismatchMessage(status)).toBeUndefined();
});

function inventory(selector: string, version: string) {
  return {
    installed: [
      {
        pluginId: selector,
        name: "silvic",
        marketplaceName: selector.split("@")[1],
        version,
        installed: true,
        enabled: true,
      },
    ],
  };
}

async function cachedHome(...versions: string[]): Promise<string> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "silvic-plugin-home-"));
  directories.push(homeDirectory);
  for (const version of versions) {
    await installCachedPlugin(homeDirectory, "personal", version);
  }
  return homeDirectory;
}

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
