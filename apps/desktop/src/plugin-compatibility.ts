import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { automationCompatibilityAction } from "@silvic/automation";

const executeFile = promisify(execFile);

export interface ActiveSilvicPlugin {
  selector: string;
  version: string;
}

export interface PluginCompatibility {
  status: "not-installed" | "current" | "outdated" | "unverified";
  appVersion: string;
  activePlugins: readonly ActiveSilvicPlugin[];
  cachedVersions: readonly string[];
  installedEvidence: "codex-plugin-list" | "unavailable";
  updateUrl: string;
}

export async function readCodexPluginInventory(
  commandPath: string,
): Promise<unknown> {
  try {
    const { stdout } = await executeFile(
      "codex",
      ["plugin", "list", "--json"],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: commandPath },
        timeout: 10_000,
        maxBuffer: 2_000_000,
      },
    );
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export async function inspectPluginCompatibility({
  homeDirectory,
  appVersion,
  installedInventory,
}: {
  homeDirectory: string;
  appVersion: string;
  installedInventory: unknown;
}): Promise<PluginCompatibility> {
  const cachedVersions = await readCachedVersions(
    join(homeDirectory, ".codex/plugins/cache"),
  );
  const activePlugins = activeSilvicPlugins(installedInventory);
  const installedEvidence = activePlugins ? "codex-plugin-list" : "unavailable";
  return {
    status:
      activePlugins === undefined
        ? cachedVersions.length > 0
          ? "unverified"
          : "not-installed"
        : activePlugins.length === 0
          ? "not-installed"
          : activePlugins.some((plugin) => plugin.version !== appVersion)
            ? "outdated"
            : "current",
    appVersion,
    activePlugins: activePlugins ?? [],
    cachedVersions,
    installedEvidence,
    updateUrl: `https://github.com/sieversjosua/Silvic/blob/v${encodeURIComponent(appVersion)}/docs/AUTOMATION.md#install-or-update-the-codex-plugin`,
  };
}

export function pluginMismatchMessage(
  compatibility: PluginCompatibility,
): { message: string; detail: string } | undefined {
  if (compatibility.status === "outdated") {
    const active = compatibility.activePlugins
      .map((plugin) => `${plugin.selector} ${plugin.version}`)
      .join(", ");
    return {
      message: "The active Silvic Codex plugin does not match this app",
      detail: `Silvic Desktop is ${compatibility.appVersion}; Codex reports active ${active}. Cached versions (${compatibility.cachedVersions.join(", ") || "none"}) are not treated as installed evidence. ${automationCompatibilityAction(compatibility.appVersion)}`,
    };
  }
  if (compatibility.status === "unverified") {
    return {
      message: "Silvic could not verify the active Codex plugin",
      detail: `Codex plugin inventory was unavailable, but Silvic found cached versions ${compatibility.cachedVersions.join(", ")}. A cache entry does not prove which selector is enabled. Verify with codex plugin list. ${automationCompatibilityAction(compatibility.appVersion)}`,
    };
  }
  return undefined;
}

function activeSilvicPlugins(value: unknown): ActiveSilvicPlugin[] | undefined {
  if (!isRecord(value) || !Array.isArray(value["installed"])) return undefined;
  return value["installed"].flatMap((entry) => {
    if (
      !isRecord(entry) ||
      entry["name"] !== "silvic" ||
      entry["installed"] !== true ||
      entry["enabled"] !== true ||
      typeof entry["version"] !== "string"
    ) {
      return [];
    }
    const selector =
      typeof entry["pluginId"] === "string"
        ? entry["pluginId"]
        : typeof entry["marketplaceName"] === "string"
          ? `silvic@${entry["marketplaceName"]}`
          : "silvic@unknown";
    return [{ selector, version: entry["version"] }];
  });
}

async function readCachedVersions(cacheRoot: string): Promise<string[]> {
  const versions = new Set<string>();
  for (const marketplace of await directoryNames(cacheRoot)) {
    const pluginRoot = join(cacheRoot, marketplace, "silvic");
    for (const cachedVersion of await directoryNames(pluginRoot)) {
      try {
        const manifest = JSON.parse(
          await readFile(
            join(pluginRoot, cachedVersion, ".codex-plugin/plugin.json"),
            "utf8",
          ),
        ) as { name?: unknown; version?: unknown };
        if (
          manifest.name === "silvic" &&
          typeof manifest.version === "string"
        ) {
          versions.add(manifest.version);
        }
      } catch {
        // A partial or unrelated cache entry is not evidence of an installation.
      }
    }
  }
  return [...versions].sort();
}

async function directoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
