import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  Sun,
  Terminal,
  X,
} from "lucide-react";

import type {
  AppearancePreference,
  ConnectorFailure,
  ConnectorObservation,
  DeliveryDraft,
  HarnessDefinition,
  PlotCreationResult,
  ProjectSnapshot,
  WorkspaceChanges,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { useAppearance } from "./appearance";
import { Grove } from "./Grove";
import { Mark } from "./Mark";
import { ClaudeMark, CodexMark, ConvexMark, T3Mark } from "./providers";
import { RecipeDialog } from "./RecipeDialog";
import {
  localChangeCount,
  locationLabel,
  projectTone,
  workingTreeLabel,
  workspaceState,
} from "./state";
import { useSilvic } from "./store";

const harnessMenu = [
  ["claude", "Claude Code", <ClaudeMark size={15} key="claude" />],
  ["t3-code", "T3 Code", <T3Mark size={15} key="t3" />],
  ["opencode", "OpenCode", <SquareTerminal size={15} key="opencode" />],
  ["terminal", "Terminal", <Terminal size={15} key="terminal" />],
  ["finder", "Finder", <FolderOpen size={15} key="finder" />],
] as const;

export function App() {
  const {
    snapshot,
    roots,
    activeProjectIds,
    harnessIcons,
    selectedProjectId,
    selectedWorkspaceId,
    loading,
    error,
    initialize,
    refresh,
    addRoot,
    setProjectActive,
    createEnvironment,
    selectProject,
    selectWorkspace,
  } = useSilvic();
  const { appearance, preference, setPreference } = useAppearance();
  const [query, setQuery] = useState("");
  const [menuProjectId, setMenuProjectId] = useState<string>();
  const [recipeProject, setRecipeProject] = useState<ProjectSnapshot>();
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [deliveryWorkspace, setDeliveryWorkspace] =
    useState<WorkspaceSnapshot>();

  useEffect(() => {
    let dispose: () => void = () => {};
    void initialize().then((cleanup) => {
      dispose = cleanup;
    });
    return () => dispose();
  }, [initialize]);

  useEffect(() => {
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const activeProjects = snapshot.projects.filter((candidate) =>
    activeProjectIds.includes(candidate.id),
  );
  const suggestedProjects = snapshot.projects.filter(
    (candidate) => !activeProjectIds.includes(candidate.id),
  );
  const project =
    activeProjects.find((candidate) => candidate.id === selectedProjectId) ??
    activeProjects[0];
  const workspace = project?.workspaces.find(
    (candidate) => candidate.workspaceId === selectedWorkspaceId,
  );
  const openWorkspace = useCallback(
    async (path: string, target: HarnessDefinition["id"]) => {
      await window.silvic.openWorkspace({ path, target });
    },
    [],
  );

  return (
    <main className="shell">
      <aside className="rail">
        <div className="drag-region" />
        <div className="brand">
          <span className="brand-tile">
            <Mark size={20} />
          </span>
          <span className="brand-text">
            <strong>Silvic</strong>
            <span className="micro">Parallel work, grounded</span>
          </span>
        </div>

        <div className="rail-scroll">
          <div className="rail-label">
            <span className="micro">Projects</span>
            <button
              type="button"
              aria-label="Add a location to scan"
              onClick={() => void addRoot()}
            >
              <Plus size={13} />
            </button>
          </div>
          <nav className="project-list">
            {activeProjects.map((candidate) => (
              <ProjectButton
                key={candidate.id}
                project={candidate}
                active={candidate.id === project?.id}
                menuOpen={menuProjectId === candidate.id}
                onSelect={() => selectProject(candidate.id)}
                onOpenMenu={() => setMenuProjectId(candidate.id)}
                onCloseMenu={() => setMenuProjectId(undefined)}
                onRemove={() => void setProjectActive(candidate.id, false)}
                onEditRecipe={() => setRecipeProject(candidate)}
              />
            ))}
            {activeProjects.length === 0 && !loading && (
              <p className="rail-empty">
                Nothing added yet. Pick from the suggestions below.
              </p>
            )}
          </nav>

          {suggestedProjects.length > 0 && (
            <SuggestionList
              projects={suggestedProjects}
              onAdd={(id) => void setProjectActive(id, true)}
            />
          )}
        </div>

        <div className="rail-foot">
          <AppearanceControl value={preference} onChange={setPreference} />
          <button type="button" className="rail-action" onClick={() => void addRoot()}>
            <Plus size={13} />
            Add location
          </button>
          <p className="micro rail-count">
            {roots.length} watched location{roots.length === 1 ? "" : "s"}
          </p>
          {snapshot.connectorFailures.length > 0 && (
            <ConnectorHealth failures={snapshot.connectorFailures} />
          )}
        </div>
      </aside>

      <section className="stage">
        {project ? (
          <>
            <header className="stage-head">
              <div className="stage-title">
                <p className="micro">Project</p>
                <h1>{project.name}</h1>
                <p className="stage-meta">
                  <span>
                    {project.workspaces.length} plot
                    {project.workspaces.length === 1 ? "" : "s"}
                  </span>
                  <i />
                  <span className="mono truncate">
                    {project.origin ?? project.rootPath}
                  </span>
                </p>
              </div>
              <div className="stage-actions">
                <label className="search">
                  <Search size={13} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find in project"
                  />
                  {query && (
                    <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                      <X size={11} />
                    </button>
                  )}
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  aria-label="Refresh"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  <RefreshCw size={13} className={loading ? "spinning" : ""} />
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setShowEnvironment(true)}
                >
                  <Plus size={13} /> New plot
                </button>
              </div>
            </header>

            <Grove
              project={project}
              query={query}
              appearance={appearance}
              harnessIcons={harnessIcons}
              selectedWorkspaceId={workspace?.workspaceId}
              onSelect={selectWorkspace}
              onOpen={openWorkspace}
              onEditRecipe={() => setRecipeProject(project)}
            />

          </>
        ) : (
          <EmptyState onAdd={() => void addRoot()} loading={loading} />
        )}
      </section>

      <aside className="inspector">
        {workspace ? (
          <WorkspaceInspector
            key={workspace.workspaceId}
            workspace={workspace}
            harnessIcons={harnessIcons}
            onOpen={openWorkspace}
            onShip={() => setDeliveryWorkspace(workspace)}
          />
        ) : (
          <div className="inspector-empty">
            <p className="micro">Inspector</p>
            <p>Select a plot on the canvas.</p>
          </div>
        )}
      </aside>

      {recipeProject && (
        <RecipeDialog
          projectId={recipeProject.id}
          projectName={recipeProject.name}
          onClose={() => setRecipeProject(undefined)}
        />
      )}
      {error && <div className="error-toast">{error}</div>}
      {showEnvironment && project && (
        <NewPlotDialog
          source={workspace ?? project.workspaces[0]}
          loading={loading}
          onCancel={() => setShowEnvironment(false)}
          onCreate={createEnvironment}
        />
      )}
      {deliveryWorkspace && (
        <DeliveryDialog
          workspace={deliveryWorkspace}
          onClose={() => setDeliveryWorkspace(undefined)}
          onComplete={async () => {
            await refresh();
            setDeliveryWorkspace(undefined);
          }}
        />
      )}
    </main>
  );
}

function ProjectButton({
  project,
  active,
  menuOpen,
  onSelect,
  onOpenMenu,
  onCloseMenu,
  onRemove,
  onEditRecipe,
}: {
  project: ProjectSnapshot;
  active: boolean;
  menuOpen: boolean;
  onSelect(): void;
  onOpenMenu(): void;
  onCloseMenu(): void;
  onRemove(): void;
  onEditRecipe(): void;
}) {
  const tone = projectTone(project.workspaces);
  const row = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{
    top: number;
    left: number;
    width: number;
  }>();

  const open = () => {
    const rect = row.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    onOpenMenu();
  };

  // The menu is positioned against the viewport, so it has to close rather than
  // drift when the rail scrolls beneath it.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => onCloseMenu();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuOpen, onCloseMenu]);

  return (
    <div
      className="project-row"
      ref={row}
      data-menu-open={menuOpen || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        open();
      }}
    >
      <button
        type="button"
        className="project"
        data-active={active || undefined}
        onClick={onSelect}
      >
        <i className="project-tone" data-tone={tone ?? "quiet"} />
        <span className="project-name">{project.name}</span>
      </button>
      <div className="project-trailing">
        <span className="project-count mono">{project.workspaces.length}</span>
        <button
          type="button"
          className="project-overflow"
          aria-label={`Actions for ${project.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
      {menuOpen && anchor && (
        <>
          <div
            className="menu-scrim"
            onClick={onCloseMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              onCloseMenu();
            }}
          />
          <div
            className="menu project-menu"
            role="menu"
            style={{
              top: anchor.top,
              left: anchor.left,
              width: anchor.width,
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                onEditRecipe();
              }}
            >
              <SlidersHorizontal size={14} />
              Recipe…
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onCloseMenu();
                void window.silvic.openWorkspace({
                  path: project.rootPath,
                  target: "finder",
                });
              }}
            >
              <FolderOpen size={14} />
              Reveal in Finder
            </button>
            <div className="menu-rule" />
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                onCloseMenu();
                onRemove();
              }}
            >
              <X size={14} />
              Remove from Projects
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const suggestionPreviewCount = 5;

function SuggestionList({
  projects,
  onAdd,
}: {
  projects: readonly ProjectSnapshot[];
  onAdd(id: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded
    ? projects
    : projects.slice(0, suggestionPreviewCount);
  const hidden = projects.length - visible.length;

  return (
    <>
      <div className="rail-label suggested">
        <span className="micro">Suggested</span>
        <span className="micro">{projects.length}</span>
      </div>
      <nav className="project-list">
        {visible.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className="suggestion"
            title={candidate.rootPath}
            onClick={() => onAdd(candidate.id)}
          >
            <Plus size={12} />
            <span className="project-name">{candidate.name}</span>
            <span className="project-count mono">
              {candidate.workspaces.length}
            </span>
          </button>
        ))}
        {(hidden > 0 || expanded) && (
          <button
            type="button"
            className="suggestion-more micro"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        )}
      </nav>
    </>
  );
}

/** The installed application's own icon, falling back to a drawn glyph. */
function HarnessIcon({
  id,
  icons,
  fallback,
  size = 14,
}: {
  id: string;
  icons: Readonly<Record<string, string>>;
  fallback: React.ReactNode;
  size?: number;
}) {
  const source = icons[id];
  if (!source) return <>{fallback}</>;
  return (
    <img
      className="harness-icon"
      src={source}
      alt=""
      width={size}
      height={size}
    />
  );
}

/**
 * Connector health is app-level and rarely actionable, so it sits quietly in the
 * rail instead of covering the canvas. Naming each connector and its error keeps
 * the summary honest — "4 unavailable" on its own explains nothing.
 */
function ConnectorHealth({
  failures,
}: {
  failures: readonly ConnectorFailure[];
}) {
  const [open, setOpen] = useState(false);
  const gitHubUnavailable = failures.some(
    (failure) => failure.connectorId === "github",
  );

  return (
    <div className="connector-health">
      {open && (
        <div className="connector-detail">
          {failures.map((failure) => (
            <p key={failure.connectorId}>
              <strong>{failure.connectorId}</strong>
              <span>{failure.message}</span>
            </p>
          ))}
          {gitHubUnavailable && (
            <button
              type="button"
              onClick={() => void window.silvic.connectGitHub()}
            >
              Sign in to GitHub
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className="connector-toggle micro"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {failures.length} connector{failures.length === 1 ? "" : "s"} idle
      </button>
    </div>
  );
}

function AppearanceControl({
  value,
  onChange,
}: {
  value: AppearancePreference;
  onChange(next: AppearancePreference): void;
}) {
  const options = [
    ["system", "Match system", <Monitor size={12} key="s" />],
    ["light", "Light", <Sun size={12} key="l" />],
    ["dark", "Dark", <Moon size={12} key="d" />],
  ] as const;
  return (
    <div className="segmented" role="group" aria-label="Appearance">
      {options.map(([id, label, icon]) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={value === id}
          data-active={value === id || undefined}
          onClick={() => onChange(id)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

function WorkspaceInspector({
  workspace,
  harnessIcons,
  onOpen,
  onShip,
}: {
  workspace: WorkspaceSnapshot;
  harnessIcons: Readonly<Record<string, string>>;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onShip(): void;
}) {
  const [openMenu, setOpenMenu] = useState(false);
  const state = workspaceState(workspace);
  const changes = localChangeCount(workspace);
  const grouped = useMemo(
    () => Map.groupBy(workspace.observations, (observation) => observation.kind),
    [workspace.observations],
  );

  return (
    <>
      <div className="inspector-head">
        <div className="inspector-eyebrow">
          <span className="micro">{locationLabel(workspace)}</span>
          <span className="state-pill" data-tone={state.tone}>
            <i className="dot" />
            {state.label}
          </span>
        </div>
        <h2 title={workspace.name}>{workspace.name}</h2>
        {workspace.branch !== workspace.name && (
          <p className="inspector-branch mono">
            <GitBranch size={12} />
            {workspace.branch || "Detached"}
          </p>
        )}

        <div className="split-button">
          <button type="button" onClick={() => void onOpen(workspace.path, "codex")}>
            <HarnessIcon
              id="codex"
              icons={harnessIcons}
              fallback={<CodexMark size={14} />}
            />
            Open in Codex
          </button>
          <button
            type="button"
            className="split-toggle"
            aria-label="Choose another harness"
            aria-expanded={openMenu}
            onClick={() => setOpenMenu(!openMenu)}
          >
            <ChevronDown size={13} />
          </button>
          {openMenu && (
            <>
              <div className="menu-scrim" onClick={() => setOpenMenu(false)} />
              <div className="menu">
                {harnessMenu.map(([id, label, glyph]) => (
                  <button
                    type="button"
                    key={id}
                    onClick={() => {
                      setOpenMenu(false);
                      void onOpen(workspace.path, id);
                    }}
                  >
                    <HarnessIcon
                      id={id}
                      icons={harnessIcons}
                      fallback={glyph}
                      size={15}
                    />
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="inspector-body">
        <Section icon={<GitBranch size={12} />} title="Code">
          <Field label="Working tree" value={workingTreeLabel(workspace)} />
          <Field label="Upstream" value={workspace.git.upstream ?? "Not configured"} />
          <Field label="Ahead / behind" value={`${workspace.git.ahead} / ${workspace.git.behind}`} />
          <Field label="Revision" value={workspace.git.revision?.slice(0, 9) ?? "Unknown"} />
          {(changes > 0 || workspace.git.ahead > 0) && (
            <button type="button" className="section-action" onClick={onShip}>
              Review &amp; ship
            </button>
          )}
        </Section>
        <Observations
          icon={<Terminal size={12} />}
          title="Runtime"
          observations={grouped.get("runtime") ?? []}
          empty="No local runtime detected"
        />
        <Observations
          icon={<ConvexMark size={12} />}
          title="Deployment"
          observations={grouped.get("deployment") ?? []}
          empty="No deployment attached"
        />
        <Observations
          icon={<GitPullRequest size={12} />}
          title="Review"
          observations={grouped.get("review") ?? []}
          empty="No pull request"
        />
        <Observations
          icon={<CodexMark size={12} />}
          title="Sessions"
          observations={grouped.get("session") ?? []}
          empty="No active agent session"
        />
        <p className="inspector-path mono">{workspace.path}</p>
      </div>
    </>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <h3 className="micro">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Observations({
  icon,
  title,
  observations,
  empty,
}: {
  icon: React.ReactNode;
  title: string;
  observations: WorkspaceSnapshot["observations"];
  empty: string;
}) {
  return (
    <Section icon={icon} title={title}>
      {observations.length === 0 ? (
        <p className="section-empty">{empty}</p>
      ) : (
        observations.map((observation) => (
          <Observation
            key={`${observation.connectorId}:${observation.kind}`}
            observation={observation}
          />
        ))
      )}
    </Section>
  );
}

/**
 * Anything a connector gave a URL for — a pull request, a deployment, a running
 * dev server — opens in the default browser rather than being read-only text.
 */
function Observation({ observation }: { observation: ConnectorObservation }) {
  const body = (
    <>
      <i className="dot" data-tone={observation.state} />
      <div>
        <strong>{observation.label}</strong>
        {observation.detail && <span>{observation.detail}</span>}
      </div>
    </>
  );

  const { url } = observation;
  if (!url) {
    return <div className="observation">{body}</div>;
  }
  return (
    <button
      type="button"
      className="observation linked"
      title={url}
      onClick={() => void window.silvic.openLink({ url })}
    >
      {body}
      <ExternalLink size={12} className="observation-open" />
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <i className="field-leader" />
      <span className="field-value mono">{value}</span>
    </div>
  );
}

/**
 * Creating a plot runs the repository's provisioning steps, which can take
 * minutes and can fail halfway. The dialog stays open and reports each step
 * rather than closing and leaving the result invisible.
 */
function NewPlotDialog({
  source,
  loading,
  onCancel,
  onCreate,
}: {
  source: WorkspaceSnapshot | undefined;
  loading: boolean;
  onCancel(): void;
  onCreate(request: {
    sourcePath: string;
    branch: string;
    mode: "worktree" | "clone";
  }): Promise<PlotCreationResult>;
}) {
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<"worktree" | "clone">("worktree");
  const [result, setResult] = useState<PlotCreationResult>();
  const [failure, setFailure] = useState<string>();
  const plotName = branch
    .trim()
    .replaceAll("/", "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!source) return null;

  if (result) {
    const failed = result.provision.find((step) => step.exitCode !== 0);
    return (
      <div className="scrim" onMouseDown={onCancel}>
        <section
          className="dialog"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <p className="micro">{failed ? "Provisioning failed" : "Plot ready"}</p>
          <h2>{result.plot.name}</h2>
          <div className="field">
            <span className="field-label">Address</span>
            <i className="field-leader" />
            <span className="field-value mono">{result.plot.url}</span>
          </div>
          <div className="field">
            <span className="field-label">Location</span>
            <i className="field-leader" />
            <span className="field-value mono">{result.plot.path}</span>
          </div>
          {result.provision.length === 0 ? (
            <p className="dialog-copy">
              This repository declares no provisioning steps. Add a
              <code> silvic.json </code> to install dependencies, create a
              deployment or write environment files when a plot is made.
            </p>
          ) : (
            <ol className="provision-steps">
              {result.provision.map((step) => (
                <li key={step.label} data-failed={step.exitCode !== 0 || undefined}>
                  <div className="provision-head">
                    <strong>{step.label}</strong>
                    <span className="mono">
                      {step.exitCode === 0
                        ? `${Math.round(step.durationMs / 100) / 10}s`
                        : `exit ${step.exitCode}`}
                    </span>
                  </div>
                  <code className="mono">{step.command}</code>
                  {step.exitCode !== 0 && step.output && (
                    <pre className="patch mono">{step.output}</pre>
                  )}
                </li>
              ))}
            </ol>
          )}
          <div className="dialog-actions">
            <button type="button" className="primary-button" onClick={onCancel}>
              Done
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="scrim" onMouseDown={loading ? undefined : onCancel}>
      <form
        className="dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!plotName || loading) return;
          setFailure(undefined);
          void onCreate({
            sourcePath: source.path,
            branch: branch.trim(),
            mode,
          })
            .then(setResult)
            .catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : String(error)),
            );
        }}
      >
        <p className="micro">New plot</p>
        <h2>Branch from {source.name}</h2>
        <p className="dialog-copy">
          Silvic creates the worktree, assigns a stable address, then runs
          whatever this repository declares as provisioning.
        </p>
        <label className="dialog-field">
          <span className="micro">Branch</span>
          <input
            autoFocus
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="feature/agent-task"
          />
        </label>
        <fieldset className="choices">
          <legend className="micro">Location</legend>
          <label data-selected={mode === "worktree" || undefined}>
            <input
              type="radio"
              name="mode"
              checked={mode === "worktree"}
              onChange={() => setMode("worktree")}
            />
            <strong>Linked worktree</strong>
            <span>Fast and space-efficient</span>
          </label>
          <label data-selected={mode === "clone" || undefined}>
            <input
              type="radio"
              name="mode"
              checked={mode === "clone"}
              onChange={() => setMode("clone")}
            />
            <strong>Independent clone</strong>
            <span>Fully isolated Git directory</span>
          </label>
        </fieldset>
        {plotName && <p className="destination mono">{plotName}</p>}
        {failure && <p className="dialog-error">{failure}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={loading || !plotName}
          >
            {loading ? "Creating…" : "Create plot"}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeliveryDialog({
  workspace,
  onClose,
  onComplete,
}: {
  workspace: WorkspaceSnapshot;
  onClose(): void;
  onComplete(): Promise<void>;
}) {
  const [changes, setChanges] = useState<WorkspaceChanges>();
  const [draft, setDraft] = useState<DeliveryDraft>({
    commitMessage: "",
    pullRequestTitle: "",
    pullRequestBody: "",
  });
  const [push, setPush] = useState(true);
  const [createPullRequest, setCreatePullRequest] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    void window.silvic
      .getChanges({ path: workspace.path })
      .then((result) => {
        setChanges(result);
        if (!result.status.trim()) {
          setDraft((current) => ({
            ...current,
            commitMessage: "Push existing commits",
          }));
        }
      })
      .catch((error) =>
        setFailure(error instanceof Error ? error.message : String(error)),
      );
  }, [workspace.path]);

  const generate = async () => {
    setWorking(true);
    setFailure(undefined);
    try {
      setDraft(await window.silvic.draftDelivery({ path: workspace.path }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  const execute = async () => {
    setWorking(true);
    setFailure(undefined);
    try {
      await window.silvic.executeDelivery({
        path: workspace.path,
        commitMessage: draft.commitMessage,
        push,
        createPullRequest,
        pullRequestTitle: draft.pullRequestTitle,
        pullRequestBody: draft.pullRequestBody,
        reviewDigest: changes?.reviewDigest ?? "",
        confirmed: true,
      });
      await onComplete();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setWorking(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <section
        className="dialog delivery"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="micro">Confirmed delivery</p>
        <h2>Review &amp; ship {workspace.name}</h2>
        <pre className="patch mono">
          {changes
            ? changes.patch ||
              "No uncommitted changes; existing commits can be pushed."
            : "Loading changes…"}
        </pre>
        {changes?.warnings.map((warning) => (
          <p className="warning" key={warning}>
            {warning}
          </p>
        ))}
        <label className="dialog-field">
          <span className="micro">Commit message</span>
          <input
            value={draft.commitMessage}
            onChange={(event) =>
              setDraft({ ...draft, commitMessage: event.target.value })
            }
            placeholder="Describe the change"
          />
        </label>
        <button
          type="button"
          className="ghost-button draft-button"
          onClick={() => void generate()}
          disabled={working || !changes?.status.trim()}
        >
          <Bot size={12} /> Draft with Codex
        </button>
        <div className="checks">
          <label>
            <input
              type="checkbox"
              checked={push}
              onChange={(event) => {
                setPush(event.target.checked);
                if (!event.target.checked) setCreatePullRequest(false);
              }}
            />
            Push branch to origin
          </label>
          <label>
            <input
              type="checkbox"
              checked={createPullRequest}
              disabled={!push}
              onChange={(event) => setCreatePullRequest(event.target.checked)}
            />
            Create GitHub pull request
          </label>
        </div>
        {createPullRequest && (
          <>
            <label className="dialog-field">
              <span className="micro">Pull request title</span>
              <input
                value={draft.pullRequestTitle}
                onChange={(event) =>
                  setDraft({ ...draft, pullRequestTitle: event.target.value })
                }
              />
            </label>
            <label className="dialog-field">
              <span className="micro">Pull request body</span>
              <textarea
                value={draft.pullRequestBody}
                onChange={(event) =>
                  setDraft({ ...draft, pullRequestBody: event.target.value })
                }
              />
            </label>
          </>
        )}
        {failure && <p className="dialog-error">{failure}</p>}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={working || !changes || !draft.commitMessage.trim()}
            onClick={() => void execute()}
          >
            {working
              ? "Working…"
              : createPullRequest
                ? "Commit, push & create PR"
                : push
                  ? "Commit & push"
                  : "Commit"}
          </button>
        </div>
      </section>
    </div>
  );
}

function EmptyState({ onAdd, loading }: { onAdd(): void; loading: boolean }) {
  return (
    <div className="empty-state">
      <div className="drag-region" />
      <span className="empty-mark">
        <Mark size={30} />
      </span>
      <h1>{loading ? "Surveying your projects…" : "Start with a project"}</h1>
      <p>Choose a repository, or a folder containing the projects you work on.</p>
      {!loading && (
        <button type="button" className="primary-button" onClick={onAdd}>
          <Plus size={13} /> Add projects
        </button>
      )}
    </div>
  );
}
