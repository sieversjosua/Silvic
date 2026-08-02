import { useMemo, useState } from "react";
import {
  Bot,
  Cloud,
  Code2,
  CreditCard,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Globe2,
  KeyRound,
  Monitor,
  PackageCheck,
  Play,
  RotateCcw,
  Server,
  Square,
  Terminal,
  X,
} from "lucide-react";

import type {
  HarnessDefinition,
  HarnessId,
  PlotCommand,
  PlotProcess,
  PlotResource,
  PlotResourceDefinition,
  PlotResourceProvider,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { failureMessage } from "./errors";
import { harnessLabel } from "./harnesses";
import { HarnessMark } from "./providers";
import { plotResources } from "./plot-resources";
import { localChangeCount, workingTreeLabel, workspaceState } from "./state";

export function PlotView({
  workspace,
  commands,
  declaredResources,
  processes,
  defaultHarness,
  onOpen,
  onShip,
  onProvision,
  onClose,
}: {
  workspace: WorkspaceSnapshot;
  commands: Readonly<Record<string, PlotCommand>>;
  declaredResources: Readonly<Record<string, PlotResourceDefinition>>;
  processes: readonly PlotProcess[];
  defaultHarness: HarnessId;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onShip(): void;
  onProvision(): void;
  onClose(): void;
}) {
  const resources = useMemo(
    () =>
      plotResources({
        workspace,
        commands,
        processes,
        declared: declaredResources,
      }),
    [workspace, commands, processes, declaredResources],
  );
  const state = workspaceState(workspace);
  const preview = resources.find((resource) => resource.url)?.url;
  const active = resources.filter((resource) => resource.state === "active");
  const attention = resources.filter(
    (resource) => resource.state === "attention",
  );
  const [logs, setLogs] = useState<{ label: string; output: string }>();
  const [failure, setFailure] = useState<string>();
  const [workingCommand, setWorkingCommand] = useState<string>();

  const openUrl = (url: string) =>
    void window.silvic
      .openLink({ url })
      .catch((error: unknown) => setFailure(failureMessage(error)));

  const act = (resource: PlotResource) => {
    const id = resource.commandId;
    if (!id) return;
    const running = processes.some(
      (process) =>
        process.plotPath === workspace.path &&
        process.id === id &&
        process.status === "running",
    );
    setWorkingCommand(id);
    setFailure(undefined);
    void (
      running
        ? window.silvic.stopPlotCommand({ path: workspace.path, id })
        : window.silvic.startPlotCommand({ path: workspace.path, id })
    )
      .catch((error: unknown) => setFailure(failureMessage(error)))
      .finally(() => setWorkingCommand(undefined));
  };

  const readLogs = (resource: PlotResource) => {
    const id = resource.commandId;
    if (!id) return;
    setFailure(undefined);
    void window.silvic
      .readPlotCommandOutput({ path: workspace.path, id })
      .then((output) => setLogs({ label: resource.label, output }))
      .catch((error: unknown) => setFailure(failureMessage(error)));
  };

  return (
    <div className="plot-view-scrim" onMouseDown={onClose}>
      <article
        className="plot-view"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="plot-view-head">
          <div>
            <div className="plot-view-kicker">
              <span className="state-pill" data-tone={state.tone}>
                <i className="dot" />
                {state.label}
              </span>
              <span className="micro">Plot</span>
            </div>
            <h1>{workspace.task?.title ?? workspace.name}</h1>
            <p className="plot-view-branch mono">
              <GitBranch size={12} />
              {workspace.branch || "Detached"}
            </p>
          </div>
          <button
            type="button"
            className="plot-view-close"
            aria-label="Close Plot view"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        {workspace.task && (
          <section className="plot-task">
            <div>
              <p className="micro">Task</p>
              {workspace.task.description && (
                <p>{workspace.task.description}</p>
              )}
            </div>
            {workspace.task.issue && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => openUrl(workspace.task?.issue?.url ?? "")}
              >
                <GitPullRequest size={13} />
                GitHub #{workspace.task.issue.number}
                <ExternalLink size={11} />
              </button>
            )}
          </section>
        )}

        <div className="plot-view-actions">
          <button
            type="button"
            className="primary-button"
            onClick={() => void onOpen(workspace.path, defaultHarness)}
          >
            <HarnessMark id={defaultHarness} size={14} />
            Open in {harnessLabel(defaultHarness)}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!preview}
            onClick={() => preview && openUrl(preview)}
          >
            <Globe2 size={13} />
            Open preview
          </button>
          <button type="button" className="ghost-button" onClick={onProvision}>
            <RotateCcw size={13} />
            Provision
          </button>
          <button type="button" className="ghost-button" onClick={onShip}>
            <GitPullRequest size={13} />
            Review &amp; ship
          </button>
        </div>

        <section className="plot-summary">
          <SummaryFact
            label="Code"
            value={workingTreeLabel(workspace)}
            icon={<Code2 size={14} />}
          />
          <SummaryFact
            label="Resources"
            value={`${active.length} running · ${resources.length} total`}
            icon={<Server size={14} />}
          />
          <SummaryFact
            label="Attention"
            value={
              attention.length === 0
                ? "Nothing blocked"
                : `${attention.length} need attention`
            }
            icon={<PackageCheck size={14} />}
          />
          <SummaryFact
            label="Changes"
            value={`${localChangeCount(workspace)} local`}
            icon={<GitBranch size={14} />}
          />
        </section>

        <section className="plot-resources">
          <div className="plot-section-title">
            <div>
              <p className="micro">Resources</p>
              <h2>Everything attached to this Plot</h2>
            </div>
            <span className="micro">{resources.length} total</span>
          </div>
          {resources.length === 0 ? (
            <p className="section-empty">
              Add commands or resources to silvic.json and they appear here.
            </p>
          ) : (
            <div className="resource-grid">
              {resources.map((resource) => {
                const running =
                  resource.commandId !== undefined &&
                  processes.some(
                    (process) =>
                      process.plotPath === workspace.path &&
                      process.id === resource.commandId &&
                      process.status === "running",
                  );
                return (
                  <ResourceCard
                    key={resource.id}
                    resource={resource}
                    running={running}
                    working={workingCommand === resource.commandId}
                    onOpen={openUrl}
                    onAct={() => act(resource)}
                    onLogs={() => readLogs(resource)}
                  />
                );
              })}
            </div>
          )}
        </section>

        {logs && (
          <section className="plot-logs">
            <div className="plot-section-title">
              <div>
                <p className="micro">Logs</p>
                <h2>{logs.label}</h2>
              </div>
              <button
                type="button"
                aria-label="Close logs"
                onClick={() => setLogs(undefined)}
              >
                <X size={14} />
              </button>
            </div>
            <pre className="mono">{logs.output || "No output yet"}</pre>
          </section>
        )}
        {failure && <p className="dialog-error plot-view-error">{failure}</p>}
      </article>
    </div>
  );
}

