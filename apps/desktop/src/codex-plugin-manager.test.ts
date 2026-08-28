import { execFile, spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import packageMetadata from "../package.json" with { type: "json" };

import {
  packagedCodexMarketplaceRoot,
  reconcileCodexPlugin as reconcileCodexPluginImplementation,
  type CodexJsonCommand,
} from "./codex-plugin-manager";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const directories: string[] = [];
const executeFile = promisify(execFile);
const codexAvailable =
  spawnSync("codex", ["--version"], {
    stdio: "ignore",
  }).status === 0;
const appVersion = packageMetadata.version;

function reconcileCodexPlugin(
  options: Parameters<typeof reconcileCodexPluginImplementation>[0],
) {
  return reconcileCodexPluginImplementation({
    verifyPackagedCli: async () => undefined,
    ...options,
  });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("accepts only the two stable Silvic application paths", () => {
  expect(
    packagedCodexMarketplaceRoot({
      resourcesPath: "/Applications/Silvic.app/Contents/Resources",
      homeDirectory: "/Users/test",
    }),
  ).toBe("/Applications/Silvic.app/Contents/Resources/codex-marketplace");
  expect(
    packagedCodexMarketplaceRoot({
      resourcesPath: "/Users/test/Applications/Silvic.app/Contents/Resources",
      homeDirectory: "/Users/test",
    }),
  ).toBe(
    "/Users/test/Applications/Silvic.app/Contents/Resources/codex-marketplace",
  );
  expect(
    packagedCodexMarketplaceRoot({
      resourcesPath: "/Volumes/Silvic/Silvic.app/Contents/Resources",
      homeDirectory: "/Users/test",
    }),
  ).toBeUndefined();
  expect(
    packagedCodexMarketplaceRoot({
      resourcesPath: "/Applications/Renamed.app/Contents/Resources",
      homeDirectory: "/Users/test",
    }),
  ).toBeUndefined();
});

it("offers one stable selector for a first installation", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const execute = sequence([marketplaceInventory(), pluginInventory()]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(),
  });

  expect(result).toMatchObject({
    status: "not-installed",
    selector: "silvic@silvic",
    appVersion,
    restartRequired: false,
  });
  expect(execute.calls).toEqual([
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--json"],
  ]);
});

it("installs the packaged marketplace and plugin only after consent", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const installedRoot = join(tmpdir(), "silvic-installed-plugin");
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(),
    { marketplaceName: "silvic", installedRoot: marketplaceRoot },
    installResult(installedRoot),
    pluginInventory(stablePlugin(appVersion, marketplaceRoot)),
  ]);
  const verifyInstalledPlugin = vi.fn(async () => undefined);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: true,
    execute,
    verifyInstalledPlugin,
  });

  expect(result).toMatchObject({
    status: "restart-required",
    restartRequired: true,
    migratedSelectors: [],
  });
  expect(execute.calls).toContainEqual([
    "plugin",
    "marketplace",
    "add",
    marketplaceRoot,
    "--json",
  ]);
  expect(execute.calls).toContainEqual([
    "plugin",
    "add",
    "silvic@silvic",
    "--json",
  ]);
  expect(execute.calls.some((args) => args.includes("remove"))).toBe(false);
  expect(verifyInstalledPlugin).toHaveBeenCalledWith({
    pluginRoot: installedRoot,
    appVersion,
  });
});

it("upgrades the stable selector without removing or reinstalling it", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const execute = sequence([
    marketplaceInventory(marketplaceRoot),
    pluginInventory(stablePlugin("0.1.55", marketplaceRoot)),
    installResult(`/installed/silvic/${appVersion}`),
    pluginInventory(stablePlugin(appVersion, marketplaceRoot)),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(async () => undefined),
  });

  expect(result.status).toBe("restart-required");
  expect(execute.calls).toEqual([
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--json"],
    ["plugin", "add", "silvic@silvic", "--json"],
    ["plugin", "list", "--json"],
  ]);
});

