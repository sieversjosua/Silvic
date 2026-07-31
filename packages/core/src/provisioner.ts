import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isConvexStep,
  type PackageManager,
  type ProvisionRemedy,
  type ProvisionRemedyId,
  type ProvisionResult,
  type ProvisionStep,
} from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";

export interface ProvisionContext {
  /** The new plot's working directory. */
  root: string;
  /** The checkout the plot was branched from. */
  sourceRoot: string;
  /** The project's primary checkout, used only when the source has no target. */
  projectRoot?: string;
  project: string;
  plot: string;
  branch?: string;
  url?: string;
  packageManager?: PackageManager;
}

/** How much of a command's output is worth keeping to show a person. */
export const provisionOutputLimit = 20_000;

export class Provisioner {
  constructor(private readonly runner: CommandRunner) {}

  /**
   * Steps run in order and stop at the first failure. A plot that fails to
   * provision is still a plot: the results say which step failed and with what
   * output, so it can be retried rather than discarded.
   */
  async run(
    steps: readonly ProvisionStep[],
    context: ProvisionContext,
    options: {
      signal?: AbortSignal;
      /** Before the command runs, once its typed form has been resolved. */
      onStepStart?: (step: { index: number; command: string }) => void;
      /** Each chunk the running step prints, in the order it arrives. */
      onStepOutput?: (step: { index: number; chunk: string }) => void;
      onStep?: (result: ProvisionResult, index: number) => void;
    } = {},
  ): Promise<ProvisionResult[]> {
    const results: ProvisionResult[] = [];
    for (const [index, step] of steps.entries()) {
      const startedAt = Date.now();
      const command = await this.resolve(step, context);
      options.onStepStart?.({ index, command });
      const result = await this.runner.run({
        executable: "sh",
        arguments: ["-c", command],
        cwd: context.root,
        environment: provisionEnvironment(context),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onStepOutput
          ? {
              onOutput: (chunk: string) =>
                options.onStepOutput?.({ index, chunk }),
            }
          : {}),
      });
      const output = `${result.stdout}${result.stderr}`
        .trim()
        .slice(0, provisionOutputLimit);
      const diagnosis =
        result.exitCode === 0 ? undefined : provisionDiagnosis(step, output);
      const record: ProvisionResult = {
        label: provisionStepLabel(step, index),
        command,
        exitCode: result.exitCode,
        output,
        durationMs: Date.now() - startedAt,
        ...(diagnosis ? diagnosis : {}),
      };
      results.push(record);
      options.onStep?.(record, index);
      if (result.exitCode !== 0) break;
    }
    return results;
  }

  /** A typed step becomes the command it stands for; shell steps pass through. */
  private async resolve(
    step: ProvisionStep,
    context: ProvisionContext,
  ): Promise<string> {
    if (!isConvexStep(step)) return step.run;
    const target =
      step.convex.team && step.convex.project
        ? { team: step.convex.team, project: step.convex.project }
        : await readConvexTarget(context.sourceRoot, context.projectRoot);
    if (!target) {
      throw new Error(
        "No Convex team and project set, and none found in the source checkout's .env.local",
      );
    }
    const name = step.convex.name.replaceAll("{plot}", context.plot);
    const reference = `${target.team}:${target.project}:${name}`;
    return `${execRunner(context.packageManager)} convex deployment create ${shellQuote(reference)} --type dev --select`;
  }
}

/**
 * `convex deployment create` arrived in convex 1.34, but naming the project in
 * the reference — `team:project:dev/plot` — only arrived in 1.40. A plot needs
 * that form: `.env.local` is git-ignored, so a fresh worktree carries no Convex
 * configuration and a CLI that can only read the directory answers "No project
 * configured". Verified against 1.34, 1.35, 1.37 and 1.39, which document only
 * a bare reference, and 1.40 onwards, which document the team and project one.
 */
const convexDeploymentMinimum = "1.40";

/**
 * Failures Silvic understands better than the tool reporting them. A typed step
 * is a command Silvic wrote, so explaining why it could not run is its job —
 * and where the repair is a single package update, offering to make it.
 */
export function provisionDiagnosis(
  step: ProvisionStep,
  output: string,
): { advice: string; remedy?: ProvisionRemedy } | undefined {
  const conflict = peerConflict(output);
  if (conflict) {
    return {
      advice: `${conflict} holds Convex to a version this plot cannot use, so the package manager refused to install anything. Update that package to a release built for a newer Convex, or drop the Convex step from the recipe until you can.`,
    };
  }
  if (!isConvexStep(step)) return undefined;
  if (!/unknown command '?deployment'?|no project configured/i.test(output)) {
    return undefined;
  }
  return {
    advice: `This plot's Convex CLI cannot create a deployment for a plot. A worktree carries no \`.env.local\`, so the project has to be named in the command, which convex ${convexDeploymentMinimum} was the first to accept. Silvic asks for exactly that version rather than the newest, so packages pinning an older Convex still resolve.`,
    remedy: {
      id: "convex-cli",
      label: `Install convex ${convexDeploymentMinimum} and provision again`,
    },
  };
}

