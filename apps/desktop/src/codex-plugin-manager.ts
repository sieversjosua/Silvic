import { execFile, spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { silvicCodexPlugin } from "@silvic/contracts";

const executeFile = promisify(execFile);

export type CodexJsonCommand = (args: readonly string[]) => Promise<unknown>;

export interface CodexPluginReconciliation {
  status: "not-installed" | "current" | "restart-required" | "error";
  selector: string;
  appVersion: string;
  restartRequired: boolean;
  migratedSelectors: readonly string[];
  detail?: string;
}

export function packagedCodexMarketplaceRoot({
  resourcesPath,
  homeDirectory,
}: {
  resourcesPath: string;
  homeDirectory: string;
}): string | undefined {
  const appRoot = resolve(resourcesPath, "../..");
  const supportedRoots = [
    resolve("/Applications/Silvic.app"),
    resolve(homeDirectory, "Applications/Silvic.app"),
  ];
  return supportedRoots.includes(appRoot)
    ? join(resourcesPath, "codex-marketplace")
    : undefined;
}

interface InstalledPlugin {
  pluginId: string;
  name: string;
  version: string;
  sourcePath?: string;
  marketplaceRoot?: string;
}

export async function reconcileCodexPlugin({
  marketplaceRoot,
  appVersion,
  installIfMissing,
  commandPath = process.env.PATH ?? "/usr/bin:/bin",
  execute = (args) => executeCodexJson(args, commandPath),
  verifyPackagedCli = () =>
    verifyCliVersion({
      launcher: resolve(marketplaceRoot, "../bin/silvic"),
      appVersion,
    }),
  verifyInstalledPlugin = (input) => verifyInstalledSilvicPlugin(input),
}: {
  marketplaceRoot: string;
  appVersion: string;
  installIfMissing: boolean;
  commandPath?: string;
  execute?: CodexJsonCommand;
  verifyPackagedCli?: () => Promise<void>;
  verifyInstalledPlugin?: (input: {
    pluginRoot: string;
    appVersion: string;
  }) => Promise<void>;
}): Promise<CodexPluginReconciliation> {
  const migratedSelectors: string[] = [];
  let refreshAttempted = false;
  const result = (
    input: Omit<
      CodexPluginReconciliation,
      "selector" | "appVersion" | "restartRequired"
    >,
  ) => ({
    selector: silvicCodexPlugin.selector,
    appVersion,
    restartRequired:
      input.status === "restart-required" ||
      (input.status === "error" && refreshAttempted),
    ...input,
  });

  try {
    await validateMarketplace(marketplaceRoot, appVersion);
    await verifyPackagedCli();
    const marketplaceInventory = await execute([
      "plugin",
      "marketplace",
      "list",
      "--json",
    ]);
    const initialInventory = await execute(["plugin", "list", "--json"]);
    const marketplaces = readMarketplaces(marketplaceInventory);
    const installed = readInstalledPlugins(initialInventory).filter(
      (plugin) => plugin.name === "silvic",
    );
    const stable = installed.find(
      (plugin) => plugin.pluginId === silvicCodexPlugin.selector,
    );
    const legacy: InstalledPlugin[] = [];
    const unrecognized: InstalledPlugin[] = [];
    for (const plugin of installed) {
      if (plugin.pluginId === silvicCodexPlugin.selector) continue;
      if (await isRecognizedLegacyPlugin(plugin)) legacy.push(plugin);
      else unrecognized.push(plugin);
    }
    if (unrecognized.length > 0) {
      throw new Error(
        `Codex reports an unrecognized Silvic selector (${unrecognized.map((plugin) => plugin.pluginId).join(", ")}); it was left unchanged.`,
      );
    }

    const configuredMarketplace = marketplaces.find(
      (marketplace) => marketplace.name === silvicCodexPlugin.marketplaceName,
    );
    if (
      configuredMarketplace &&
      !(await samePath(configuredMarketplace.root, marketplaceRoot))
    ) {
      throw new Error(
        `Codex already has a marketplace named silvic at ${configuredMarketplace.root}; Silvic left it unchanged.`,
      );
    }

    if (!stable && legacy.length === 0 && !installIfMissing) {
      return result({
        status: "not-installed",
        migratedSelectors: [],
      });
    }

    if (!configuredMarketplace) {
      const added = await execute([
        "plugin",
        "marketplace",
        "add",
        marketplaceRoot,
        "--json",
      ]);
      if (
        !isRecord(added) ||
        added["marketplaceName"] !== silvicCodexPlugin.marketplaceName
      ) {
        throw new Error("Codex did not confirm the Silvic marketplace source.");
      }
    }

    // Codex may have replaced its cached copy even when this command or a
    // later verification fails. From here on, an error still requires a full
    // Codex restart so an already-running MCP process cannot be trusted.
    refreshAttempted = true;
    const installedResult = await execute([
      "plugin",
      "add",
      silvicCodexPlugin.selector,
      "--json",
    ]);
    const installedPath = requiredString(installedResult, "installedPath");
    const installedVersion = requiredString(installedResult, "version");
    const installedSelector = requiredString(installedResult, "pluginId");
    if (
      installedSelector !== silvicCodexPlugin.selector ||
      installedVersion !== appVersion
    ) {
      throw new Error(
        `Codex installed ${installedSelector} ${installedVersion}; expected ${silvicCodexPlugin.selector} ${appVersion}.`,
      );
    }

    const refreshedInventory = readInstalledPlugins(
      await execute(["plugin", "list", "--json"]),
    );
    const refreshed = refreshedInventory.find(
      (plugin) => plugin.pluginId === silvicCodexPlugin.selector,
    );
    if (!refreshed || refreshed.version !== appVersion) {
      throw new Error(
        `codex plugin list --json did not confirm ${silvicCodexPlugin.selector} ${appVersion}.`,
      );
    }
    if (
      !refreshed.marketplaceRoot ||
      !(await samePath(refreshed.marketplaceRoot, marketplaceRoot))
    ) {
      throw new Error(
        `Codex reports ${silvicCodexPlugin.selector} from an unexpected marketplace source.`,
      );
    }

    await verifyInstalledPlugin({ pluginRoot: installedPath, appVersion });

    // The stable copy is now observable, version-equal, and executable. Only
    // this point permits removal of a source-verified legacy selector.
    try {
      for (const plugin of legacy) {
        await execute(["plugin", "remove", plugin.pluginId, "--json"]);
        migratedSelectors.push(plugin.pluginId);
      }
      if (legacy.length > 0) {
        const finalSelectors = new Set(
          readInstalledPlugins(await execute(["plugin", "list", "--json"])).map(
            (plugin) => plugin.pluginId,
          ),
        );
        const remaining = legacy.filter((plugin) =>
          finalSelectors.has(plugin.pluginId),
        );
        if (remaining.length > 0) {
          throw new Error(
            `Codex still reports migrated selectors ${remaining.map((plugin) => plugin.pluginId).join(", ")}.`,
          );
        }
      }
    } catch (migrationError) {
      for (const selector of [...migratedSelectors].reverse()) {
        try {
          await execute(["plugin", "add", selector, "--json"]);
        } catch {
          // The inventory below remains authoritative even when Codex reports
          // an add error after restoring the selector.
        }
      }
      try {
        const restoredSelectors = new Set(
          readInstalledPlugins(await execute(["plugin", "list", "--json"])).map(
            (plugin) => plugin.pluginId,
          ),
        );
        for (const selector of [...migratedSelectors]) {
          if (restoredSelectors.has(selector)) {
            migratedSelectors.splice(migratedSelectors.indexOf(selector), 1);
          }
        }
      } catch {
        // Without an observable inventory, no removed selector is reported as
        // restored merely because its add command returned successfully.
      }
      const reason =
        migrationError instanceof Error
          ? migrationError.message
          : "Legacy selector migration failed.";
      throw new Error(
        migratedSelectors.length > 0
          ? `${reason} Could not restore ${migratedSelectors.join(", ")}.`
          : `${reason} Removed legacy selectors were restored.`,
      );
    }

    const changed =
      !stable || stable.version !== appVersion || legacy.length > 0;
    return result({
      status: changed ? "restart-required" : "current",
      migratedSelectors,
    });
  } catch (error) {
    return result({
      status: "error",
      migratedSelectors,
      detail:
        error instanceof Error ? error.message : "Codex plugin update failed.",
    });
  }
}

export async function verifyInstalledSilvicPlugin({
  pluginRoot,
  appVersion,
}: {
  pluginRoot: string;
  appVersion: string;
}): Promise<void> {
  const manifest = await readJson(
    join(pluginRoot, ".codex-plugin/plugin.json"),
  );
  if (manifest["name"] !== "silvic" || manifest["version"] !== appVersion) {
    throw new Error(
      "The installed plugin manifest does not match Silvic Desktop.",
    );
  }
  const configuration = await readJson(join(pluginRoot, ".mcp.json"));
  const servers = configuration["mcpServers"];
  const server = isRecord(servers) ? servers["silvic"] : undefined;
  if (
    !isRecord(server) ||
    server["command"] !== "./bin/silvic" ||
    !Array.isArray(server["args"]) ||
    server["args"].length !== 1 ||
    server["args"][0] !== "mcp"
  ) {
    throw new Error(
      "The installed Silvic MCP launcher configuration is invalid.",
    );
  }

  const launcher = resolve(pluginRoot, "bin/silvic");
  const environment = pluginEnvironment();
  await verifyCliVersion({
    launcher,
    appVersion,
  });

  const replies = await mcpExchange(
    launcher,
    ["mcp"],
    pluginRoot,
    environment,
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: silvicCodexPlugin.mcpProtocolVersion,
          capabilities: {},
          clientInfo: { name: "silvic-desktop-verifier", version: appVersion },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
  );
  const initialized = replies.find((reply) => reply["id"] === 1);
  const listed = replies.find((reply) => reply["id"] === 2);
  const initializeResult = isRecord(initialized?.["result"])
    ? initialized["result"]
    : undefined;
  const serverInfo = isRecord(initializeResult?.["serverInfo"])
    ? initializeResult["serverInfo"]
    : undefined;
  if (
    serverInfo?.["version"] !== appVersion ||
    initializeResult?.["protocolVersion"] !==
      silvicCodexPlugin.mcpProtocolVersion
  ) {
    throw new Error(
      "The installed Silvic MCP initialize response does not match.",
    );
  }
  const listResult = isRecord(listed?.["result"])
    ? listed["result"]
    : undefined;
  const tools = Array.isArray(listResult?.["tools"])
    ? listResult["tools"].flatMap((tool) =>
        isRecord(tool) && typeof tool["name"] === "string"
          ? [tool["name"]]
          : [],
      )
    : [];
  if (JSON.stringify(tools) !== JSON.stringify(silvicCodexPlugin.tools)) {
    throw new Error(
      `The installed Silvic MCP tools/list differs: ${tools.join(", ")}.`,
    );
  }
}

async function executeCodexJson(
  args: readonly string[],
  commandPath: string,
): Promise<unknown> {
  const { stdout } = await executeFile("codex", [...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: commandPath },
    timeout: 30_000,
    maxBuffer: 2_000_000,
  });
  return JSON.parse(stdout);
}

