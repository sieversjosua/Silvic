import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { requiredMcpTools } from "./release-contract.mjs";

const appPath = requiredArgument("--app");
const pluginArchive = requiredArgument("--plugin-archive");
const scratch = await mkdtemp(join(tmpdir(), "silvic-distribution-smoke-"));

try {
  const appLauncher = join(appPath, "Contents/Resources/bin/silvic");
  const appVersion = await commandOutput(appLauncher, ["--version"]);

  const documentedBin = join(scratch, "usr/local/bin");
  await mkdir(documentedBin, { recursive: true });
  const documentedSymlink = join(documentedBin, "silvic");
  await symlink(appLauncher, documentedSymlink);
  const symlinkVersion = await commandOutput(documentedSymlink, ["--version"]);
  if (symlinkVersion !== appVersion) {
    throw new Error(
      `Documented symlink reports ${symlinkVersion}; app CLI reports ${appVersion}.`,
    );
  }

  const extracted = join(scratch, "plugin");
  await mkdir(extracted, { recursive: true });
  await run("tar", ["-xzf", pluginArchive, "-C", extracted]);
  const roots = (await readdir(extracted, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  if (roots.length !== 1) {
    throw new Error("Plugin archive must contain exactly one root directory.");
  }
  const pluginRoot = join(extracted, roots[0].name, "plugins/silvic");
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
  );
  if (manifest.version !== appVersion) {
    throw new Error(
      `Extracted plugin ${String(manifest.version)} does not match app CLI ${appVersion}.`,
    );
  }
  const mcpConfiguration = JSON.parse(
    await readFile(join(pluginRoot, ".mcp.json"), "utf8"),
  ).mcpServers?.silvic;
  if (
    mcpConfiguration?.command !== "./bin/silvic" ||
    JSON.stringify(mcpConfiguration.args) !== JSON.stringify(["mcp"])
  ) {
    throw new Error("Extracted plugin MCP launcher configuration is invalid.");
  }

  const replies = await mcpExchange(
    resolve(pluginRoot, mcpConfiguration.command),
    mcpConfiguration.args,
    pluginRoot,
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "silvic-distribution-smoke",
            version: appVersion,
          },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
  );
  const initialized = replies.find((reply) => reply.id === 1);
  const listed = replies.find((reply) => reply.id === 2);
  if (initialized?.result?.serverInfo?.version !== appVersion) {
    throw new Error(
      "Extracted plugin MCP server version does not match the app.",
    );
  }
  if (initialized.result.protocolVersion !== "2025-11-25") {
    throw new Error("Extracted plugin MCP protocol negotiation did not match.");
  }
  const tools = listed?.result?.tools?.map((tool) => tool.name);
  if (JSON.stringify(tools) !== JSON.stringify(requiredMcpTools)) {
    throw new Error(`Extracted plugin tool catalog differs: ${String(tools)}`);
  }
  process.stdout.write(
    `Silvic ${appVersion} packaged CLI, symlink, extracted plugin, MCP initialize, and ${tools.length} tools passed without Node on PATH.\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return resolve(value);
}

async function commandOutput(command, args) {
  const result = await run(command, args);
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            `${basename(command)} exited ${String(code)}: ${stderr || stdout}`,
          ),
        );
    });
  });
}

function mcpExchange(launcher, args, cwd, requests) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(launcher, args, {
      cwd,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        SILVIC_APP_EXECUTABLE: join(appPath, "Contents/MacOS/Silvic"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Extracted plugin MCP smoke timed out."));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || stderr) {
        reject(
          new Error(`Extracted plugin MCP failed (${String(code)}): ${stderr}`),
        );
        return;
      }
      resolvePromise(
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
    });
    child.stdin.end(
      `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    );
  });
}
