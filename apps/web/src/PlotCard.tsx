import { useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Check,
  Copy,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Link2,
  MoreHorizontal,
  Monitor,
  Pencil,
  Play,
  Plus,
  Radio,
  SlidersHorizontal,
  Square,
  Trash2,
  Terminal,
  TriangleAlert,
  X,
} from "lucide-react";

import type {
  ConnectorObservation,
  HarnessId,
  HarnessDefinition,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { CodexMark, ConvexMark, GitHubMark, HarnessMark } from "./providers";
import { isQuiet } from "./grove-layout";
import { HarnessRows, harnessLabel } from "./harnesses";
import {
  cardSignals,
  locationLabel,
  plotCardActions,
  plotConclusion,
  workingTreeLabel,
  workspaceState,
  type CardRuntimeState,
  type CardSignal,
} from "./state";
import { failureMessage } from "./errors";
import { useKeyLayer } from "./shortcuts";

export interface WorkspaceNodeData extends Record<string, unknown> {
  workspace: WorkspaceSnapshot;
  selected: boolean;
  dimmed: boolean;
  menuOpen: boolean;
  project: ProjectSnapshot;
  runtime: CardRuntimeState | undefined;
  previewUrl: string | undefined;
  onSelect(id: string): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onOpenMenu(id: string): void;
  onCloseMenu(): void;
  onEditRecipe(): void;
  onNewPlot(): void;
  defaultHarness: HarnessId;
  onSetDefaultHarness(id: HarnessId): void;
  onRename(id: string, name: string): Promise<void>;
  onTeardown(workspace: WorkspaceSnapshot): void;
}

export type WorkspaceFlowNode = Node<WorkspaceNodeData, "workspace">;

export function WorkspaceNode({ data }: NodeProps<WorkspaceFlowNode>) {
  const { workspace } = data;
  const [runtimeWorking, setRuntimeWorking] = useState<"start" | "stop">();
  const [runtimeFailure, setRuntimeFailure] = useState<string>();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameWorking, setRenameWorking] = useState(false);
  const [renameFailure, setRenameFailure] = useState<string>();
  const runtime = data.runtime;
  const conclusion = plotConclusion(workspace);
  // Supervised runtimes speak once, in the head: the runtime label is the
  // card's state word, not an extra chip next to it. Except when the story
  // has ended — "Merged" says more than "Stopped" ever will.
  const state =
    runtime && !(conclusion && runtime.tone === "quiet")
      ? { label: runtime.label, tone: runtime.tone }
      : workspaceState(workspace);
  const { ahead, behind } = workspace.git;
  const signals = cardSignals(workspace).filter(
    (signal) => !(runtime && signal.kind === "runtime"),
  );
  const menuButton = useRef<HTMLButtonElement>(null);
  const { remoteUrl } = data.project;
  const supervisedPreviewUrl = data.previewUrl;
  const observedRuntimeUrl = workspace.observations.find(
    (observation) => observation.kind === "runtime" && observation.url,
  )?.url;
  const runtimeUrl = runtime ? supervisedPreviewUrl : observedRuntimeUrl;
  const previewSignal: CardSignal | undefined = supervisedPreviewUrl
    ? {
        kind: "runtime",
        tone: "active",
        text: "Local preview",
        url: supervisedPreviewUrl,
      }
    : undefined;

  // Ready to be seen off: the pull request has concluded and nothing is
  // running or midway through stopping.
  const actions = plotCardActions({ conclusion, runtime });

  const beginRename = () => {
    setRenameValue(workspace.name);
    setRenameFailure(undefined);
    setRenaming(true);
  };

  const submitRename = () => {
    const name = renameValue.trim();
    if (!name || renameWorking) return;
    if (name === workspace.name) {
      setRenaming(false);
      return;
    }
    setRenameWorking(true);
    setRenameFailure(undefined);
    void data
      .onRename(workspace.workspaceId, name)
      .then(() => setRenaming(false))
      .catch((error: unknown) => setRenameFailure(failureMessage(error)))
      .finally(() => setRenameWorking(false));
  };

  const runRuntimes = (action: "start" | "stop", ids: readonly string[]) => {
    setRuntimeWorking(action);
    setRuntimeFailure(undefined);
    void Promise.all(
      ids.map((id) =>
        action === "stop"
          ? window.silvic.stopPlotCommand({ path: workspace.path, id })
          : window.silvic.startPlotCommand({ path: workspace.path, id }),
      ),
    )
      .catch((error: unknown) => setRuntimeFailure(failureMessage(error)))
      .finally(() => setRuntimeWorking(undefined));
  };

  return (
    <article
      className="plot"
      data-tone={state.tone}
      data-running={state.tone === "active" || undefined}
      data-primary={workspace.isPrimary || undefined}
      data-selected={data.selected || undefined}
      data-dimmed={data.dimmed || undefined}
      tabIndex={0}
      onClick={() => data.onSelect(workspace.workspaceId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onSelect(workspace.workspaceId);
        }
      }}
    >
      <Handle id="in-left" type="target" position={Position.Left} />
      <Handle id="in-right" type="target" position={Position.Right} />
      <Handle id="out-left" type="source" position={Position.Left} />
      <span className="plot-ticks" aria-hidden="true" />
      <header className="plot-head">
        <span className="micro">
          {workspace.isPrimary ? "Project" : locationLabel(workspace)}
        </span>
        <span className="plot-head-tools">
          <span className="plot-state" title={runtime?.advice}>
            <i className="dot" />
            {state.label}
          </span>
          <PlotMenuTrigger
            workspaceName={workspace.name}
            expanded={data.menuOpen}
            buttonRef={menuButton}
            onToggle={() =>
              data.menuOpen
                ? data.onCloseMenu()
                : data.onOpenMenu(workspace.workspaceId)
            }
          />
        </span>
      </header>

      <div className="plot-title">
        {renaming ? (
          <form
            className="plot-rename"
            title={renameFailure}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key !== "Escape") return;
              event.preventDefault();
              setRenaming(false);
            }}
          >
            <input
              aria-label="Plot name"
              value={renameValue}
              maxLength={120}
              disabled={renameWorking}
              autoFocus
              data-invalid={renameFailure ? true : undefined}
              aria-invalid={renameFailure ? true : undefined}
              title={renameFailure}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <button
              type="submit"
              aria-label="Save plot name"
              disabled={!renameValue.trim() || renameWorking}
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              aria-label="Cancel renaming"
              disabled={renameWorking}
              onClick={() => setRenaming(false)}
            >
              <X size={12} />
            </button>
            {renameFailure && (
              <span className="plot-rename-error" role="alert">
                <TriangleAlert size={10} />
                {renameFailure}
              </span>
            )}
          </form>
        ) : (
          <h3
            className="plot-name"
            title={workspace.isPrimary ? data.project.name : workspace.name}
          >
            {workspace.isPrimary ? data.project.name : workspace.name}
          </h3>
        )}
        {/* The branch spells itself out on hover instead of taking a row of
            its own — a plot is usually named after it anyway. */}
        <span
          className="plot-branch-hint"
          title={workspace.branch || "Detached"}
          aria-label={`Branch: ${workspace.branch || "Detached"}`}
          role="img"
        >
          <GitBranch size={12} />
        </span>
        {workspace.isPrimary && remoteUrl && (
          <button
            type="button"
            className="plot-remote"
            aria-label="Open the repository"
            title={remoteUrl}
            onClick={(event) => {
              event.stopPropagation();
              void window.silvic.openLink({ url: remoteUrl });
            }}
          >
            <GitHubMark size={14} />
          </button>
        )}
      </div>

      {/* Each fact carries its own leading separator, so a line that has to
          wrap breaks between facts and never inside one. Zero counts say
          nothing and stay off the card. */}
      <p className="plot-facts">
        <span className="fact">{workingTreeLabel(workspace)}</span>
        {(ahead > 0 || behind > 0) && (
          <span className="fact">
            <i className="fact-sep" />
            {[ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""]
              .filter(Boolean)
              .join(" ")}
          </span>
        )}
        {workspace.isPrimary && (
          <span className="fact">
            <i className="fact-sep" />
            {plotSummary(data.project)}
          </span>
        )}
      </p>

      {workspace.provisioning?.status === "failed" && (
        <p className="plot-unprovisioned">
          <TriangleAlert size={11} />
          <span>Provisioning unfinished</span>
        </p>
      )}

      {(previewSignal || runtimeFailure || signals.length > 0) && (
        <div className="plot-signals">
          {runtimeFailure && (
            <span
              className="chip plot-runtime-state"
              data-tone="attention"
              title={runtimeFailure}
            >
              <TriangleAlert size={10} />
              <span>Runtime action failed</span>
            </span>
          )}
          {previewSignal && <Signal signal={previewSignal} />}
          {signals.map((signal) => (
            <Signal key={signal.kind} signal={signal} />
          ))}
        </div>
      )}

      <footer className="plot-actions">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen(workspace.path, data.defaultHarness);
          }}
        >
          <HarnessMark id={data.defaultHarness} size={13} />
          {harnessLabel(data.defaultHarness)}
        </button>
        {!(actions.teardown && actions.start) && (
          <button
            type="button"
            className="icon"
            aria-label="Open in Terminal"
            onClick={(event) => {
              event.stopPropagation();
              data.onOpen(workspace.path, "terminal");
            }}
          >
            <Terminal size={12} />
          </button>
        )}
        <span className="plot-actions-gap" />
        {actions.teardown && (
          /* The plot's work has landed (or been abandoned); the card's one
             offer is to see it off — worktree, branch and all. */
          <button
            type="button"
            className="plot-teardown"
            aria-label={`Tear down ${workspace.name}`}
            title={
              conclusion === "merged"
                ? "The pull request is merged — remove the worktree and branch"
                : "The pull request is closed — remove this plot"
            }
            onClick={(event) => {
              event.stopPropagation();
              data.onTeardown(workspace);
            }}
          >
            <Trash2 size={11} />
            Tear down…
          </button>
        )}
        {actions.stop && runtime && (
          <button
            type="button"
            className="plot-runtime-toggle"
            data-action="stop"
            aria-label={`Stop runtimes for ${workspace.name}`}
            title={
              runtime.startIds.length > 0
                ? "Stop the running runtimes"
                : "Stop runtimes"
            }
            disabled={runtimeWorking !== undefined}
            onClick={(event) => {
              event.stopPropagation();
              runRuntimes("stop", runtime.stopIds);
            }}
          >
            <Square size={10} />
            {runtimeWorking === "stop" ? "Stopping…" : "Stop"}
          </button>
        )}
        {actions.start && runtime && (
          <button
            type="button"
            className="plot-runtime-toggle"
            data-action="start"
            aria-label={`Start runtimes for ${workspace.name}`}
            title={
              runtime.stopIds.length > 0
                ? "Start the missing runtimes"
                : "Start runtimes"
            }
            disabled={runtimeWorking !== undefined}
            onClick={(event) => {
              event.stopPropagation();
              runRuntimes("start", runtime.startIds);
            }}
          >
            <Play size={10} />
            {runtimeWorking === "start" ? "Starting…" : "Start"}
          </button>
        )}
        {workspace.isPrimary && (
          <button
            type="button"
            className="icon plot-new"
            aria-label="New plot from here"
            title="New plot"
            onClick={(event) => {
              event.stopPropagation();
              data.onNewPlot();
            }}
          >
            <Plus size={14} />
          </button>
        )}
      </footer>
      {data.menuOpen && (
        <PlotMenu
          anchor={menuButton.current}
          workspace={workspace}
          runtimeUrl={runtimeUrl}
          defaultHarness={data.defaultHarness}
          onClose={data.onCloseMenu}
          onOpen={data.onOpen}
          onSetDefaultHarness={data.onSetDefaultHarness}
          onEditRecipe={data.onEditRecipe}
          onRename={beginRename}
          onTeardown={data.onTeardown}
        />
      )}
      <Handle id="out-right" type="source" position={Position.Right} />
    </article>
  );
}

