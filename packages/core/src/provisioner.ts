import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isConvexStep,
  type PackageManager,
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

const outputLimit = 20_000;

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
      onStep?: (result: ProvisionResult) => void;
    } = {},
  ): Promise<ProvisionResult[]> {
    const results: ProvisionResult[] = [];
    for (const [index, step] of steps.entries()) {
      const startedAt = Date.now();
      const command = await this.resolve(step, context);
      const result = await this.runner.run({
        executable: "sh",
        arguments: ["-c", command],
        cwd: context.root,
        environment: provisionEnvironment(context),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const record: ProvisionResult = {
        label: step.label ?? defaultLabel(step, index),
        command,
        exitCode: result.exitCode,
        output: `${result.stdout}${result.stderr}`.trim().slice(0, outputLimit),
        durationMs: Date.now() - startedAt,
      };
      results.push(record);
      options.onStep?.(record);
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

function defaultLabel(step: ProvisionStep, index: number): string {
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
