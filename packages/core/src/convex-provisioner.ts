import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConvexStep } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import {
  provisionEnvironment,
  type ProvisionContext,
} from "./provision-environment";

/**
 * `convex deployment create` arrived in convex 1.34, but naming the project in
 * the reference — `team:project:dev/plot` — only arrived in 1.40. A plot needs
 * that form because a fresh worktree carries no Convex configuration.
 */
export const convexDeploymentMinimum = "1.40";
const convexCliVersion = "1.42.3";
const deploymentEnvironmentKeys = new Set([
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_SITE_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
  "NEXT_PUBLIC_CONVEX_URL",
]);

/**
 * Owns the complete Convex isolation contract for one plot. Generic recipe
 * orchestration deliberately stays in Provisioner.
 */
export class ConvexProvisioner {
  constructor(private readonly runner: CommandRunner) {}

  async run(
    step: ConvexStep,
    context: ProvisionContext,
    options: { signal?: AbortSignal; onOutput?: (chunk: string) => void } = {},
  ): Promise<{ exitCode: number; output: string }> {
    const source = await readSourceEnvironment(
      context.sourceRoot,
      context.sourceFallbackRoots ?? [],
    );
    const target =
      step.convex.team && step.convex.project
        ? { team: step.convex.team, project: step.convex.project }
        : convexTargetIn(source.contents);
    if (!target) {
      throw new Error(
        "No Convex team and project set, and none found in the source checkout's .env.local",
      );
    }

    const messages: string[] = [];
    const announce = (message: string): void => {
      messages.push(message);
      options.onOutput?.(`${message}\n`);
    };
    announce(
      `Using Silvic Convex CLI ${convexCliVersion}; the repository dependency stays unchanged`,
    );
    const runCli = async (
      arguments_: readonly string[],
      cwd: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const result = await this.runner.run({
        executable: "npx",
        arguments: ["--yes", `convex@${convexCliVersion}`, ...arguments_],
        cwd,
        environment: {
          ...provisionEnvironment(context),
          CONVEX_AGENT_MODE: "anonymous",
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      for (const notice of convexUpdateNotices(result.stderr)) {
        announce(notice);
      }
      return result;
    };
    const failed = (
      action: string,
      result: { exitCode: number; stdout: string; stderr: string },
    ): { exitCode: number; output: string } => ({
      exitCode: result.exitCode,
      output: [
        ...messages,
        `${action} failed`,
        sanitizeProvisionOutput(`${result.stdout}${result.stderr}`.trim()),
      ]
        .filter(Boolean)
        .join("\n"),
    });

    let sourceServerEnvironment = "";
    if (source.configured) {
      announce("Reading the source Convex environment");
      const listed = await runCli(["env", "list"], source.root);
      if (listed.exitCode !== 0) {
        return failed("Reading the source Convex environment", listed);
      }
      sourceServerEnvironment = listed.stdout;
    }

    const workspaceEnvPath = join(context.root, ".env.local");
    let workspaceEnvironment = await optionalFile(workspaceEnvPath);
    if (!environmentValue(workspaceEnvironment, "CONVEX_DEPLOYMENT")) {
      // Before a deployment is selected, any file here is an interrupted
      // setup rather than an isolated environment. Rebuild it from the source
      // so a retry cannot silently keep a partial set of local variables.
      workspaceEnvironment = withoutEnvironmentKeys(
        source.contents,
        deploymentEnvironmentKeys,
      );
      workspaceEnvironment = withApplicationUrls(
        workspaceEnvironment,
        context.url,
      );
      await writePrivateEnvironment(workspaceEnvPath, workspaceEnvironment);
    }

    const name = step.convex.name.replaceAll("{plot}", context.plot);
    const reference = `${target.team}:${target.project}:${name}`;
    if (!environmentValue(workspaceEnvironment, "CONVEX_DEPLOYMENT")) {
      announce(`Creating Convex dev deployment ${name}`);
      const created = await runCli(
        [
          "deployment",
          "create",
          reference,
          "--type",
          "dev",
          "--select",
          ...(step.convex.expiration
            ? ["--expiration", step.convex.expiration]
            : []),
        ],
        context.root,
      );
      if (created.exitCode !== 0) {
        return failed("Creating the Convex deployment", created);
      }
      workspaceEnvironment = await optionalFile(workspaceEnvPath);
    }

    if (!environmentValue(workspaceEnvironment, "CONVEX_DEPLOY_KEY")) {
      announce("Scoping Convex access to this plot");
      const token = await runCli(
        [
          "deployment",
          "token",
          "create",
          `silvic-${context.plot}`,
          "--save-env",
        ],
        context.root,
      );
      if (token.exitCode !== 0) {
        return failed("Creating the scoped Convex deploy key", token);
      }
      workspaceEnvironment = await optionalFile(workspaceEnvPath);
    }

    const convexUrl = environmentValue(
      workspaceEnvironment,
      "NEXT_PUBLIC_CONVEX_URL",
    );
    const siteUrl = convexUrl ? convexSiteUrl(convexUrl) : undefined;
    workspaceEnvironment = setEnvironmentValues(workspaceEnvironment, {
      ...(convexUrl ? { NEXT_PUBLIC_CONVEX_URL: convexUrl } : {}),
      ...(siteUrl
        ? {
            NEXT_PUBLIC_CONVEX_SITE_URL: siteUrl,
            CONVEX_SITE_URL: siteUrl,
          }
        : {}),
      ...(context.url
        ? {
            NEXT_PUBLIC_APP_URL: context.url,
            NEXT_PUBLIC_SITE_URL: context.url,
          }
        : {}),
    });
    await writePrivateEnvironment(workspaceEnvPath, workspaceEnvironment);

    if (sourceServerEnvironment.trim()) {
      announce("Syncing Convex environment variables");
      const serverEnvironment = setEnvironmentValues(
        withoutEnvironmentKeys(
          sourceServerEnvironment,
          deploymentEnvironmentKeys,
        ),
        {
          ...(convexUrl ? { NEXT_PUBLIC_CONVEX_URL: convexUrl } : {}),
          ...(siteUrl ? { CONVEX_SITE_URL: siteUrl } : {}),
          ...(context.url
            ? {
                NEXT_PUBLIC_APP_URL: context.url,
                NEXT_PUBLIC_SITE_URL: context.url,
              }
            : {}),
        },
      );
      const temporary = await mkdtemp(join(tmpdir(), "silvic-convex-env-"));
      const file = join(temporary, ".env");
      try {
        await writePrivateEnvironment(file, serverEnvironment);
        const synced = await runCli(
          ["env", "set", "--force", "--from-file", file],
          context.root,
        );
        if (synced.exitCode !== 0) {
          return failed("Syncing Convex environment variables", synced);
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }

    announce("Pushing Convex schema and functions");
    const pushed = await runCli(["dev", "--once"], context.root);
    if (pushed.exitCode !== 0) {
      return failed("Pushing Convex schema and functions", pushed);
    }
    return { exitCode: 0, output: messages.join("\n") };
  }
}

/** Read the first fully configured Convex target across eligible checkouts. */
export async function readConvexTarget(
  sourceRoot: string,
  fallbackRoots: readonly string[] = [],
): Promise<{ team: string; project: string } | undefined> {
  const source = await readSourceEnvironment(sourceRoot, fallbackRoots);
  return convexTargetIn(source.contents);
}

async function readSourceEnvironment(
  sourceRoot: string,
  fallbackRoots: readonly string[],
): Promise<{ root: string; contents: string; configured: boolean }> {
  const candidates = [...new Set([sourceRoot, ...fallbackRoots])];
  const selectedContents = await optionalFile(join(sourceRoot, ".env.local"));
  for (const root of candidates) {
    const contents = await optionalFile(join(root, ".env.local"));
    if (convexTargetIn(contents)) {
      const selectedWithoutIncompleteTarget =
        root === sourceRoot
          ? selectedContents
          : withoutEnvironmentKeys(
              selectedContents,
              new Set(["CONVEX_DEPLOYMENT"]),
            );
      return {
        root,
        contents: mergeEnvironmentContents(
          selectedWithoutIncompleteTarget,
          contents,
        ),
        configured: true,
      };
    }
  }
  return {
    root: sourceRoot,
    contents: selectedContents,
    configured: false,
  };
}

function convexTargetIn(
  contents: string,
): { team: string; project: string } | undefined {
  const line = contents
    .split(/\r?\n/)
    .find((candidate) => environmentKey(candidate) === "CONVEX_DEPLOYMENT");
  const team = line?.match(/team:\s*([^,\s]+)/)?.[1];
  const project = line?.match(/project:\s*([^,\s]+)/)?.[1];
  return team && project ? { team, project } : undefined;
}

function mergeEnvironmentContents(primary: string, fallback: string): string {
  if (!primary.trim()) return fallback;
  if (primary === fallback) return primary;
  const primaryKeys = new Set(
    primary
      .split(/\r?\n/)
      .map(environmentKey)
      .filter((key) => key !== undefined),
  );
  const additions = fallback
    .split(/\r?\n/)
    .filter((line) => {
      const key = environmentKey(line);
      return key !== undefined && !primaryKeys.has(key);
    });
  return [primary.trimEnd(), ...additions].join("\n").replace(/\n*$/, "\n");
}

async function optionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function environmentKey(line: string): string | undefined {
  return line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
}

function environmentValue(contents: string, key: string): string | undefined {
  const line = contents
    .split(/\r?\n/)
    .find((candidate) => environmentKey(candidate) === key);
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^(['"])(.*)\1$/, "$2").split(/\s+#\s+/, 1)[0];
}

function withoutEnvironmentKeys(
  contents: string,
  keys: ReadonlySet<string>,
): string {
  return contents
    .split(/\r?\n/)
    .filter((line) => {
      const key = environmentKey(line);
      return !key || !keys.has(key);
    })
    .join("\n")
    .replace(/\n*$/, "\n");
}

function setEnvironmentValues(
  contents: string,
  values: Readonly<Record<string, string>>,
): string {
  const keys = new Set(Object.keys(values));
  const base = withoutEnvironmentKeys(contents, keys).trimEnd();
  const additions = Object.entries(values).map(
    ([key, value]) => `${key}=${value}`,
  );
  return [...(base ? [base] : []), ...additions].join("\n") + "\n";
}

function withApplicationUrls(
  contents: string,
  url: string | undefined,
): string {
  return url
    ? setEnvironmentValues(contents, {
        NEXT_PUBLIC_APP_URL: url,
        NEXT_PUBLIC_SITE_URL: url,
      })
    : contents;
}

async function writePrivateEnvironment(
  path: string,
  contents: string,
): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

function convexSiteUrl(convexUrl: string): string {
  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }
  const url = new URL(convexUrl);
  const port = Number.parseInt(url.port, 10);
  if (!Number.isNaN(port)) url.port = String(port + 1);
  return url.toString().replace(/\/$/, "");
}

function sanitizeProvisionOutput(output: string): string {
  const withoutPrivateKeys = output.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  return withoutPrivateKeys
    .split(/\r?\n/)
    .map((line) =>
      /(?:api[_-]?key|secret|token|password|deploy[_-]?key|private[_-]?key|authorization)/i.test(
        line,
      )
        ? "[REDACTED SECRET OUTPUT]"
        : line,
    )
    .join("\n")
    .replace(
      /\b(?:dev|prod|preview):[A-Za-z0-9-]+\|[A-Za-z0-9._~+/-]+=*/g,
      "[REDACTED CONVEX DEPLOY KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED JWT]",
    );
}

function convexUpdateNotices(stderr: string): readonly string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        /(?:update|upgrade|newer version|new version|npm notice)/i.test(line),
    )
    .map(sanitizeProvisionOutput);
}
