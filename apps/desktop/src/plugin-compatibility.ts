import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PluginCompatibility {
  status: "not-installed" | "current" | "outdated";
  appVersion: string;
  installedVersions: readonly string[];
  updateUrl: string;
}

export async function inspectPluginCompatibility({
  homeDirectory,
  appVersion,
}: {
  homeDirectory: string;
  appVersion: string;
}): Promise<PluginCompatibility> {
  const cacheRoot = join(homeDirectory, ".codex/plugins/cache");
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
  const installedVersions = [...versions].sort();
  return {
    status:
      installedVersions.length === 0
        ? "not-installed"
        : installedVersions.includes(appVersion)
          ? "current"
          : "outdated",
    appVersion,
    installedVersions,
    updateUrl: `https://github.com/sieversjosua/Silvic/blob/v${encodeURIComponent(appVersion)}/docs/AUTOMATION.md#install-or-update-the-codex-plugin`,
  };
}

export function pluginMismatchMessage(
  compatibility: PluginCompatibility,
): { message: string; detail: string } | undefined {
  if (compatibility.status !== "outdated") return undefined;
  return {
    message: "The installed Silvic Codex plugin does not match this app",
    detail: `Silvic Desktop is ${compatibility.appVersion}, while Codex has cached ${compatibility.installedVersions.join(", ")}. Those clients are blocked from automation instead of silently hiding newer tools. Install the plugin artifact from the matching GitHub release, then fully restart Codex and open a new task.`,
  };
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
