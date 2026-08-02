import { basename, normalize, sep } from "node:path";

/** Pick the first name that actually tells a worktree apart from its siblings. */
export function resolveDisplayName(options: {
  path: string;
  recorded?: string | undefined;
  sessionName?: string | undefined;
  gitName: string;
}): string {
  const { path, recorded, sessionName, gitName } = options;
  if (tellsApart(recorded, path)) return recorded;
  if (sessionName) return sessionName;
  if (tellsApart(gitName, path)) return gitName;
  return pathQualifier(path) ?? gitName;
}

function tellsApart(name: string | undefined, path: string): name is string {
  if (!name || name === basename(normalize(path)) || name === "(detached)") {
    return false;
  }

  const parts = normalize(path).split(sep).filter(Boolean);
  const isT3RepositoryName =
    parts.at(-4) === ".t3" && parts.at(-3) === "worktrees" && name === parts.at(-2);
  return !isT3RepositoryName;
}

/**
 * Harness worktrees live at `<harness>/worktrees/<id>/<repo>`, so the directory
 * above the repository folder is the stable distinguishing evidence.
 */
function pathQualifier(path: string): string | undefined {
  const parts = normalize(path).split(sep).filter(Boolean);
  if (parts.at(-3) !== "worktrees") return undefined;
  const identifier = parts.at(-2);
  if (!identifier) return undefined;
  const owner = parts.at(-4);
  const prefix = owner?.startsWith(".") ? owner.slice(1) : undefined;
  if (prefix === "t3") {
    const t3Identifier = parts.at(-1);
    return t3Identifier ? `t3-${t3Identifier}` : undefined;
  }
  return prefix ? `${prefix}-${identifier}` : identifier;
}
