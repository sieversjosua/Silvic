import {
  isConvexStep,
  isWorkosStep,
  type PackageManager,
  type ProvisionRemedy,
  type ProvisionRemedyId,
  type ProvisionResult,
  type ProvisionStep,
} from "@silvic/contracts";

import type { CommandRunner } from "./command-runner";
import {
  ConvexProvisioner,
  convexDeploymentMinimum,
} from "./convex-provisioner";
import {
  provisionEnvironment,
  type ProvisionContext,
} from "./provision-environment";
import { WorkosProvisioner } from "./workos-provisioner";

/** How much of a command's output is worth keeping to show a person. */
export const provisionOutputLimit = 20_000;

export class Provisioner {
  private readonly convexProvisioner: ConvexProvisioner;
  private readonly workosProvisioner: WorkosProvisioner;

  constructor(private readonly runner: CommandRunner) {
    this.convexProvisioner = new ConvexProvisioner(runner);
    this.workosProvisioner = new WorkosProvisioner(runner);
  }

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
      /** Replace only an expiring, Plot-owned Convex dev deployment. */
      recreateConvex?: boolean;
    } = {},
  ): Promise<ProvisionResult[]> {
    if (
      options.recreateConvex &&
      steps.filter((step) => isConvexStep(step)).length !== 1
    ) {
      throw new Error(
        "Convex recovery requires exactly one typed Convex provisioning step",
      );
    }
    const results: ProvisionResult[] = [];
    for (const [index, step] of steps.entries()) {
      const startedAt = Date.now();
      const command = isConvexStep(step)
        ? "Silvic isolated Convex environment"
        : isWorkosStep(step)
          ? "Silvic emulated WorkOS environment"
          : step.run;
      options.onStepStart?.({ index, command });
      const stepOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onStepOutput
          ? {
              onOutput: (chunk: string) =>
                options.onStepOutput?.({ index, chunk }),
            }
          : {}),
      };
      const result: { exitCode: number; output: string } = isConvexStep(step)
        ? await this.convexProvisioner.run(step, context, {
            ...stepOptions,
            recreate: options.recreateConvex === true,
          })
        : isWorkosStep(step)
          ? await this.workosProvisioner.run(step, context, stepOptions)
          : await this.runner
              .run({
                executable: "sh",
                arguments: ["-c", command],
                cwd: context.root,
                environment: provisionEnvironment(context),
                outputLimit: provisionOutputLimit * 2,
                ...stepOptions,
              })
              .then((shell) => ({
                exitCode: shell.exitCode,
                output: `${shell.stdout}${shell.stderr}`.trim(),
              }));
      const output = result.output.slice(0, provisionOutputLimit);
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
}

/** A runtime must never start against a half-configured plot. */
export function provisionCompleted(
  steps: readonly ProvisionStep[],
  results: readonly ProvisionResult[],
): boolean {
  return (
    results.length === steps.length &&
    results.every((result) => result.exitCode === 0)
  );
}

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
  if (isWorkosStep(step)) {
    if (!/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|network/i.test(output)) {
      return undefined;
    }
    return {
      advice:
        "Fetching @workos/emulate needs the network once; npx caches it afterwards. Connect and provision again.",
    };
  }
  if (!isConvexStep(step)) return undefined;
  if (/Schema validation failed/i.test(output)) {
    if (step.convex.expiration) {
      return {
        advice:
          "The existing isolated Convex deployment contains data rejected by this schema, so repeating the push cannot succeed. Recreate the Plot's expiring dev deployment to continue with an empty database.",
        remedy: {
          id: "convex-recreate",
          label: "Replace the isolated Convex deployment and discard its data",
          dataLoss: true,
          detail:
            "Creates a new expiring dev deployment for this Plot. Documents and file storage in the current deployment are not copied; the previous deployment remains until its configured expiration.",
        },
      };
    }
    return {
      advice:
        "The existing Convex deployment contains data rejected by this schema, so repeating the push cannot succeed. Silvic will not replace a deployment without a configured expiration; remove the incompatible data in Convex or add an expiration to this Plot's isolated Convex recipe before retrying.",
    };
  }
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
  switch (remedy) {
    case "convex-cli":
      return `${addPackage(packageManager)} convex@${convexDeploymentMinimum}`;
    case "convex-recreate":
      throw new Error("Convex recreation is handled by the typed provisioner");
  }
}

/** What the remedy is called while it runs, as opposed to when it is offered. */
export function remedyLabel(remedy: ProvisionRemedyId): string {
  switch (remedy) {
    case "convex-cli":
      return `Install convex ${convexDeploymentMinimum}`;
    case "convex-recreate":
      return "Replace isolated Convex deployment";
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
  if (isConvexStep(step)) return "Convex deployment";
  if (isWorkosStep(step)) return "WorkOS emulator";
  return `Step ${index + 1}`;
}
