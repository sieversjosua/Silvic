import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

import type { ConvexServiceAttachment, ConvexStep } from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import {
  environmentKey,
  environmentValue,
  optionalFile,
  sanitizeProvisionOutput,
  setEnvironmentValues,
  withoutEnvironmentKeys,
  writePrivateEnvironment,
} from "./environment-files";
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
  "PUBLIC_CONVEX_URL",
  "PUBLIC_CONVEX_SITE_URL",
  "VITE_CONVEX_URL",
  "VITE_CONVEX_SITE_URL",
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
    options: {
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
      recreate?: boolean;
      attachment?: ConvexServiceAttachment;
    } = {},
  ): Promise<{
    exitCode: number;
    output: string;
    attachment?: ConvexServiceAttachment;
  }> {
    const { source, target } = await convexSourceAndTarget(step, context);

    const messages: string[] = [];
    const announce = (message: string): void => {
      messages.push(message);
      options.onOutput?.(`${message}\n`);
    };
    announce(
      `Using Silvic Convex CLI ${convexCliVersion}; the repository dependency stays unchanged`,
    );
    let establishedAttachment: ConvexServiceAttachment | undefined;
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
        outputLimit: 100_000,
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
    ): {
      exitCode: number;
      output: string;
      attachment?: ConvexServiceAttachment;
    } => ({
      exitCode: result.exitCode,
      output: [
        ...messages,
        `${action} failed`,
        sanitizeProvisionOutput(`${result.stdout}${result.stderr}`.trim()),
      ]
        .filter(Boolean)
        .join("\n"),
      ...(establishedAttachment ? { attachment: establishedAttachment } : {}),
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
    const previousWorkspaceEnvironment = workspaceEnvironment;
    for (const key of Object.keys(step.convex.environment ?? {})) {
      if (deploymentEnvironmentKeys.has(key)) {
        throw new Error(
          `Convex owns ${key}; it cannot be overridden by the recipe`,
        );
      }
    }
    const configuredName = step.convex.name.replaceAll("{plot}", context.plot);
    let deploymentName = configuredName;
    if (options.recreate) {
      if (!step.convex.expiration) {
        throw new Error(
          "Convex recovery requires an expiration on the typed Convex step",
        );
      }
      const selected = convexDeploymentIn(workspaceEnvironment);
      const attachment = options.attachment;
      const logical = attachment
        ? convexLogicalReferenceIn(attachment.logicalDeploymentRef)
        : undefined;
      if (
        !selected ||
        selected.type !== "dev" ||
        !attachment ||
        attachment.provider !== "convex" ||
        attachment.team !== target.team ||
        attachment.project !== target.project ||
        attachment.deploymentKind !== "dev" ||
        attachment.recipeDeploymentName !== configuredName ||
        !logical ||
        logical.team !== target.team ||
        logical.project !== target.project ||
        !logical.deploymentName.startsWith("dev/") ||
        attachment.physicalDeploymentSlug !== selected.name ||
        attachment.expiration !== step.convex.expiration
      ) {
        throw new Error(
          "Silvic will only replace a selected expiring dev deployment whose structured Service Attachment matches this Plot's typed Convex recipe and physical deployment slug. Adopt the attachment explicitly first if this Plot predates structured provider identity.",
        );
      }
      deploymentName = recoveryDeploymentName(configuredName);
      announce(
        `Replacing Convex dev deployment ${configuredName}; its data will not be copied and the previous deployment will expire ${step.convex.expiration}`,
      );
      workspaceEnvironment = withApplicationUrls(
        withoutEnvironmentKeys(workspaceEnvironment, deploymentEnvironmentKeys),
        context.url,
      );
      await writePrivateEnvironment(workspaceEnvPath, workspaceEnvironment);
    }
    if (
      !options.recreate &&
      !environmentValue(workspaceEnvironment, "CONVEX_DEPLOYMENT")
    ) {
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

    const reference = `${target.team}:${target.project}:${deploymentName}`;
    if (!environmentValue(workspaceEnvironment, "CONVEX_DEPLOYMENT")) {
      announce(`Creating Convex dev deployment ${deploymentName}`);
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
        if (options.recreate) {
          await writePrivateEnvironment(
            workspaceEnvPath,
            previousWorkspaceEnvironment,
          );
        }
        return failed("Creating the Convex deployment", created);
      }
      workspaceEnvironment = await optionalFile(workspaceEnvPath);
      const selected = convexDeploymentIn(workspaceEnvironment);
      if (!selected) {
        throw new Error(
          "Convex created a deployment but did not select a physical deployment in .env.local",
        );
      }
      establishedAttachment = convexAttachment({
        target,
        configuredName,
        logicalDeploymentRef: reference,
        physicalDeploymentSlug: selected.name,
        ...(step.convex.expiration
          ? { expiration: step.convex.expiration }
          : {}),
      });
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

    // Keep Plot-local overrides and identity on retry, but inherit newly added
    // source variables even when this deployment was provisioned previously.
    workspaceEnvironment = mergeEnvironmentContents(
      workspaceEnvironment,
      withoutEnvironmentKeys(source.contents, deploymentEnvironmentKeys),
    );
    const convexUrl = environmentValue(
      workspaceEnvironment,
      "NEXT_PUBLIC_CONVEX_URL",
    );
    const siteUrl = convexUrl ? convexSiteUrl(convexUrl) : undefined;
    const selected = convexDeploymentIn(workspaceEnvironment);
    if (!selected) throw new Error("Convex did not select a deployment");
    const overrides: Record<string, string> = {};
    for (const [key, template] of Object.entries(
      step.convex.environment ?? {},
    )) {
      if (template.includes("{url}") && !context.url) {
        throw new Error(`Recipe environment ${key} requires a Plot URL`);
      }
      overrides[key] = encodeEnvironmentValue(
        template
          .replaceAll("{deployment}", selected.name)
          .replaceAll("{plot}", context.plot)
          .replaceAll("{url}", context.url ?? ""),
      );
    }
    // Framework aliases already in the source must follow the new deployment.
    const inherited = parseEnv(
      [workspaceEnvironment, source.contents, sourceServerEnvironment].join(
        "\n",
      ),
    );
    for (const prefix of ["PUBLIC", "VITE"]) {
      if (convexUrl && `${prefix}_CONVEX_URL` in inherited) {
        overrides[`${prefix}_CONVEX_URL`] = convexUrl;
      }
      if (siteUrl && `${prefix}_CONVEX_SITE_URL` in inherited) {
        overrides[`${prefix}_CONVEX_SITE_URL`] = siteUrl;
      }
    }
    workspaceEnvironment = setEnvironmentValues(workspaceEnvironment, {
      ...overrides,
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

    const inheritedServerEnvironment = mergeEnvironmentContents(
      withoutEnvironmentKeys(workspaceEnvironment, deploymentEnvironmentKeys),
      withoutEnvironmentKeys(
        sourceServerEnvironment,
        deploymentEnvironmentKeys,
      ),
    );
    if (inheritedServerEnvironment.trim()) {
      announce("Syncing Convex environment variables");
      const serverEnvironment = setEnvironmentValues(
        inheritedServerEnvironment,
        {
          ...overrides,
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
    return {
      exitCode: 0,
      output: messages.join("\n"),
      ...(establishedAttachment ? { attachment: establishedAttachment } : {}),
    };
  }

  async missingDisposableAttachment(
    step: ConvexStep,
    context: ProvisionContext,
    otherRoots: readonly string[],
    recorded?: ConvexServiceAttachment,
  ): Promise<ConvexServiceAttachment | undefined> {
    if (
      !step.convex.name.startsWith("dev/") ||
      !step.convex.name.includes("{plot}") ||
      !step.convex.expiration ||
      resolve(context.root) === resolve(context.sourceRoot)
    )
      return undefined;
    const candidate = await this.adopt(step, context);
    const selectedTarget = convexTargetIn(
      await optionalFile(join(context.root, ".env.local")),
    );
    if (
      (!selectedTarget && !recorded) ||
      (selectedTarget &&
        (selectedTarget.team !== candidate.team ||
          selectedTarget.project !== candidate.project))
    )
      return undefined;
    const logical = recorded
      ? convexLogicalReferenceIn(recorded.logicalDeploymentRef)
      : undefined;
    if (
      recorded &&
      (!logical ||
        logical.team !== candidate.team ||
        logical.project !== candidate.project ||
        !logical.deploymentName.startsWith("dev/") ||
        recorded.team !== candidate.team ||
        recorded.project !== candidate.project ||
        recorded.deploymentKind !== "dev" ||
        recorded.recipeDeploymentName !== candidate.recipeDeploymentName ||
        recorded.physicalDeploymentSlug !== candidate.physicalDeploymentSlug ||
        recorded.expiration !== candidate.expiration)
    )
      return undefined;
    for (const root of new Set([context.sourceRoot, ...otherRoots])) {
      if (resolve(root) === resolve(context.root)) continue;
      let contents: string;
      try {
        contents = await readFile(join(root, ".env.local"), "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        return undefined;
      }
      const selected = convexDeploymentIn(contents);
      if (selected?.name === candidate.physicalDeploymentSlug) return undefined;
    }
    if (!/^[a-z]+-[a-z]+-[0-9]+$/.test(candidate.physicalDeploymentSlug))
      return undefined;
    // Ask the control plane using the source checkout's existing CLI login.
    // A revoked deploy key, network failure, or schema error is not absence.
    const result = await this.runner.run({
      executable: "npx",
      arguments: [
        "--yes",
        `convex@${convexCliVersion}`,
        "env",
        "list",
        "--names-only",
        "--deployment",
        candidate.physicalDeploymentSlug,
      ],
      cwd: context.sourceRoot,
      outputLimit: 20_000,
      environment: {
        ...provisionEnvironment(context),
        CONVEX_AGENT_MODE: "anonymous",
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode === 0 || !/\bDeploymentNotFound\b/.test(output))
      return undefined;
    return recorded ?? candidate;
  }

  async adopt(
    step: ConvexStep,
    context: ProvisionContext,
  ): Promise<ConvexServiceAttachment> {
    if (!step.convex.expiration) {
      throw new Error(
        "Convex attachment adoption requires an expiration on the typed Convex step",
      );
    }
    const { target } = await convexSourceAndTarget(step, context);
    const configuredName = step.convex.name.replaceAll("{plot}", context.plot);
    const selected = convexDeploymentIn(
      await optionalFile(join(context.root, ".env.local")),
    );
    if (!selected || selected.type !== "dev") {
      throw new Error(
        "Silvic can only adopt the selected physical Convex dev deployment",
      );
    }
    return convexAttachment({
      target,
      configuredName,
      logicalDeploymentRef: `${target.team}:${target.project}:${configuredName}`,
      physicalDeploymentSlug: selected.name,
      expiration: step.convex.expiration,
    });
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

async function convexSourceAndTarget(
  step: ConvexStep,
  context: ProvisionContext,
): Promise<{
  source: Awaited<ReturnType<typeof readSourceEnvironment>>;
  target: { team: string; project: string };
}> {
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
  return { source, target };
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

function convexDeploymentIn(
  contents: string,
): { type: string; name: string } | undefined {
  const value = environmentValue(contents, "CONVEX_DEPLOYMENT");
  const deployment = value?.match(/^([^:]+):(.+)$/);
  const type = deployment?.[1];
  const name = deployment?.[2];
  return type && name ? { type, name } : undefined;
}

function convexLogicalReferenceIn(
  reference: string,
): { team: string; project: string; deploymentName: string } | undefined {
  const match = reference.match(/^([^:]+):([^:]+):(.+)$/);
  const team = match?.[1];
  const project = match?.[2];
  const deploymentName = match?.[3];
  return team && project && deploymentName
    ? { team, project, deploymentName }
    : undefined;
}

function convexAttachment({
  target,
  configuredName,
  logicalDeploymentRef,
  physicalDeploymentSlug,
  expiration,
}: {
  target: { team: string; project: string };
  configuredName: string;
  logicalDeploymentRef: string;
  physicalDeploymentSlug: string;
  expiration?: string;
}): ConvexServiceAttachment {
  return {
    provider: "convex",
    team: target.team,
    project: target.project,
    deploymentKind: "dev",
    recipeDeploymentName: configuredName,
    logicalDeploymentRef,
    physicalDeploymentSlug,
    ...(expiration ? { expiration } : {}),
  };
}

function recoveryDeploymentName(name: string): string {
  const suffix = `-recovery-${Date.now().toString(36)}`;
  return `${name.slice(0, 200 - suffix.length)}${suffix}`;
}

function mergeEnvironmentContents(primary: string, fallback: string): string {
  if (!primary.trim()) return fallback;
  if (primary === fallback) return primary;
  const primaryKeys = new Set(Object.keys(parseEnv(primary)));
  const additions: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(fallback))) {
    if (primaryKeys.has(key) || value === undefined) continue;
    // The Convex CLI records team/project selection in this line's comment.
    const selection =
      key === "CONVEX_DEPLOYMENT"
        ? fallback.split(/\r?\n/).find((line) => environmentKey(line) === key)
        : undefined;
    additions.push(selection ?? `${key}=${encodeEnvironmentValue(value)}`);
  }
  return [primary.trimEnd(), ...additions].join("\n").replace(/\n*$/, "\n");
}

function encodeEnvironmentValue(value: string): string {
  const encoded = /^[A-Za-z0-9_./:@-]*$/.test(value)
    ? value
    : !value.includes("'")
      ? `'${value}'`
      : `"${value}"`;
  if (parseEnv(`VALUE=${encoded}`)["VALUE"] !== value) {
    throw new Error(
      "A source environment value cannot be represented losslessly in a dotenv file",
    );
  }
  return encoded;
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

function convexSiteUrl(convexUrl: string): string {
  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }
  const url = new URL(convexUrl);
  const port = Number.parseInt(url.port, 10);
  if (!Number.isNaN(port)) url.port = String(port + 1);
  return url.toString().replace(/\/$/, "");
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