it("re-verifies a current install without requiring another restart", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const execute = sequence([
    marketplaceInventory(marketplaceRoot),
    pluginInventory(stablePlugin(appVersion, marketplaceRoot)),
    installResult(`/installed/silvic/${appVersion}`),
    pluginInventory(stablePlugin(appVersion, marketplaceRoot)),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(async () => undefined),
  });

  expect(result.status).toBe("current");
});

it.each(["silvic@silvic-0-1-55", "silvic@personal"])(
  "installs and verifies the stable selector before removing legacy %s",
  async (legacySelector) => {
    const marketplaceRoot = await packagedMarketplace();
    const legacy = plugin(
      legacySelector,
      "0.1.55",
      join(marketplaceRoot, "plugins/silvic"),
    );
    const stable = stablePlugin(appVersion, marketplaceRoot);
    const execute = sequence([
      marketplaceInventory(),
      pluginInventory(legacy),
      { marketplaceName: "silvic", installedRoot: marketplaceRoot },
      installResult(`/installed/silvic/${appVersion}`),
      pluginInventory(stable, legacy),
      { pluginId: legacy.pluginId },
      pluginInventory(stable),
    ]);
    const verifyInstalledPlugin = vi.fn(async () => undefined);

    const result = await reconcileCodexPlugin({
      marketplaceRoot,
      appVersion,
      installIfMissing: false,
      execute,
      verifyInstalledPlugin,
    });

    expect(result).toMatchObject({
      status: "restart-required",
      migratedSelectors: [legacySelector],
    });
    expect(
      indexOfCall(execute.calls, ["plugin", "add", "silvic@silvic", "--json"]),
    ).toBeLessThan(
      indexOfCall(execute.calls, [
        "plugin",
        "remove",
        legacySelector,
        "--json",
      ]),
    );
  },
);

it("rejects a partial or mismatched packaged source before running Codex", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const manifestPath = join(
    marketplaceRoot,
    "plugins/silvic/.codex-plugin/plugin.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = "0.1.55";
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  const execute = sequence([]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: true,
    execute,
    verifyInstalledPlugin: vi.fn(),
  });

  expect(result).toMatchObject({ status: "error", restartRequired: false });
  expect(result.detail).toContain("version or repository differs");
  expect(execute.calls).toEqual([]);
});

it("rejects a packaged CLI mismatch before changing the installed plugin", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const execute = sequence([]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: true,
    execute,
    verifyPackagedCli: vi.fn(async () => {
      throw new Error("Packaged CLI reports 0.1.55");
    }),
    verifyInstalledPlugin: vi.fn(),
  });

  expect(result).toMatchObject({ status: "error", restartRequired: false });
  expect(result.detail).toContain("Packaged CLI reports 0.1.55");
  expect(execute.calls).toEqual([]);
});

it("does not remove a personal plugin whose source manifest is not Silvic", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const foreignRoot = await mkdtemp(join(tmpdir(), "foreign-silvic-plugin-"));
  directories.push(foreignRoot);
  await cp(join(repositoryRoot, "plugins/silvic"), foreignRoot, {
    recursive: true,
  });
  const manifestPath = join(foreignRoot, ".codex-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.repository = "https://example.com/not-silvic";
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(plugin("silvic@personal", appVersion, foreignRoot)),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(),
  });

  expect(result).toMatchObject({ status: "error", restartRequired: false });
  expect(result.detail).toContain("unrecognized Silvic selector");
  expect(execute.calls.some((args) => args.includes("remove"))).toBe(false);
  expect(execute.calls.some((args) => args.includes("add"))).toBe(false);
});

it("stops on a marketplace name collision without mutating Codex", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const execute = sequence([
    marketplaceInventory(
      "/Applications/Another.app/Contents/Resources/marketplace",
    ),
    pluginInventory(stablePlugin("0.1.55", marketplaceRoot)),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(),
  });

  expect(result).toMatchObject({ status: "error", restartRequired: false });
  expect(result.detail).toContain("marketplace named silvic");
  expect(execute.calls).toHaveLength(2);
});