async function validateMarketplace(
  marketplaceRoot: string,
  appVersion: string,
): Promise<void> {
  const marketplace = await readJson(
    join(marketplaceRoot, ".agents/plugins/marketplace.json"),
  );
  const plugins = marketplace["plugins"];
  const entry = Array.isArray(plugins) ? plugins[0] : undefined;
  const source = isRecord(entry) ? entry["source"] : undefined;
  if (
    marketplace["name"] !== silvicCodexPlugin.marketplaceName ||
    !Array.isArray(plugins) ||
    plugins.length !== 1 ||
    !isRecord(entry) ||
    entry["name"] !== "silvic" ||
    !isRecord(source) ||
    source["source"] !== "local" ||
    source["path"] !== "./plugins/silvic"
  ) {
    throw new Error("The packaged Silvic marketplace identity is invalid.");
  }
  const manifest = await readJson(
    join(marketplaceRoot, "plugins/silvic/.codex-plugin/plugin.json"),
  );
  if (
    manifest["name"] !== "silvic" ||
    manifest["version"] !== appVersion ||
    manifest["repository"] !== silvicCodexPlugin.repository
  ) {
    throw new Error(
      "The packaged Silvic plugin version or repository differs.",
    );
  }
}

function readMarketplaces(value: unknown): { name: string; root: string }[] {
  if (!isRecord(value) || !Array.isArray(value["marketplaces"])) {
    throw new Error("Codex marketplace inventory is unavailable.");
  }
  return value["marketplaces"].flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["name"] !== "string" ||
      typeof entry["root"] !== "string"
    ) {
      return [];
    }
    return [{ name: entry["name"], root: entry["root"] }];
  });
}

