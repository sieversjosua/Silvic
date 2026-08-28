import type {
  PlotAdoption,
  PlotAdoptionMemberResult,
  PlotAdoptionPlan,
  PlotAdoptionPlanMember,
  PlotAdoptionRunResult,
  PlotProvisionRunResult,
  PlotResourceDefinition,
  ProjectSnapshot,
  ProvisionStep,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { isConvexStep, isWorkosStep } from "@silvic/contracts";
import { provisionStepLabel } from "./provisioner";

/** Typed providers are known; shell steps stay opaque unless declared local-only. */
export function provisionStepChangesProvider(step: ProvisionStep): boolean {
  return (
    isConvexStep(step) ||
    (!isWorkosStep(step) && "run" in step && step.providerChanges !== false)
  );
}

export function adoptionMembers(
  project: ProjectSnapshot,
  selectedWorkspaceId: string,
  scope: "single" | "family",
): WorkspaceSnapshot[] {
  const byId = new Map(
    project.workspaces.map((workspace) => [workspace.workspaceId, workspace]),
  );
  const selected = byId.get(selectedWorkspaceId);
  if (!selected || selected.isPrimary)
    throw new Error("Choose a discovered worktree");
  if (scope === "single") return [selected];

  const result: WorkspaceSnapshot[] = [];
  const seen = new Set<string>();
  let current: WorkspaceSnapshot | undefined = selected;
  while (current && !current.isPrimary && !seen.has(current.workspaceId)) {
    seen.add(current.workspaceId);
    result.unshift(current);
    current = current.lineage?.parentWorkspaceId
      ? byId.get(current.lineage.parentWorkspaceId)
      : undefined;
  }
  return result;
}

export function buildAdoptionPlan({
  project,
  selectedWorkspaceId,
  scope,
  steps,
  resources = {},
  automaticAdoption = false,
  member,
}: {
  project: ProjectSnapshot;
  selectedWorkspaceId: string;
  scope: "single" | "family";
  steps: readonly ProvisionStep[];
  resources?: Readonly<Record<string, PlotResourceDefinition>>;
  automaticAdoption?: boolean;
  member(
    workspace: WorkspaceSnapshot,
  ): Omit<
    PlotAdoptionPlanMember,
    "workspaceId" | "name" | "branch" | "path" | "status"
  >;
}): PlotAdoptionPlan {
  const members = adoptionMembers(project, selectedWorkspaceId, scope);
  const selected = project.workspaces.find(
    (workspace) => workspace.workspaceId === selectedWorkspaceId,
  );
  const recovery = selected?.provisioning?.steps.find(
    (step) => step.exitCode !== 0 && step.remedy,
  )?.remedy;
  const plannedSteps = steps.map((step, index) => ({
    label: provisionStepLabel(step, index),
    providerChanging: provisionStepChangesProvider(step),
  }));
  return {
    projectId: project.id,
    scope,
    members: members.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      branch: workspace.branch,
      path: workspace.path,
      status: workspace.adoption?.status ?? "not-adopted",
      ...member(workspace),
    })),
    steps: plannedSteps,
    ...(automaticAdoption
      ? {
          automaticAdoption: assessAutomaticAdoption({
            members,
            steps,
            resources,
          }),
        }
      : {}),
    ...(recovery
      ? { recovery: { ...recovery, providerChanging: true as const } }
      : {}),
    requiresProviderConfirmation:
      recovery !== undefined ||
      plannedSteps.some((step) => step.providerChanging),
  };
}