it("keeps the legacy selector when the refreshed version does not match", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const legacy = plugin(
    "silvic@silvic-0-1-55",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(legacy),
    { marketplaceName: "silvic", installedRoot: marketplaceRoot },
    installResult("/installed/silvic/0.1.55", "0.1.55"),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(),
  });

  expect(result).toMatchObject({ status: "error", restartRequired: true });
  expect(result.detail).toContain("silvic@silvic 0.1.55");
  expect(execute.calls.some((args) => args.includes("remove"))).toBe(false);
});

it("keeps the legacy selector when the real MCP verification fails", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const legacy = plugin(
    "silvic@silvic-0-1-55",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const stable = stablePlugin(appVersion, marketplaceRoot);
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(legacy),
    { marketplaceName: "silvic", installedRoot: marketplaceRoot },
    installResult(`/installed/silvic/${appVersion}`),
    pluginInventory(stable, legacy),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(async () => {
      throw new Error("tools/list differs");
    }),
  });

  expect(result).toMatchObject({ status: "error", restartRequired: true });
  expect(result.detail).toContain("tools/list differs");
  expect(execute.calls.some((args) => args.includes("remove"))).toBe(false);
});

it("restores an already removed legacy selector when migration later fails", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const generated = plugin(
    "silvic@silvic-0-1-55",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const personal = plugin(
    "silvic@personal",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const stable = stablePlugin(appVersion, marketplaceRoot);
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(generated, personal),
    { marketplaceName: "silvic", installedRoot: marketplaceRoot },
    installResult(`/installed/silvic/${appVersion}`),
    pluginInventory(stable, generated, personal),
    { pluginId: generated.pluginId },
    new Error("personal removal failed"),
    { pluginId: generated.pluginId },
    pluginInventory(stable, generated, personal),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(async () => undefined),
  });

  expect(result).toMatchObject({ status: "error", migratedSelectors: [] });
  expect(result.detail).toContain("Removed legacy selectors were restored");
  expect(execute.calls.slice(-2)).toEqual([
    ["plugin", "add", generated.pluginId, "--json"],
    ["plugin", "list", "--json"],
  ]);
});

it("reports a legacy selector when migration rollback cannot restore it", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const generated = plugin(
    "silvic@silvic-0-1-55",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const personal = plugin(
    "silvic@personal",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const stable = stablePlugin(appVersion, marketplaceRoot);
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(generated, personal),
    { marketplaceName: "silvic", installedRoot: marketplaceRoot },
    installResult(`/installed/silvic/${appVersion}`),
    pluginInventory(stable, generated, personal),
    { pluginId: generated.pluginId },
    new Error("personal removal failed"),
    new Error("generated restore failed"),
    pluginInventory(stable, personal),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(async () => undefined),
  });

  expect(result).toMatchObject({
    status: "error",
    migratedSelectors: [generated.pluginId],
  });
  expect(result.detail).toContain(`Could not restore ${generated.pluginId}`);
});