function readInstalledPlugins(value: unknown): InstalledPlugin[] {
  if (!isRecord(value) || !Array.isArray(value["installed"])) {
    throw new Error("Codex plugin inventory is unavailable.");
  }
  return value["installed"].flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry["pluginId"] !== "string" ||
      typeof entry["name"] !== "string" ||
      typeof entry["version"] !== "string" ||
      entry["installed"] !== true ||
      entry["enabled"] !== true
    ) {
      return [];
    }
    const source = entry["source"];
    const marketplaceSource = entry["marketplaceSource"];
    return [
      {
        pluginId: entry["pluginId"],
        name: entry["name"],
        version: entry["version"],
        ...(isRecord(source) && typeof source["path"] === "string"
          ? { sourcePath: source["path"] }
          : {}),
        ...(isRecord(marketplaceSource) &&
        typeof marketplaceSource["source"] === "string"
          ? { marketplaceRoot: marketplaceSource["source"] }
          : {}),
      },
    ];
  });
}

async function isRecognizedLegacyPlugin(
  plugin: InstalledPlugin,
): Promise<boolean> {
  const recognizedSelector =
    /^silvic@silvic-0-1-[0-9A-Za-z.-]+$/.test(plugin.pluginId) ||
    plugin.pluginId === "silvic@personal";
  if (!recognizedSelector || !plugin.sourcePath) return false;
  try {
    const manifest = await readJson(
      join(plugin.sourcePath, ".codex-plugin/plugin.json"),
    );
    return (
      manifest["name"] === "silvic" &&
      manifest["repository"] === silvicCodexPlugin.repository
    );
  } catch {
    return false;
  }
}

