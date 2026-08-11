import type {
  ConnectorObservation,
  PlotCommand,
  PlotProcess,
  WorkspaceSnapshot,
} from "@silvic/contracts";

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
  // A concluded pull request outranks leftover local changes: the plot's
  // story has ended, and the card's job shifts to seeing it off.
  const conclusion = plotConclusion(workspace);
  if (conclusion) {
    return {
      label: conclusion === "merged" ? "Merged" : "PR closed",
      tone: "ready",
    };
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
  /** Detail worth a tooltip but not card space, like a session's title. */
  hint?: string;
}

export interface CardRuntimeState {
  tone: ConnectorObservation["state"];
  label: string;
  /** Declared runtimes not running, which Start would launch. */
  startIds: readonly string[];
  /** Running runtimes, which Stop would end. */
  stopIds: readonly string[];
  /** Why a runtime failed, when the supervisor knows. */
  advice?: string;
}

/**
 * The end of a plot's story, read from its pull request. A merged branch is
 * work that arrived; a closed one is work that was abandoned. Either way the
 * plot itself is finished and ready to be seen off.
 */
export function plotConclusion(
  workspace: WorkspaceSnapshot,
): "merged" | "closed" | undefined {
  if (workspace.isPrimary) return undefined;
  const review = workspace.observations.find(
    (observation) => observation.kind === "review",
  );
  const state = review?.metadata?.["state"];
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return undefined;
}

/**
 * The card controls the Plot's declared runtime set as one unit. A partially
 * running Plot offers both ways out of the in-between: Start completes the
 * set, Stop ends what runs — because "half running" is as often a stop that
 * did not finish as a start that did not.
 */
export function cardRuntimeState({
  workspace,
  commands,
  processes,
}: {
  workspace: WorkspaceSnapshot;
  commands: readonly (readonly [string, PlotCommand])[];
  processes: readonly PlotProcess[];
}): CardRuntimeState | undefined {
  const ids = commands.map(([id]) => id);
  if (ids.length === 0) return undefined;
  const byId = new Map(
    processes
      .filter((process) => process.plotPath === workspace.path)
      .map((process) => [process.id, process]),
  );
  const running = ids.filter((id) => byId.get(id)?.status === "running");
  const starting = ids.filter((id) => byId.get(id)?.status === "starting");
  const active = ids.filter(
    (id) =>
      byId.get(id)?.status === "starting" || byId.get(id)?.status === "running",
  );
  const missing = ids.filter((id) => !active.includes(id));
  const failed = missing.some((id) => byId.get(id)?.status === "failed");

  // A stop in progress is its own state, not a lie about running: the card
  // says so and offers nothing to press until the group is actually gone.
  if (ids.some((id) => byId.get(id)?.status === "stopping")) {
    return { tone: "waiting", label: "Stopping…", startIds: [], stopIds: [] };
  }
  if (starting.length > 0) {
    return {
      tone: "waiting",
      label: "Starting…",
      startIds: missing,
      stopIds: active,
    };
  }
  if (running.length === ids.length) {
    return {
      tone: "active",
      label: ids.length === 1 ? "Running" : `${running.length} running`,
      startIds: [],
      stopIds: running,
    };
  }
  const troubled = ids
    .map((id) => byId.get(id))
    .find((process) => process?.status === "failed");
  const advice =
    troubled?.advice ??
    (troubled?.exitCode !== undefined
      ? `Exited with code ${troubled.exitCode}`
      : undefined);
  return {
    tone: failed ? "attention" : running.length > 0 ? "waiting" : "quiet",
    label:
      running.length > 0
        ? `${running.length}/${ids.length} running`
        : failed
          ? "Failed"
          : "Stopped",
    startIds: missing,
    stopIds: running,
    ...(advice ? { advice } : {}),
  };
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
 * One chip per kind of attachment, most urgent first. Session codenames and
 * deployment names are noise at card size, so a card shows what kind of thing
 * is attached; the name rides along as a tooltip and the inspector carries it
 * in full.
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
      const single = items.length === 1 ? worst : undefined;
      let text: string;
      let hint: string | undefined;
      if (!single) {
        text = `${items.length} ${plural[kind]}`;
      } else if (kind === "session") {
        text = "Session";
        hint = single.detail ?? single.label;
      } else if (kind === "deployment") {
        text = "Deployment";
        hint = single.detail
          ? `${single.detail} · ${single.label}`
          : single.label;
      } else if (kind === "runtime") {
        text = "Local preview";
      } else {
        text = single.label;
        hint = single.detail;
      }
      const url = single?.url;
      return {
        kind,
        tone: worst.state,
        text,
        ...(url ? { url } : {}),
        ...(hint ? { hint } : {}),
      };
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