function assessAutomaticAdoption({
  members,
  steps,
  resources,
}: {
  members: readonly WorkspaceSnapshot[];
  steps: readonly ProvisionStep[];
  resources: Readonly<Record<string, PlotResourceDefinition>>;
}): NonNullable<PlotAdoptionPlan["automaticAdoption"]> {
  const reasons: string[] = [];
  if (members.length !== 1 || members[0]?.branch !== "(detached)") {
    reasons.push(
      "Automatic adoption is limited to one detached disposable Plot.",
    );
  }

  const expiringConvex = steps.some(
    (step) =>
      isConvexStep(step) &&
      step.convex.name.startsWith("dev/") &&
      Boolean(step.convex.expiration),
  );
  const localWorkos = steps.some(isWorkosStep);
  for (const [index, step] of steps.entries()) {
    const label = provisionStepLabel(step, index);
    if (isConvexStep(step)) {
      if (!step.convex.name.startsWith("dev/")) {
        reasons.push(`${label}: only a dev deployment can be automated.`);
      }
      if (!step.convex.expiration) {
        reasons.push(`${label}: an expiration is required.`);
      }
    } else if (!isWorkosStep(step) && step.providerChanges !== false) {
      reasons.push(`${label}: shell steps must declare providerChanges false.`);
    }
  }

  for (const [id, resource] of Object.entries(resources)) {
    if (resource.isolation !== "isolated") {
      reasons.push(
        `${id}: ${resource.isolation} resources are not eligible for automatic adoption.`,
      );
      continue;
    }
    if (resource.provider === "web" && resource.command) continue;
    if (resource.provider === "convex" && expiringConvex) continue;
    if (resource.provider === "workos" && localWorkos && resource.command) {
      continue;
    }
    reasons.push(
      `${id}: ${resource.provider} has no typed expiration or teardown managed by Silvic.`,
    );
  }

  return {
    policy: "isolated-disposable",
    eligible: reasons.length === 0,
    reasons,
  };
}

export async function executeAdoption({
  members,
  state,
  persist,
  run,
}: {
  members: readonly PlotAdoptionPlanMember[];
  state(workspaceId: string): PlotAdoption | undefined;
  persist(workspaceId: string, adoption: PlotAdoption): void | Promise<void>;
  run(
    member: PlotAdoptionPlanMember,
  ): Promise<Omit<PlotAdoptionMemberResult, "workspaceId" | "name" | "status">>;
}): Promise<PlotAdoptionMemberResult[]> {
  const results: PlotAdoptionMemberResult[] = [];
  for (const member of members) {
    const previous = state(member.workspaceId);
    if (previous?.status === "adopted") {
      results.push({
        workspaceId: member.workspaceId,
        name: member.name,
        status: "already-adopted",
      });
      continue;
    }
    const attempt = (previous?.attempt ?? 0) + 1;
    await persist(member.workspaceId, {
      status: "adopting",
      at: new Date().toISOString(),
      attempt,
    });
    try {
      const result = await run(member);
      await persist(member.workspaceId, {
        status: "adopted",
        at: new Date().toISOString(),
        attempt,
      });
      results.push({
        workspaceId: member.workspaceId,
        name: member.name,
        status: "adopted",
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persist(member.workspaceId, {
        status: "failed",
        at: new Date().toISOString(),
        attempt,
        error: message,
      });
      results.push({
        workspaceId: member.workspaceId,
        name: member.name,
        status: "failed",
        error: message,
      });
    }
  }
  return results;
}

/**
 * The shared desktop/automation adoption transaction: confirm the displayed
 * provider plan, reserve its exact local identity, provision, and persist each
 * member outcome.
 */
export async function executePlannedAdoption({
  plan,
  confirmProviderChanges,
  state,
  persist,
  reserve,
  provision,
}: {
  plan: PlotAdoptionPlan;
  confirmProviderChanges: boolean;
  state(workspaceId: string): PlotAdoption | undefined;
  persist(workspaceId: string, adoption: PlotAdoption): void | Promise<void>;
  reserve(member: PlotAdoptionPlanMember): void | Promise<void>;
  provision(member: PlotAdoptionPlanMember): Promise<PlotProvisionRunResult>;
}): Promise<PlotAdoptionRunResult> {
  if (plan.requiresProviderConfirmation && !confirmProviderChanges) {
    throw new Error(
      "Confirm the listed provider changes before adopting these plots",
    );
  }
  const members = await executeAdoption({
    members: plan.members,
    state,
    persist,
    run: async (member) => {
      await reserve(member);
      const result = await provision(member);
      const failed = result.provision.find((step) => step.exitCode !== 0);
      if (failed) throw new Error(`${failed.label} failed`);
      if (result.runtime.status === "failed") {
        throw new Error(
          result.runtime.detail ?? "Plot runtimes failed to start",
        );
      }
      if (result.readiness.status === "failed") {
        throw new Error(
          result.readiness.detail ?? "Plot preview did not become ready",
        );
      }
      return {
        provision: result.provision,
        runtime: result.runtime,
        readiness: result.readiness,
      };
    },
  });
  return { members };
}