async function samePath(left: string, right: string): Promise<boolean> {
  const canonical = async (path: string) => {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  };
  return (await canonical(left)) === (await canonical(right));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object.`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (!isRecord(value) || typeof value[field] !== "string") {
    throw new Error(`Codex did not return ${field}.`);
  }
  return value[field];
}

function pluginEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: "/usr/bin:/bin",
    SILVIC_APP_EXECUTABLE: undefined,
  };
}

async function verifyCliVersion({
  launcher,
  appVersion,
}: {
  launcher: string;
  appVersion: string;
}): Promise<void> {
  const { stdout, stderr } = await executeFile(launcher, ["--version"], {
    cwd: resolve(launcher, ".."),
    encoding: "utf8",
    env: pluginEnvironment(),
    timeout: 10_000,
  });
  if (stderr || stdout.trim() !== appVersion) {
    throw new Error(
      `The Silvic CLI at ${launcher} reports ${stdout.trim() || "no version"}; Desktop is ${appVersion}.`,
    );
  }
}

function mcpExchange(
  launcher: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  requests: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(launcher, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new Error("The installed Silvic MCP check timed out.")),
      );
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      finish(() => {
        if (code !== 0 || stderr) {
          reject(
            new Error(
              `${basename(launcher)} MCP check failed (${String(code)}): ${stderr}`,
            ),
          );
          return;
        }
        try {
          resolvePromise(
            stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const value: unknown = JSON.parse(line);
                if (!isRecord(value)) throw new Error("Invalid MCP response.");
                return value;
              }),
          );
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.end(
      `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
