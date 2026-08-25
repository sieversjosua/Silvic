import { useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  GitBranch,
  GitPullRequest,
  Monitor,
  Plus,
  Radio,
  Terminal,
  TriangleAlert,
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
import { harnessLabel } from "./harnesses";
import {
  PlotMenu,
  PlotMenuTrigger,
  PlotRenameForm,
  PlotRuntimeActions,
} from "./PlotActions";
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
export { PlotMenuTrigger } from "./PlotActions";

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
  const [renaming, setRenaming] = useState(false);
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
            workspaceId={workspace.workspaceId}
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
          <PlotRenameForm
            workspace={workspace}
            onRename={data.onRename}
            onDone={() => setRenaming(false)}
          />
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

      {/* What went wrong (or what Silvic is doing about it), readable on the
          card itself — a tooltip is where explanations go to be missed. */}
      {runtime?.advice && (
        <p className="plot-advice" data-tone={state.tone}>
          <span>{runtime.advice}</span>
        </p>
      )}

      {(previewSignal || signals.length > 0) && (
        <div className="plot-signals">
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
        <PlotRuntimeActions
          workspace={workspace}
          runtime={runtime}
          conclusion={conclusion}
          onTeardown={data.onTeardown}
        />
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
          onRename={() => setRenaming(true)}
          onTeardown={data.onTeardown}
        />
      )}
      <Handle id="out-right" type="source" position={Position.Right} />
    </article>
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
