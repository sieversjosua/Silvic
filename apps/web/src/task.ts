import type { IssueSummary } from "@silvic/contracts";

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
