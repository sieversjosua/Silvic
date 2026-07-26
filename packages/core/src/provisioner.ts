import type { ProvisionResult, ProvisionStep } from "@silvic/contracts";

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
      const result = await this.runner.run({
        executable: "sh",
        arguments: ["-c", step.run],
        cwd: context.root,
        environment: provisionEnvironment(context),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const record: ProvisionResult = {
        label: step.label ?? `Step ${index + 1}`,
        command: step.run,
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
