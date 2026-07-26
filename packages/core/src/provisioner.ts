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
        : await readConvexTarget(context.sourceRoot);
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
 * A deployment per plot needs `convex deployment create`, which Convex added
 * in convex 1.34. `npx` runs the copy installed in the repository, so an older
 * pin fails with the CLI's own usage text and no hint of the real cause.
 */
const convexDeploymentMinimum = "1.34";

/**
 * Failures Silvic understands better than the tool reporting them. A typed step
 * is a command Silvic wrote, so explaining why it could not run is its job —
 * and where the repair is a single package update, offering to make it.
 */
export function provisionDiagnosis(
  step: ProvisionStep,
  output: string,
): { advice: string; remedy?: ProvisionRemedy } | undefined {
  if (!isConvexStep(step)) return undefined;
  if (!/unknown command '?deployment'?/i.test(output)) return undefined;
  return {
    advice: `This plot's Convex CLI is too old to give it its own deployment: \`convex deployment create\` arrived in convex ${convexDeploymentMinimum}.`,
    remedy: { id: "convex-cli", label: "Update Convex and provision again" },
  };
}

/**
 * What a remedy runs, in the plot where provisioning failed. Updating there
 * rather than in the source checkout keeps the change reviewable: it lands as
 * ordinary work in the plot, to be committed with everything else.
 */
export function remedyCommand(
  remedy: ProvisionRemedyId,
  packageManager: PackageManager | undefined,
): string {
  // One remedy so far; the switch is where the next one goes.
  switch (remedy) {
    case "convex-cli":
      return `${addPackage(packageManager)} convex@latest`;
  }
}

/** What the remedy is called while it runs, as opposed to when it is offered. */
export function remedyLabel(remedy: ProvisionRemedyId): string {
  switch (remedy) {
    case "convex-cli":
      return "Update Convex";
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
): Promise<{ team: string; project: string } | undefined> {
  try {
    const contents = await readFile(join(sourceRoot, ".env.local"), "utf8");
    const line = contents
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith("CONVEX_DEPLOYMENT="));
    const team = line?.match(/team:\s*([^,\s]+)/)?.[1];
    const project = line?.match(/project:\s*([^,\s]+)/)?.[1];
    return team && project ? { team, project } : undefined;
  } catch {
    return undefined;
  }
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
