import type { PackageManager } from "@silvic/contracts";

export interface ProvisionContext {
  /** The new plot's working directory. */
  root: string;
  /** The checkout the plot was branched from. */
  sourceRoot: string;
  /** Other full checkouts of the same repository; linked worktrees stay out. */
  sourceFallbackRoots?: readonly string[];
  project: string;
  plot: string;
  branch?: string;
  url?: string;
  packageManager?: PackageManager;
}

/** Build the stable plot context available to repository-specific commands. */
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
  const environment: Record<string, string> = {
    SILVIC_PLOT: context.plot,
    ...(context.url ? { HOST: new URL(context.url).hostname } : {}),
  };
  for (const [key, value] of Object.entries(shared)) {
    environment[`SILVIC_${key}`] = value;
    environment[`WORK_${key}`] = value;
  }
  if (context.url) environment["WORK_WEB_URL"] = context.url;
  return environment;
}
