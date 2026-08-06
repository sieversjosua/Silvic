import type {
  IssueSummary,
  PlotCreationResult,
  PlotProvisionRunResult,
} from "@silvic/contracts";

function branchSegment(value: string): string {
  return value
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function branchForPlotName(name: string): string {
  return name
    .split("/")
    .map(branchSegment)
    .filter(Boolean)
    .join("/")
    .slice(0, 96)
    .replace(/[-/]+$/g, "");
}

export function applyProvisionRun<
  T extends Pick<PlotCreationResult, "provision" | "runtime" | "readiness">,
>(result: T, run: PlotProvisionRunResult): T {
  return { ...result, ...run };
}

export function branchIsTaken({
  branch,
  branches,
  creating,
  adopting,
}: {
  branch: string;
  branches: readonly string[];
  creating: boolean;
  adopting: boolean;
}): boolean {
  return !creating && !adopting && branch !== "" && branches.includes(branch);
}

export function branchForIssue(issue: IssueSummary): string {
  const slug = issue.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return `issue/${issue.number}-${slug || "work"}`;
}
