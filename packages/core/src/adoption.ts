import type {
  PlotAdoption,
  PlotAdoptionMemberResult,
  PlotAdoptionPlan,
  PlotAdoptionPlanMember,
  ProjectSnapshot,
  ProvisionStep,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { isConvexStep, isWorkosStep } from "@silvic/contracts";
import { provisionStepLabel } from "./provisioner";

/** Persistent providers are typed; opaque shell steps are disclosed as potential side effects. */
export function provisionStepChangesProvider(step: ProvisionStep): boolean {
  return isConvexStep(step) || (!isWorkosStep(step) && "run" in step);
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
  member,
}: {
  project: ProjectSnapshot;
  selectedWorkspaceId: string;
  scope: "single" | "family";
  steps: readonly ProvisionStep[];
  member(
    workspace: WorkspaceSnapshot,
  ): Omit<
    PlotAdoptionPlanMember,
    "workspaceId" | "name" | "branch" | "path" | "status"
  >;
}): PlotAdoptionPlan {
  const plannedSteps = steps.map((step, index) => ({
    label: provisionStepLabel(step, index),
    providerChanging: provisionStepChangesProvider(step),
  }));
  return {
    projectId: project.id,
    scope,
    members: adoptionMembers(project, selectedWorkspaceId, scope).map(
      (workspace) => ({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        branch: workspace.branch,
        path: workspace.path,
        status: workspace.adoption?.status ?? "not-adopted",
        ...member(workspace),
      }),
    ),
    steps: plannedSteps,
    requiresProviderConfirmation: plannedSteps.some(
      (step) => step.providerChanging,
    ),
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