export function PlotMenuTrigger({
  workspaceName,
  expanded,
  buttonRef,
  onToggle,
}: {
  workspaceName: string;
  expanded: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="plot-menu-trigger"
      aria-label={`Actions for ${workspaceName}`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      ref={buttonRef}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <MoreHorizontal size={14} />
    </button>
  );
}

/**
 * React Flow puts nodes inside a transformed viewport, so a menu rendered in
 * place would scale with the zoom and position against the transform rather
 * than the screen. Portalling to the body keeps it a normal-sized menu anchored
 * to where the button actually is.
 */
function PlotMenu({
  anchor,
  workspace,
  runtimeUrl,
  defaultHarness,
  onClose,
  onOpen,
  onSetDefaultHarness,
  onEditRecipe,
  onRename,
  onTeardown,
}: {
  anchor: HTMLElement | null;
  workspace: WorkspaceSnapshot;
  runtimeUrl: string | undefined;
  defaultHarness: HarnessId;
  onClose(): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onSetDefaultHarness(id: HarnessId): void;
  onEditRecipe(): void;
  onRename(): void;
  onTeardown(workspace: WorkspaceSnapshot): void;
}) {
  useKeyLayer({ dismiss: onClose });

  const rect = anchor?.getBoundingClientRect();
  if (!rect) return null;
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return createPortal(
    <>
      <div className="menu-scrim" onClick={onClose} />
      <div
        className="menu plot-menu"
        role="menu"
        style={{ top: rect.bottom + 6, left: Math.max(8, rect.right - 200) }}
      >
        <HarnessRows
          defaultHarness={defaultHarness}
          onOpen={(id) => run(() => onOpen(workspace.path, id))()}
          onSetDefault={onSetDefaultHarness}
        />
        <div className="menu-rule" />
        <button
          type="button"
          role="menuitem"
          onClick={run(() => onOpen(workspace.path, "finder"))}
        >
          <FolderOpen size={14} />
          Reveal in Finder
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={run(() => void window.silvic.copyText(workspace.path))}
        >
          <Copy size={14} />
          Copy path
        </button>
        {runtimeUrl && (
          <button
            type="button"
            role="menuitem"
            onClick={run(() => void window.silvic.copyText(runtimeUrl))}
          >
            <Link2 size={14} />
            Copy address
          </button>
        )}
        <div className="menu-rule" />
        {workspace.isPrimary ? (
          <button type="button" role="menuitem" onClick={run(onEditRecipe)}>
            <SlidersHorizontal size={14} />
            Recipe…
          </button>
        ) : (
          <>
            <button type="button" role="menuitem" onClick={run(onRename)}>
              <Pencil size={14} />
              Rename…
            </button>
            <div className="menu-rule" />
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={run(() => onTeardown(workspace))}
            >
              <Trash2 size={14} />
              Tear down…
            </button>
          </>
        )}
      </div>
    </>,
    window.document.body,
  );
}

/** How the project's plots are doing, in one line. */
function plotSummary(project: ProjectSnapshot): string {
  const plots = project.workspaces.filter((workspace) => !workspace.isPrimary);
  if (plots.length === 0) return "no plots";
  const busy = plots.filter((workspace) => !isQuiet(workspace)).length;
  return busy > 0
    ? `${plots.length} plots · ${busy} busy`
    : `${plots.length} plots · all quiet`;
}

function Signal({ signal }: { signal: CardSignal }) {
  const { url, hint } = signal;
  const body = (
    <>
      {signalIcon(signal.kind)}
      <span>{signal.text}</span>
    </>
  );
  if (!url) {
    return (
      <span className="chip" data-tone={signal.tone} title={hint}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chip linked"
      data-tone={signal.tone}
      title={hint ?? url}
      aria-label={`Open ${signal.text}`}
      onClick={(event) => {
        event.stopPropagation();
        void window.silvic.openLink({ url });
      }}
    >
      {body}
    </button>
  );
}

function signalIcon(kind: ConnectorObservation["kind"]) {
  if (kind === "runtime") return <Monitor size={10} />;
  if (kind === "deployment") return <ConvexMark size={10} />;
  if (kind === "review") return <GitPullRequest size={10} />;
  if (kind === "session") return <CodexMark size={10} />;
  return <Radio size={10} />;
}