function ResourceCard({
  resource,
  running,
  working,
  onOpen,
  onAct,
  onLogs,
}: {
  resource: PlotResource;
  running: boolean;
  working: boolean;
  onOpen(url: string): void;
  onAct(): void;
  onLogs(): void;
}) {
  return (
    <article className="resource-card" data-state={resource.state}>
      <header>
        <span className="resource-icon">
          <ProviderIcon provider={resource.provider} />
        </span>
        <div>
          <p className="micro">{resource.kind}</p>
          <h3>{resource.label}</h3>
        </div>
        <span className="resource-state">
          <i className="dot" data-tone={resource.state} />
          {stateLabel(resource.state)}
        </span>
      </header>
      {resource.detail && (
        <p className="resource-detail mono" title={resource.detail}>
          {resource.detail}
        </p>
      )}
      <div className="resource-meta">
        <span>{resource.provider}</span>
        <span>{resource.isolation}</span>
      </div>
      <footer>
        {resource.url && (
          <button
            type="button"
            className="link-button"
            onClick={() => onOpen(resource.url ?? "")}
          >
            <Globe2 size={12} /> Open
          </button>
        )}
        {resource.dashboardUrl && (
          <button
            type="button"
            className="link-button"
            onClick={() => onOpen(resource.dashboardUrl ?? "")}
          >
            <ExternalLink size={12} /> Dashboard
          </button>
        )}
        {resource.commandId && (
          <>
            <button type="button" className="link-button" onClick={onLogs}>
              <Terminal size={12} /> Logs
            </button>
            <button
              type="button"
              className="link-button resource-act"
              onClick={onAct}
              disabled={working}
            >
              {running ? <Square size={11} /> : <Play size={11} />}
              {working ? "Working…" : running ? "Stop" : "Start"}
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

function SummaryFact({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="plot-summary-fact">
      {icon}
      <span className="micro">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProviderIcon({ provider }: { provider: PlotResourceProvider }) {
  switch (provider) {
    case "livekit":
      return <Bot size={17} />;
    case "stripe":
      return <CreditCard size={17} />;
    case "cloudflare":
    case "vercel":
      return <Cloud size={17} />;
    case "clerk":
    case "workos":
      return <KeyRound size={17} />;
    case "github":
      return <GitPullRequest size={17} />;
    case "web":
      return <Monitor size={17} />;
    default:
      return <Server size={17} />;
  }
}

function stateLabel(state: PlotResource["state"]): string {
  switch (state) {
    case "active":
      return "Running";
    case "ready":
      return "Ready";
    case "waiting":
      return "Waiting";
    case "attention":
      return "Attention";
    case "quiet":
      return "Stopped";
    default:
      return "Unknown";
  }
}