it("does not trust a successful restore command without inventory confirmation", async () => {
  const marketplaceRoot = await packagedMarketplace();
  const generated = plugin(
    "silvic@silvic-0-1-55",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const personal = plugin(
    "silvic@personal",
    "0.1.55",
    join(marketplaceRoot, "plugins/silvic"),
  );
  const stable = stablePlugin(appVersion, marketplaceRoot);
  const execute = sequence([
    marketplaceInventory(),
    pluginInventory(generated, personal),
    { marketplaceName: "silvic", installedRoot: marketplaceRoot },
    installResult(`/installed/silvic/${appVersion}`),
    pluginInventory(stable, generated, personal),
    { pluginId: generated.pluginId },
    new Error("personal removal failed"),
    { pluginId: generated.pluginId },
    pluginInventory(stable, personal),
  ]);

  const result = await reconcileCodexPlugin({
    marketplaceRoot,
    appVersion,
    installIfMissing: false,
    execute,
    verifyInstalledPlugin: vi.fn(async () => undefined),
  });

  expect(result).toMatchObject({
    status: "error",
    migratedSelectors: [generated.pluginId],
  });
  expect(result.detail).toContain(`Could not restore ${generated.pluginId}`);
});

it.runIf(codexAvailable)(
  "refreshes a real isolated Codex install without remove or cache access",
  async () => {
    const marketplaceRoot = await packagedMarketplace();
    const codexHome = await mkdtemp(join(tmpdir(), "silvic-codex-home-"));
    directories.push(codexHome);
    const calls: string[][] = [];
    const execute: CodexJsonCommand = async (args) => {
      calls.push([...args]);
      const { stdout } = await executeFile("codex", [...args], {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      return JSON.parse(stdout);
    };
    const verifyInstalledPlugin = vi.fn(async () => undefined);

    await expect(
      reconcileCodexPlugin({
        marketplaceRoot,
        appVersion,
        installIfMissing: true,
        execute,
        verifyInstalledPlugin,
      }),
    ).resolves.toMatchObject({ status: "restart-required" });

    const manifestPath = join(
      marketplaceRoot,
      "plugins/silvic/.codex-plugin/plugin.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const upgradedVersion = nextPatchVersion(appVersion);
    manifest.version = upgradedVersion;
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    );

    await expect(
      reconcileCodexPlugin({
        marketplaceRoot,
        appVersion: upgradedVersion,
        installIfMissing: false,
        execute,
        verifyInstalledPlugin,
      }),
    ).resolves.toMatchObject({ status: "restart-required" });

    const inventory = await execute(["plugin", "list", "--json"]);
    expect(inventory).toMatchObject({
      installed: [
        {
          pluginId: "silvic@silvic",
          version: upgradedVersion,
          installed: true,
          enabled: true,
        },
      ],
    });
    expect(calls.some((args) => args.includes("remove"))).toBe(false);
  },
);

async function packagedMarketplace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "silvic-marketplace-"));
  directories.push(directory);
  await cp(join(repositoryRoot, ".agents"), join(directory, ".agents"), {
    recursive: true,
  });
  await cp(join(repositoryRoot, "plugins"), join(directory, "plugins"), {
    recursive: true,
  });
  return directory;
}

function marketplaceInventory(root?: string) {
  return {
    marketplaces: root
      ? [
          {
            name: "silvic",
            root,
            marketplaceSource: { sourceType: "local", source: root },
          },
        ]
      : [],
  };
}

function pluginInventory(...installed: ReturnType<typeof plugin>[]) {
  return { installed };
}

function stablePlugin(version: string, marketplaceRoot: string) {
  return plugin(
    "silvic@silvic",
    version,
    join(marketplaceRoot, "plugins/silvic"),
    marketplaceRoot,
  );
}

function plugin(
  pluginId: string,
  version: string,
  sourcePath: string,
  marketplaceRoot = sourcePath,
) {
  return {
    pluginId,
    name: "silvic",
    marketplaceName: pluginId.split("@")[1],
    version,
    installed: true,
    enabled: true,
    source: { source: "local", path: sourcePath },
    marketplaceSource: { sourceType: "local", source: marketplaceRoot },
  };
}

function installResult(installedPath: string, version = appVersion) {
  return {
    pluginId: "silvic@silvic",
    name: "silvic",
    marketplaceName: "silvic",
    version,
    installedPath,
  };
}

function nextPatchVersion(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error(`Expected a stable release version, received ${version}`);
  }
  return `${major}.${minor}.${patch! + 1}`;
}

function sequence(results: unknown[]) {
  const calls: string[][] = [];
  const execute: CodexJsonCommand & { calls: typeof calls } = Object.assign(
    async (args: readonly string[]) => {
      calls.push([...args]);
      const result = results.shift();
      if (result === undefined)
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      if (result instanceof Error) throw result;
      return result;
    },
    { calls },
  );
  return execute;
}

function indexOfCall(calls: string[][], args: string[]): number {
  return calls.findIndex(
    (call) => JSON.stringify(call) === JSON.stringify(args),
  );
}
