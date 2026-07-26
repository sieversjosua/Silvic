import type { ConnectorObservation, WorkspaceSnapshot } from "@silvic/contracts";

export type Tone =
  | "attention"
  | "active"
  | "changed"
  | "waiting"
  | "ready"
  | "unknown"
  | "quiet";

export interface OperationalState {
  label: string;
  tone: Tone;
}

/**
 * One derived state per Workspace, matching the product concept's table.
 * Ambiguous evidence resolves to `Unknown` rather than a confident guess.
 */
export function workspaceState(workspace: WorkspaceSnapshot): OperationalState {
  const has = (
    kinds: readonly ConnectorObservation["kind"][],
    state: ConnectorObservation["state"],
  ) =>
    workspace.observations.some(
      (item) => kinds.includes(item.kind) && item.state === state,
    );

  if (workspace.git.conflicted > 0) {
    return { label: "Needs attention", tone: "attention" };
  }
  if (workspace.observations.some((item) => item.state === "attention")) {
    return { label: "Needs attention", tone: "attention" };
  }
  // Active means work is running here. A deployment attached to every worktree
  // of a repository says nothing about this particular environment.
  if (has(["runtime", "session"], "active")) {
    return { label: "Active", tone: "active" };
  }
  if (localChangeCount(workspace) > 0 || workspace.git.ahead > 0) {
    return { label: "Changed", tone: "changed" };
  }
  if (has(["review"], "waiting")) {
    return { label: "Waiting", tone: "waiting" };
  }
  if (has(["review"], "ready")) {
    return { label: "Ready to land", tone: "ready" };
  }
  if (has(["runtime", "review", "session"], "unknown")) {
    return { label: "Unknown", tone: "unknown" };
  }
  return { label: "Quiet", tone: "quiet" };
}

export interface CardSignal {
  kind: ConnectorObservation["kind"];
  tone: ConnectorObservation["state"];
  text: string;
  /** Present when the chip has somewhere to go, which makes it clickable. */
  url?: string;
}

const severity: Record<ConnectorObservation["state"], number> = {
  attention: 0,
  active: 1,
  waiting: 2,
  ready: 3,
  unknown: 4,
  quiet: 5,
};

const plural: Record<ConnectorObservation["kind"], string> = {
  runtime: "runtimes",
  deployment: "deployments",
  review: "pull requests",
  session: "sessions",
  authentication: "sign-ins",
};

/**
 * One chip per kind of attachment, most urgent first. Agent task titles are
 * free-form sentences, so a card shows what kind of thing is attached and the
 * inspector carries the actual title.
 */
export function cardSignals(workspace: WorkspaceSnapshot): CardSignal[] {
  const byKind = Map.groupBy(
    workspace.observations,
    (observation) => observation.kind,
  );
  return [...byKind]
    .map(([kind, items]) => {
      const ranked = [...items].sort(
        (left, right) => severity[left.state] - severity[right.state],
      );
      const worst = ranked[0];
      if (!worst) return undefined;
      const text =
        items.length > 1
          ? `${items.length} ${plural[kind]}`
          : kind === "session"
            ? (worst.detail ?? worst.label)
            : worst.label;
      const url = items.length === 1 ? worst.url : undefined;
      return { kind, tone: worst.state, text, ...(url ? { url } : {}) };
    })
    .filter((signal) => signal !== undefined)
    .sort((left, right) => severity[left.tone] - severity[right.tone]);
}

export function localChangeCount(workspace: WorkspaceSnapshot): number {
  return (
    workspace.git.staged +
    workspace.git.unstaged +
    workspace.git.untracked +
    workspace.git.conflicted
  );
}

export function workingTreeLabel(workspace: WorkspaceSnapshot): string {
  if (workspace.git.conflicted > 0) {
    return `${workspace.git.conflicted} conflicted`;
  }
  const count = localChangeCount(workspace);
  return count > 0 ? `${count} changed` : "Clean";
}

export function locationLabel(workspace: WorkspaceSnapshot): string {
  if (workspace.isPrimary) return "Primary checkout";
  return workspace.locationKind === "worktree" ? "Worktree" : "Checkout";
}

/** Tones that should pull the eye in the project list, most urgent first. */
export function projectTone(
  workspaces: readonly WorkspaceSnapshot[],
): Tone | undefined {
  const tones = workspaces.map((workspace) => workspaceState(workspace).tone);
  return (["attention", "active", "changed", "waiting"] as const).find((tone) =>
    tones.includes(tone),
  );
}
