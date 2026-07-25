import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, normalize, sep } from "node:path";

/**
 * work-cli already gives every worktree a slug, including the ones agent
 * harnesses create in opaque directories like `~/.codex/worktrees/70b0/SynTwin`.
 * Reading that state turns those into names a person can recognise instead of a
 * row of identical repository basenames.
 */
export async function readWorkCliNames(
  stateRoot?: string,
): Promise<ReadonlyMap<string, string>> {
  const workspaces = await readWorkCliWorkspaces(stateRoot);
  return new Map(
    [...workspaces].map(([path, entry]) => [path, entry.workspace]),
  );
}

export interface WorkCliWorkspace {
  project: string;
  workspace: string;
  root: string;
}

/** Every worktree work-cli tracks, keyed by its normalised root path. */
export async function readWorkCliWorkspaces(
  stateRoot = process.env.WORK_STATE_ROOT ?? join(homedir(), ".work-cli"),
): Promise<ReadonlyMap<string, WorkCliWorkspace>> {
  const found = new Map<string, WorkCliWorkspace>();
  for (const project of await directories(join(stateRoot, "projects"))) {
    const workspaceRoot = join(stateRoot, "projects", project, "workspaces");
    for (const workspace of await directories(workspaceRoot)) {
      const state = await readState(
        join(workspaceRoot, workspace, "state.json"),
      );
      if (state) found.set(normalize(state.root), state);
    }
  }
  return found;
}

/**
 * Pick the first name that actually tells this worktree apart from its siblings.
 * Detached worktrees all fall back to the repository folder name, so a whole
 * column of them ends up reading "SynTwin" without this.
 */
export function resolveDisplayName(options: {
  path: string;
  recorded?: string | undefined;
  workCliName?: string | undefined;
  gitName: string;
}): string {
  const { path, recorded, workCliName, gitName } = options;
  if (tellsApart(recorded, path)) return recorded;
  if (workCliName) return workCliName;
  if (tellsApart(gitName, path)) return gitName;
  return pathQualifier(path) ?? gitName;
}

function tellsApart(
  name: string | undefined,
  path: string,
): name is string {
  return (
    !!name && name !== basename(normalize(path)) && name !== "(detached)"
  );
}

/**
 * Harness worktrees live at `<harness>/worktrees/<id>/<repo>`, so the directory
 * above the repository folder is the only part that differs. Naming it the way
 * work-cli would — `codex-167c` — keeps one vocabulary across both.
 */
function pathQualifier(path: string): string | undefined {
  const parts = normalize(path).split(sep).filter(Boolean);
  if (parts.at(-3) !== "worktrees") return undefined;
  const identifier = parts.at(-2);
  if (!identifier) return undefined;
  const owner = parts.at(-4);
  const prefix = owner?.startsWith(".") ? owner.slice(1) : undefined;
  return prefix ? `${prefix}-${identifier}` : identifier;
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // work-cli is optional; its absence simply provides no names.
    return [];
  }
}

async function readState(
  path: string,
): Promise<WorkCliWorkspace | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "root" in value &&
      typeof value.root === "string" &&
      "workspace" in value &&
      typeof value.workspace === "string" &&
      "project" in value &&
      typeof value.project === "string"
    ) {
      return {
        root: value.root,
        workspace: value.workspace,
        project: value.project,
      };
    }
  } catch {
    // An unreadable or half-written state file is skipped.
  }
  return undefined;
}