/**
 * npm refuses an install outright when a package peer-depends on a version
 * range the tree cannot satisfy, and buries which package that is in a wall of
 * text. Naming it is the difference between a dead end and a next step.
 */
function peerConflict(output: string): string | undefined {
  if (!/ERESOLVE/.test(output)) return undefined;
  const pinned = output.match(/peer convex@"[^"]+" from (\S+@\S+)/);
  return pinned?.[1];
}

/**
 * What a remedy runs, in the plot where provisioning failed. Updating there
 * rather than in the source checkout keeps the change reviewable: it lands as
 * ordinary work in the plot, to be committed with everything else.
 *
 * The version asked for is the one that introduced the feature, never the
 * newest. A repository holds packages that peer-depend on Convex within a
 * range, and reaching past that range leaves a tree which no longer installs,
 * so the repair has to be the smallest step that clears the failure. It can
 * only ever raise the version: it is offered when the CLI is older than this.
 */
export function remedyCommand(
  remedy: ProvisionRemedyId,
  packageManager: PackageManager | undefined,
): string {
  // One remedy so far; the switch is where the next one goes.
  switch (remedy) {
    case "convex-cli":
      return `${addPackage(packageManager)} convex@${convexDeploymentMinimum}`;
  }
}

/** What the remedy is called while it runs, as opposed to when it is offered. */
export function remedyLabel(remedy: ProvisionRemedyId): string {
  switch (remedy) {
    case "convex-cli":
      return `Install convex ${convexDeploymentMinimum}`;
  }
}

function addPackage(packageManager: PackageManager | undefined): string {
  if (packageManager === "bun") return "bun add";
  if (packageManager === "pnpm") return "pnpm add";
  if (packageManager === "yarn") return "yarn add";
  return "npm install";
}

/**
 * What a step is called in the interface. Exported because creation names its
 * steps before it runs them, and the two lists have to agree.
 */
export function provisionStepLabel(step: ProvisionStep, index: number): string {
  if (step.label) return step.label;
  return isConvexStep(step) ? "Convex deployment" : `Step ${index + 1}`;
}

/**
 * The convention a Convex project uses to record where its deployments live:
 * `CONVEX_DEPLOYMENT=dev:name # team: slug, project: slug`.
 */
export async function readConvexTarget(
  sourceRoot: string,
  fallbackRoot?: string,
): Promise<{ team: string; project: string } | undefined> {
  const roots = fallbackRoot
    ? new Set([sourceRoot, fallbackRoot])
    : new Set([sourceRoot]);
  for (const root of roots) {
    try {
      const contents = await readFile(join(root, ".env.local"), "utf8");
      const line = contents
        .split(/\r?\n/)
        .find((candidate) => candidate.startsWith("CONVEX_DEPLOYMENT="));
      const team = line?.match(/team:\s*([^,\s]+)/)?.[1];
      const project = line?.match(/project:\s*([^,\s]+)/)?.[1];
      if (team && project) return { team, project };
    } catch {
      // A source without this optional file falls through to the project root.
    }
  }
  return undefined;
}

function execRunner(packageManager: PackageManager | undefined): string {
  if (packageManager === "bun") return "bunx";
  if (packageManager === "pnpm") return "pnpm dlx";
  if (packageManager === "yarn") return "yarn dlx";
  return "npx";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `WORK_*` is emitted alongside `SILVIC_*` so setup hooks written for work-cli
 * keep working unchanged. Silvic replaces the tool, not the repositories that
 * already rely on its contract.
 */
export function provisionEnvironment(
  context: ProvisionContext,
): Record<string, string> {
  const shared: Record<string, string> = {
    ROOT: context.root,
    SOURCE_ROOT: context.sourceRoot,
    PROJECT: context.project,
    WORKSPACE: context.plot,
    ...(context.branch ? { BRANCH: context.branch } : {}),
    ...(context.url ? { URL: context.url } : {}),
  };
  const environment: Record<string, string> = { SILVIC_PLOT: context.plot };
  for (const [key, value] of Object.entries(shared)) {
    environment[`SILVIC_${key}`] = value;
    environment[`WORK_${key}`] = value;
  }
  if (context.url) environment["WORK_WEB_URL"] = context.url;
  return environment;
}
