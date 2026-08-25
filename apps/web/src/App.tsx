import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  LogIn,
  Monitor,
  Moon,
  MoreHorizontal,
  Network,
  PackageCheck,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  Sun,
  Terminal,
  X,
} from "lucide-react";

import type {
  AppearancePreference,
  ConnectorFailure,
  ConnectorObservation,
  CreateEnvironmentRequest,
  DeliveryDraft,
  HarnessDefinition,
  HarnessId,
  IssueSummary,
  PlotCommand,
  PlotAdoptionPlan,
  PlotAdoptionRunResult,
  PlotCreationResult,
  PlotPreview,
  PlotProcess,
  PlotProgressStep,
  PlotProvisionRunResult,
  PlotProvisioning,
  PlotResource,
  PlotResourceDefinition,
  ProjectSnapshot,
  ProvisionRemedyId,
  ProvisionResult,
  PullRequestSummary,
  Recipe,
  SilvicSnapshot,
  WorkspaceChanges,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { useAppearance } from "./appearance";
import { Grove } from "./Grove";
import { workspaceMatchesQuery } from "./grove-layout";
import { Mark } from "./Mark";
import { HarnessRows, harnessLabel } from "./harnesses";
import { IssuePicker } from "./IssuePicker";
import { CodexMark, HarnessMark } from "./providers";
import { RecipeDialog } from "./RecipeDialog";
import { TeardownDialog } from "./TeardownDialog";
import { AppUpdater } from "./Updater";
import {
  cardRuntimeState,
  localChangeCount,
  locationLabel,
  projectTone,
  workingTreeLabel,
  workspaceState,
} from "./state";
import { concernsBranch, failureMessage } from "./errors";
import { namedRoutingReady, pollNamedRouting } from "./named-routing";
import { plotResources } from "./plot-resources";
import { pullRequestReference } from "./pull-request";
import { PlotList } from "./PlotList";
import { useAccelerator, useKeyLayer } from "./shortcuts";
import { useSilvic } from "./store";
import {
  applyProvisionRun,
  branchForIssue,
  branchForPlotName,
  branchIsTaken,
} from "./task";

type StageView = "canvas" | "list";

const stageViewKey = "silvic.stage.view.v1";

function readStageView(): StageView {
  try {
    return window.localStorage.getItem(stageViewKey) === "list"
      ? "list"
      : "canvas";
  } catch {
    return "canvas";
  }
}

/**
 * Each row can be made the default for the Open button. The control sits on the
 * left so the current default is scannable down the edge of the menu.
 */
export function App() {
  const {
    snapshot,
    roots,
    activeProjectIds,
    selectedProjectId,
    selectedWorkspaceId,
    loading,
    error,
    initialize,
    refresh,
    addRoot,
    setProjectActive,
    defaultHarness,
    setDefaultHarness,
    createEnvironment,
    selectProject,
    selectWorkspace,
    processes,
    reportFailure,
  } = useSilvic(
    useShallow((state) => ({
      snapshot: state.snapshot,
      roots: state.roots,
      activeProjectIds: state.activeProjectIds,
      selectedProjectId: state.selectedProjectId,
      selectedWorkspaceId: state.selectedWorkspaceId,
      loading: state.loading,
      error: state.error,
      initialize: state.initialize,
      refresh: state.refresh,
      addRoot: state.addRoot,
      setProjectActive: state.setProjectActive,
      defaultHarness: state.defaultHarness,
      setDefaultHarness: state.setDefaultHarness,
      createEnvironment: state.createEnvironment,
      selectProject: state.selectProject,
      selectWorkspace: state.selectWorkspace,
      processes: state.processes,
      reportFailure: state.reportFailure,
    })),
  );
  const { appearance, preference, setPreference } = useAppearance();
  const [query, setQuery] = useState("");
  const [stageView, setStageViewState] = useState<StageView>(readStageView);
  const setStageView = (view: StageView) => {
    setStageViewState(view);
    try {
      window.localStorage.setItem(stageViewKey, view);
    } catch {
      // A full or unavailable store only costs remembering the choice.
    }
  };
  const [menuProjectId, setMenuProjectId] = useState<string>();
  const [recipeProject, setRecipeProject] = useState<ProjectSnapshot>();
  const [teardownPlot, setTeardownPlot] = useState<WorkspaceSnapshot>();
  const [provisioningPlot, setProvisioningPlot] = useState<WorkspaceSnapshot>();
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [deliveryWorkspace, setDeliveryWorkspace] =
    useState<WorkspaceSnapshot>();

  useEffect(() => {
    let current = true;
    let dispose: () => void = () => {};
    void initialize().then((cleanup) => {
      if (current) dispose = cleanup;
      else cleanup();
    });
    return () => {
      current = false;
      dispose();
    };
  }, [initialize]);

  // Local filesystem changes are event-driven in the main process. Remote
  // observations reconcile infrequently and only while somebody can see them.
  useEffect(() => {
    let interval: number | undefined;
    const stop = () => {
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
    };
    const start = () => {
      stop();
      interval = window.setInterval(
        () => void window.silvic.refreshObservations(),
        5 * 60_000,
      );
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
        void window.silvic.setRendererVisible(false);
      } else {
        void window.silvic.setRendererVisible(true);
        void window.silvic.refreshObservations();
        start();
      }
    };
    void window.silvic.setRendererVisible(!document.hidden);
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      void window.silvic.setRendererVisible(false);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

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
  const searchResultCount =
    project && query.trim()
      ? project.workspaces.filter((candidate) =>
          workspaceMatchesQuery(candidate, query, project),
        ).length
      : undefined;
  const openWorkspace = useCallback(
    async (path: string, target: HarnessDefinition["id"]) => {
      await window.silvic.openWorkspace({ path, target });
    },
    [],
  );

  // Starting a plot is the one thing worth reaching for without the mouse. It
  // goes quiet behind a dialog so ⌘N never stacks a second one, and it needs a
  // project to start from. In the browser harness Chrome takes ⌘N first; the
  // packaged app sees it, because nothing in Electron's menu claims it.
  const dialogOpen =
    showEnvironment ||
    recipeProject !== undefined ||
    teardownPlot !== undefined ||
    provisioningPlot !== undefined ||
    deliveryWorkspace !== undefined;
  useAccelerator(
    "n",
    project && !dialogOpen ? () => setShowEnvironment(true) : undefined,
  );
  // A project's recipe says what can be run in its plots. It is read here so
  // every plot of the project answers from the same reading.
  const [commands, setCommands] = useState<
    readonly (readonly [string, PlotCommand])[]
  >([]);
  const [declaredResources, setDeclaredResources] = useState<
    Readonly<Record<string, PlotResourceDefinition>>
  >({});
  useEffect(() => {
    if (!project) return;
    let current = true;
    void window.silvic
      .getRecipe(project.id)
      .then((document) => {
        if (current) {
          setCommands(Object.entries(document.recipe.commands ?? {}));
          setDeclaredResources(document.recipe.resources ?? {});
        }
      })
      .catch(() => {
        if (current) {
          setCommands([]);
          setDeclaredResources({});
        }
      });
    return () => {
      current = false;
    };
  }, [project?.id]);

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
          <AppUpdater />
          {snapshot.connectorFailures.some(
            (failure) => failure.connectorId === "github",
          ) && (
            <button
              type="button"
              className="rail-action"
              onClick={() => void window.silvic.connectGitHub()}
            >
              <LogIn size={13} />
              Sign in to GitHub
            </button>
          )}
          <div className="rail-status">
            <div className="rail-status-lines">
              <p className="micro rail-count">
                {roots.length} watched location{roots.length === 1 ? "" : "s"}
              </p>
              {snapshot.connectorFailures.length > 0 && (
                <ConnectorHealth failures={snapshot.connectorFailures} />
              )}
            </div>
            <SettingsMenu preference={preference} onChange={setPreference} />
          </div>
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
                <StageViewToggle value={stageView} onChange={setStageView} />
                <label className="search">
                  <Search size={13} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      // Scoped to the field rather than the window: Escape
                      // elsewhere belongs to whatever dialog is in front.
                      if (event.key !== "Escape" || !query) return;
                      event.preventDefault();
                      setQuery("");
                    }}
                    placeholder="Find in project"
                    aria-label="Find in project"
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X size={11} />
                    </button>
                  )}
                  <span className="visually-hidden" role="status">
                    {searchResultCount === undefined
                      ? ""
                      : searchResultCount === 0
                        ? "No matching plots"
                        : `${searchResultCount} matching ${searchResultCount === 1 ? "plot" : "plots"}`}
                  </span>
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

            {stageView === "canvas" ? (
              <Grove
                project={project}
                commands={commands}
                processes={processes}
                query={query}
                appearance={appearance}
                selectedWorkspaceId={workspace?.workspaceId}
                onSelect={selectWorkspace}
                onOpen={openWorkspace}
                onEditRecipe={() => setRecipeProject(project)}
                defaultHarness={defaultHarness}
                onSetDefaultHarness={(id) => void setDefaultHarness(id)}
                onRename={(workspaceId, name) =>
                  window.silvic.renamePlot({ workspaceId, name })
                }
                onNewPlot={() => setShowEnvironment(true)}
                onTeardown={setTeardownPlot}
              />
            ) : (
              <PlotList
                project={project}
                commands={commands}
                declaredResources={declaredResources}
                processes={processes}
                query={query}
                selectedWorkspaceId={workspace?.workspaceId}
                onSelect={selectWorkspace}
              />
            )}
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
            commands={commands}
            declaredResources={declaredResources}
            processes={processes}
            defaultHarness={defaultHarness}
            onSetDefaultHarness={(id) => void setDefaultHarness(id)}
            onOpen={openWorkspace}
            onShip={() => setDeliveryWorkspace(workspace)}
            onProvision={() => setProvisioningPlot(workspace)}
          />
        ) : (
          <div className="inspector-empty">
            <p className="micro">Inspector</p>
            <p>Select a plot on the canvas.</p>
          </div>
        )}
      </aside>

      {provisioningPlot &&
        (provisioningPlot.adoption &&
        provisioningPlot.adoption.status !== "adopted" ? (
          <AdoptionDialog
            key={provisioningPlot.workspaceId}
            workspace={provisioningPlot}
            onClose={() => setProvisioningPlot(undefined)}
          />
        ) : (
          <ProvisionDialog
            key={provisioningPlot.workspaceId}
            workspace={provisioningPlot}
            onClose={() => setProvisioningPlot(undefined)}
          />
        ))}
      {teardownPlot && (
        <TeardownDialog
          workspace={teardownPlot}
          onClose={() => setTeardownPlot(undefined)}
          onFailed={reportFailure}
        />
      )}
      {recipeProject && (
        <RecipeDialog
          projectId={recipeProject.id}
          projectName={recipeProject.name}
          onClose={() => setRecipeProject(undefined)}
          onSaved={(recipe: Recipe) => {
            setCommands(Object.entries(recipe.commands ?? {}));
            setDeclaredResources(recipe.resources ?? {});
            setRecipeProject(undefined);
          }}
        />
      )}
      {error && <div className="error-toast">{error}</div>}
      {showEnvironment && project && (
        <NewPlotDialog
          sources={project.workspaces}
          branches={project.branches}
          remoteBranches={project.remoteBranches}
          defaultHarness={defaultHarness}
          snapshot={snapshot}
          onCancel={() => setShowEnvironment(false)}
          onOpen={openWorkspace}
          onSetDefaultHarness={(id) => void setDefaultHarness(id)}
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
            {candidate.workspaces.length > 1 && (
              <span className="project-count mono">
                {candidate.workspaces.length}
              </span>
            )}
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

/**
 * Connector health is app-level and rarely actionable, so it sits quietly in the
 * rail instead of covering the canvas. Naming each connector and its error keeps
 * the summary honest — "4 unavailable" on its own explains nothing. The one
 * fixable failure, GitHub sign-in, gets its own rail action instead of hiding
 * in here.
 */
function ConnectorHealth({
  failures,
}: {
  failures: readonly ConnectorFailure[];
}) {
  const [open, setOpen] = useState(false);

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
        </div>
      )}
      <button
        type="button"
        className="connector-toggle micro"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {failures.length} connector{failures.length === 1 ? "" : "s"}{" "}
        unavailable
      </button>
    </div>
  );
}

/**
 * What happens to a plot's commands when the window closes. Silvic starts dev
 * servers now, so it has to say what becomes of them — and letting them run is
 * the habit `work` set, where a daemon holds them and closing a terminal costs
 * nothing.
 */
function KeepRunningToggle() {
  const [keep, setKeep] = useState<boolean>();

  useEffect(() => {
    let current = true;
    void window.silvic
      .getKeepCommandsRunning()
      .then((value) => current && setKeep(value))
      .catch(() => current && setKeep(true));
    return () => {
      current = false;
    };
  }, []);

  if (keep === undefined) return null;
  return (
    <label className="keep-running">
      <input
        type="checkbox"
        checked={keep}
        onChange={(event) => {
          setKeep(event.target.checked);
          void window.silvic.setKeepCommandsRunning(event.target.checked);
        }}
      />
      Keep commands running when Silvic quits
    </label>
  );
}

/**
 * The canvas shows how the plots relate; the list shows what they are doing.
 * Both read the same snapshot and drive the same selection, so switching is
 * free of state loss and the preference is worth remembering across launches.
 */
function StageViewToggle({
  value,
  onChange,
}: {
  value: StageView;
  onChange(next: StageView): void;
}) {
  const options = [
    ["canvas", "Canvas", <Network size={12} key="c" />],
    ["list", "List", <Rows3 size={12} key="l" />],
  ] as const;
  return (
    <div className="segmented" role="group" aria-label="View">
      {options.map(([id, label, icon]) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={`${label} view`}
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

/**
 * Appearance and quit behaviour are set once and rarely touched, so they live
 * behind a gear instead of holding permanent space in the rail.
 */
function SettingsMenu({
  preference,
  onChange,
}: {
  preference: AppearancePreference;
  onChange(next: AppearancePreference): void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className="rail-settings"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        className="settings-toggle"
        aria-label="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Settings size={14} />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="settings-menu" aria-label="Settings">
            <span className="micro">Appearance</span>
            <AppearanceControl value={preference} onChange={onChange} />
            <KeepRunningToggle />
          </div>
        </>
      )}
    </div>
  );
}

function WorkspaceInspector({
  workspace,
  commands,
  declaredResources,
  processes,
  defaultHarness,
  onSetDefaultHarness,
  onOpen,
  onShip,
  onProvision,
}: {
  workspace: WorkspaceSnapshot;
  /** What the recipe says can be run here. */
  commands: readonly (readonly [string, PlotCommand])[];
  declaredResources: Readonly<Record<string, PlotResourceDefinition>>;
  processes: readonly PlotProcess[];
  defaultHarness: HarnessId;
  onSetDefaultHarness(id: HarnessId): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onShip(): void;
  onProvision(): void;
}) {
  const [openMenu, setOpenMenu] = useState(false);
  const runtimeState = cardRuntimeState({ workspace, commands, processes });
  const state = runtimeState
    ? { label: runtimeState.label, tone: runtimeState.tone }
    : workspaceState(workspace);
  const changes = localChangeCount(workspace);
  const grouped = useMemo(
    () =>
      Map.groupBy(workspace.observations, (observation) => observation.kind),
    [workspace.observations],
  );
  const resources = useMemo(
    () =>
      plotResources({
        workspace,
        commands: Object.fromEntries(commands),
        processes,
        declared: declaredResources,
      }),
    [workspace, commands, processes, declaredResources],
  );
  const preview = resources.find(
    (resource) =>
      resource.provider === "web" &&
      resource.state === "active" &&
      resource.url,
  )?.url;
  const runtimeResources = resources.filter((resource) =>
    ["runtime", "agent"].includes(resource.kind),
  );
  const reviewResources = resources.filter(
    (resource) => resource.kind === "review",
  );
  const environmentResources = resources.filter(
    (resource) =>
      !runtimeResources.includes(resource) &&
      !reviewResources.includes(resource),
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
        <h2 title={workspace.task?.title ?? workspace.name}>
          {workspace.task?.title ?? workspace.name}
        </h2>
        {(workspace.task || workspace.branch !== workspace.name) && (
          <p className="inspector-branch mono">
            <GitBranch size={12} />
            {workspace.branch || "Detached"}
          </p>
        )}

        <div className="split-button">
          <button
            type="button"
            onClick={() => void onOpen(workspace.path, defaultHarness)}
          >
            <HarnessMark id={defaultHarness} size={14} />
            Open in {harnessLabel(defaultHarness)}
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
                <HarnessRows
                  defaultHarness={defaultHarness}
                  onOpen={(id) => {
                    setOpenMenu(false);
                    void onOpen(workspace.path, id);
                  }}
                  onSetDefault={onSetDefaultHarness}
                />
              </div>
            </>
          )}
        </div>
        {preview && (
          <button
            type="button"
            className="ghost-button inspector-preview"
            onClick={() => void window.silvic.openLink({ url: preview })}
          >
            <ExternalLink size={13} />
            Open preview
          </button>
        )}
      </div>

      <div className="inspector-body">
        {workspace.task && (
          <Section icon={<GitPullRequest size={12} />} title="Task">
            {workspace.task.description && (
              <p className="inspector-task-description">
                {workspace.task.description}
              </p>
            )}
            {workspace.task.issue && (
              <button
                type="button"
                className="section-action"
                onClick={() =>
                  void window.silvic.openLink({
                    url: workspace.task?.issue?.url ?? "",
                  })
                }
              >
                GitHub #{workspace.task.issue.number}
                <ExternalLink size={11} />
              </button>
            )}
          </Section>
        )}
        <Section icon={<GitBranch size={12} />} title="Code">
          <Field label="Working tree" value={workingTreeLabel(workspace)} />
          <Field
            label="Upstream"
            value={workspace.git.upstream ?? "Not configured"}
          />
          <Field
            label="Ahead / behind"
            value={`${workspace.git.ahead} / ${workspace.git.behind}`}
          />
          <Field
            label="Revision"
            value={workspace.git.revision?.slice(0, 9) ?? "Unknown"}
          />
          {(changes > 0 || workspace.git.ahead > 0) && (
            <button type="button" className="section-action" onClick={onShip}>
              Review &amp; ship
            </button>
          )}
        </Section>
        {!workspace.isPrimary && (
          <Section icon={<PackageCheck size={12} />} title="Provisioning">
            {workspace.adoption && (
              <Field
                label="Adoption"
                value={adoptionLabel(workspace.adoption.status)}
              />
            )}
            <Field
              label="Recipe"
              value={provisioningLabel(workspace.provisioning)}
            />
            {workspace.provisioning?.status === "failed" && (
              <Field
                label="Stopped at"
                value={
                  failedStepLabel(workspace.provisioning) ?? "Unknown step"
                }
              />
            )}
            <button
              type="button"
              className="section-action"
              onClick={onProvision}
            >
              {workspace.adoption?.status === "not-adopted"
                ? "Adopt plot or family…"
                : workspace.adoption?.status === "adopting"
                  ? "Resume adoption…"
                  : workspace.adoption?.status === "failed"
                    ? "Retry adoption…"
                    : workspace.provisioning?.status === "failed"
                      ? "Finish provisioning"
                      : "Provision again"}
            </button>
          </Section>
        )}
        <PlotResourceSection
          icon={<Terminal size={12} />}
          title="Runtime"
          empty="No runtime attached"
          workspace={workspace}
          resources={runtimeResources}
          processes={processes}
        />
        <PlotResourceSection
          icon={<PackageCheck size={12} />}
          title="Environment"
          empty="No provider environment attached"
          workspace={workspace}
          resources={environmentResources}
          processes={processes}
        />
        <PlotResourceSection
          icon={<GitPullRequest size={12} />}
          title="Review"
          empty="No pull request"
          workspace={workspace}
          resources={reviewResources}
          processes={processes}
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

function PlotResourceSection({
  icon,
  title,
  empty,
  workspace,
  resources,
  processes,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  workspace: WorkspaceSnapshot;
  resources: readonly PlotResource[];
  processes: readonly PlotProcess[];
}) {
  return (
    <Section icon={icon} title={title}>
      {resources.length === 0 ? (
        <p className="section-empty">{empty}</p>
      ) : (
        resources.map((resource) => (
          <PlotResourceRow
            key={resource.id}
            workspace={workspace}
            resource={resource}
            processes={processes}
          />
        ))
      )}
    </Section>
  );
}

/**
 * Plots made before Silvic recorded provisioning have nothing to report, which
 * is not the same as having succeeded and must not read like it.
 */
function provisioningLabel(provisioning: PlotProvisioning | undefined): string {
  if (!provisioning) return "Not recorded";
  return provisioning.status === "complete"
    ? `Complete · ${shortDate(provisioning.at)}`
    : `Failed · ${shortDate(provisioning.at)}`;
}

function adoptionLabel(
  status: NonNullable<WorkspaceSnapshot["adoption"]>["status"],
): string {
  if (status === "not-adopted") return "Not adopted";
  if (status === "adopting") return "Adoption in progress";
  if (status === "failed") return "Failed · retry available";
  return "Adopted";
}

function failedStepLabel(provisioning: PlotProvisioning): string | undefined {
  return provisioning.steps.find((step) => step.exitCode !== 0)?.label;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "unknown"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PlotResourceRow({
  workspace,
  resource,
  processes,
}: {
  workspace: WorkspaceSnapshot;
  resource: PlotResource;
  processes: readonly PlotProcess[];
}) {
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [logs, setLogs] = useState<string>();
  const [copied, setCopied] = useState(false);
  const address = resource.url ?? resource.dashboardUrl;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const processStatus = processes.find(
    (process) =>
      process.plotPath === workspace.path && process.id === resource.commandId,
  )?.status;
  const starting = processStatus === "starting";
  const running = processStatus === "running";
  const stopping = processStatus === "stopping";
  const open = (url: string) =>
    void window.silvic
      .openLink({ url })
      .catch((error: unknown) => setFailure(failureMessage(error)));
  const act = () => {
    const id = resource.commandId;
    if (!id) return;
    setWorking(true);
    setFailure(undefined);
    const request = { path: workspace.path, id };
    void (
      starting || running
        ? window.silvic.stopPlotCommand(request)
        : window.silvic.startPlotCommand(request)
    )
      .catch((error: unknown) => setFailure(failureMessage(error)))
      .finally(() => setWorking(false));
  };
  const readLogs = () => {
    const id = resource.commandId;
    if (!id) return;
    setFailure(undefined);
    void window.silvic
      .readPlotCommandOutput({ path: workspace.path, id })
      .then((output) => setLogs(logs === undefined ? output : undefined))
      .catch((error: unknown) => setFailure(failureMessage(error)));
  };

  return (
    <div className="sidebar-resource" data-state={resource.state}>
      <div className="sidebar-resource-main">
        <i className="dot" data-tone={resource.state} />
        <div className="sidebar-resource-copy">
          <strong>{resource.label}</strong>
          <span className="truncate">
            {resource.provider} · {resource.kind} · {resource.isolation}
          </span>
        </div>
        <div className="sidebar-resource-actions">
          {address && (
            <button
              type="button"
              aria-label={`Open ${resource.label}`}
              title={resource.url ? "Open" : "Open dashboard"}
              onClick={() => open(address)}
            >
              <ExternalLink size={11} />
            </button>
          )}
          {resource.commandId && (
            <button
              type="button"
              aria-label={`${logs === undefined ? "Show" : "Hide"} ${resource.label} logs`}
              title="Logs"
              onClick={readLogs}
            >
              <Terminal size={11} />
            </button>
          )}
          {resource.commandId && (
            <button
              type="button"
              aria-label={`${stopping ? "Stopping" : starting ? "Stop starting" : running ? "Stop" : "Start"} ${resource.label}`}
              title={
                stopping
                  ? "Stopping…"
                  : starting
                    ? "Starting… · click to stop"
                    : running
                      ? "Stop"
                      : "Start"
              }
              onClick={act}
              disabled={working || stopping}
            >
              {starting || running || stopping ? (
                <Square size={10} />
              ) : (
                <Play size={10} />
              )}
            </button>
          )}
        </div>
      </div>
      <p className="sidebar-resource-detail mono truncate">
        {failure ?? resource.detail ?? resourceStateLabel(resource.state)}
      </p>
      {address && (
        <button
          type="button"
          className="sidebar-resource-url mono truncate"
          title={`Copy ${address}`}
          onClick={() =>
            void window.silvic.copyText(address).then(() => setCopied(true))
          }
        >
          <Copy size={10} />
          <span className="truncate">
            {copied ? "Copied" : address.replace(/^https?:\/\//, "")}
          </span>
        </button>
      )}
      {logs !== undefined && (
        <pre className="sidebar-resource-logs mono">
          {logs || "No output yet"}
        </pre>
      )}
    </div>
  );
}

function resourceStateLabel(state: PlotResource["state"]): string {
  switch (state) {
    case "active":
      return "Running";
    case "ready":
      return "Ready";
    case "waiting":
      return "Waiting";
    case "attention":
      return "Needs attention";
    case "quiet":
      return "Stopped";
    default:
      return "Status unknown";
  }
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

/**
 * The address and the location are the two things worth taking away from a
 * finished plot, so both are one click from the clipboard. A path is shown by
 * its tail: the front of it is the same for every plot in the project.
 */
function CopyRow({
  label,
  value,
  display,
}: {
  label: string;
  value: string;
  display?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="field copy-field"
      title={`${value}\nClick to copy`}
      onClick={() => {
        void window.silvic.copyText(value);
        setCopied(true);
      }}
    >
      <span className="field-label">{label}</span>
      <i className="field-leader" />
      <span className="field-value mono truncate">{display ?? value}</span>
      <span className="copy-mark" data-copied={copied || undefined}>
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </span>
    </button>
  );
}

/**
 * Exactly as tall as the list can be, so searching it cannot resize it. Rows
 * are a fixed 30px with a pixel between them; eight is as many as the column
 * gives up before the rest scroll.
 */
function candidateListHeight(count: number, minimum = 1): number {
  const rows = Math.min(Math.max(count, minimum), 8);
  return rows * 30 + (rows - 1);
}

/** `github.com/example/silvic` is said as `example/silvic` to a person. */
function repositorySlug(projectId: string): string {
  return projectId.split("/").slice(-2).join("/");
}

/** `origin/feature-x` becomes the local `feature-x` that follows it. */
function localBranchName(remoteRef: string): string {
  const separator = remoteRef.indexOf("/");
  return separator > 0 ? remoteRef.slice(separator + 1) : remoteRef;
}

/** Every plot in a project shares the front of its path; the tail names it. */
function pathTail(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function secondsLabel(durationMs: number): string {
  return `${Math.round(durationMs / 100) / 10}s`;
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
  sources,
  branches,
  remoteBranches,
  defaultHarness,
  snapshot,
  onCancel,
  onOpen,
  onSetDefaultHarness,
  onCreate,
}: {
  /** Everything in the project a plot could be branched from. */
  sources: readonly WorkspaceSnapshot[];
  /** Local branch names, so a taken one is refused without asking main. */
  branches: readonly string[];
  /** Remote-tracking branches, as `origin/feature-x`. */
  remoteBranches: readonly string[];
  defaultHarness: HarnessId;
  /** Live, so a deployment a connector finds afterwards still shows up. */
  snapshot: SilvicSnapshot;
  onCancel(): void;
  onOpen(path: string, target: HarnessDefinition["id"]): Promise<void>;
  onSetDefaultHarness(id: HarnessId): void;
  onCreate(request: CreateEnvironmentRequest): Promise<PlotCreationResult>;
}) {
  // What a plot is cut from. It defaults to the project's own checkout: the
  // ways in here are all project-level, and inheriting whichever card happened
  // to be selected made parentage a thing that happened to you.
  const trunk = sources.find((candidate) => candidate.isPrimary) ?? sources[0];
  const [sourceId, setSourceId] = useState(trunk?.workspaceId ?? "");
  const source =
    sources.find((candidate) => candidate.workspaceId === sourceId) ?? trunk;
  const [branch, setBranch] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [issue, setIssue] = useState<IssueSummary>();
  const [mode, setMode] = useState<"worktree" | "clone">("worktree");
  const [creating, setCreating] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  const [steps, setSteps] = useState<readonly PlotProgressStep[]>([]);
  const [result, setResult] = useState<PlotCreationResult>();
  // What it was actually cut from, kept from the moment it was asked for. The
  // list of sources gains the new plot the instant it exists, so reading the
  // source back out of it afterwards describes the wrong thing.
  const [createdFrom, setCreatedFrom] = useState<{
    name: string;
    branch: string;
    mode: "worktree" | "clone";
  }>();
  const [failure, setFailure] = useState<string>();
  const [previewFailure, setPreviewFailure] = useState<string>();
  const [conflict, setConflict] = useState<string>();
  const [preview, setPreview] = useState<PlotPreview>();
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [settingUpRouting, setSettingUpRouting] = useState(false);
  // Set when the plot is to take up a branch that already exists rather than
  // cut a new one. The ref is what Git is pointed at; the name is the local
  // branch that ends up in the worktree, and the number is the pull request it
  // was reached through, when it was.
  const [adopt, setAdopt] = useState<{
    ref: string;
    name: string;
    pullRequest?: number;
  }>();
  const [pullRequest, setPullRequest] = useState<PullRequestSummary>();
  const [pullRequestLoading, setPullRequestLoading] = useState(false);
  const [pullRequestFailure, setPullRequestFailure] = useState<string>();
  // The branch being created, so progress from an abandoned attempt cannot
  // paint over the one the dialog is waiting on.
  const creatingBranch = useRef<string | undefined>(undefined);
  // ⌘↵ goes through the form rather than around it, so the keyboard and the
  // Start button run the same submit.
  const form = useRef<HTMLFormElement>(null);
  // The branches came with the snapshot, so the search answers on every
  // keystroke. Waiting on a round trip to say what is known locally is a
  // delay with nothing on the other end of it.
  const query = branchQuery.trim();
  const wanted = adopt?.name ?? branchForPlotName(branch);
  const taken = branchIsTaken({
    branch: wanted,
    branches,
    creating,
    adopting: adopt !== undefined,
  });
  // Branches somebody could open as a plot: local ones no worktree holds, and
  // remote ones with no local counterpart yet. Nobody recalls these by heart,
  // so a search field filters the list rather than asking to be matched
  // exactly.
  const held = new Set(sources.map((candidate) => candidate.git.branch));
  const openable = [
    ...branches
      .filter((name) => !held.has(name))
      .map((name) => ({ ref: name, name, remote: false })),
    ...remoteBranches
      .filter((ref) => !branches.includes(localBranchName(ref)))
      .map((ref) => ({ ref, name: localBranchName(ref), remote: true })),
  ];
  const candidates = openable.filter(
    (candidate) =>
      query === "" || candidate.ref.toLowerCase().includes(query.toLowerCase()),
  );
  const projectId = source?.projectId;
  // A pull request is passed around as a URL or called `#123`, and neither is
  // a branch name — so the same field reads them as what they are and asks
  // GitHub, rather than filtering the branch list down to nothing.
  const reference = pullRequestReference(branchQuery);
  const wantedPullRequest = reference?.number;
  const wantedRepository = reference?.projectId;
  // A refused branch name is a fault of the field, not of the dialog, so it is
  // reported there and the general area is left for everything else.
  const branchFailure =
    (taken ? `Branch ${wanted} already exists` : conflict) ??
    (failure && concernsBranch(failure) ? failure : undefined);
  const plotName = wanted.replaceAll("/", "-");

  const applyPreview = useCallback(
    (next: PlotPreview) => {
      setPreview(next);
      setConflict(adopt ? undefined : next.conflict);
      setPreviewFailure(undefined);
    },
    [adopt],
  );

  useEffect(
    () =>
      window.silvic.onPlotProgress((progress) => {
        if (progress.branch === creatingBranch.current)
          setSteps(progress.steps);
      }),
    [],
  );

  useEffect(() => {
    if (!wanted || !projectId) {
      setConflict(undefined);
      setPreview(undefined);
      setPreviewFailure(undefined);
      return;
    }
    setConflict(undefined);
    setPreview(undefined);
    setPreviewFailure(undefined);
    let current = true;
    // Everything the interface cannot answer itself — a name Git will not
    // take, a directory already standing where the plot would go.
    const timer = window.setTimeout(() => {
      void window.silvic
        .previewPlot({ projectId, branch: wanted })
        .then((next) => {
          if (!current) return;
          applyPreview(next);
        })
        .catch((error: unknown) => {
          if (current) {
            setConflict(undefined);
            setPreview(undefined);
            setPreviewFailure(
              `Could not verify the Plot URL: ${failureMessage(error)}`,
            );
          }
        });
    }, 120);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [wanted, projectId, applyPreview, previewAttempt]);

  useEffect(() => {
    setPullRequest(undefined);
    setPullRequestFailure(undefined);
    if (!wantedPullRequest || !projectId) {
      setPullRequestLoading(false);
      return;
    }
    // A URL says which repository it came from, and taking up a branch of
    // another one is not a thing that can be done here.
    if (wantedRepository && wantedRepository !== projectId.toLowerCase()) {
      setPullRequestLoading(false);
      setPullRequestFailure(
        `That pull request is in ${repositorySlug(wantedRepository)}, not in this project.`,
      );
      return;
    }
    let current = true;
    setPullRequestLoading(true);
    const timer = window.setTimeout(() => {
      void window.silvic
        .findPullRequest({ projectId, number: wantedPullRequest })
        .then((found) => {
          if (!current) return;
          setPullRequest(found);
          setPullRequestFailure(
            found
              ? undefined
              : `This project has no pull request #${wantedPullRequest}.`,
          );
        })
        .catch((error: unknown) => {
          if (current) setPullRequestFailure(failureMessage(error));
        })
        .finally(() => {
          if (current) setPullRequestLoading(false);
        });
    }, 220);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [wantedPullRequest, wantedRepository, projectId]);

  useEffect(() => {
    if (!settingUpRouting || !preview?.advice || !wanted || !projectId) return;
    let current = true;
    let timer: number | undefined;
    let finishWait: (() => void) | undefined;
    void pollNamedRouting({
      preview: () => window.silvic.previewPlot({ projectId, branch: wanted }),
      onPreview: applyPreview,
      isCancelled: () => !current,
      wait: (milliseconds) =>
        new Promise<void>((resolve) => {
          finishWait = resolve;
          timer = window.setTimeout(() => {
            timer = undefined;
            finishWait = undefined;
            resolve();
          }, milliseconds);
        }),
    })
      .then((result) => {
        if (!current) return;
        setSettingUpRouting(false);
        if (result === "timed-out") {
          setFailure(
            "HTTPS setup is not ready yet. Approve the administrator prompt, then try again.",
          );
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        setFailure(failureMessage(error));
        setSettingUpRouting(false);
      });
    return () => {
      current = false;
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
        const resolve = finishWait;
        finishWait = undefined;
        resolve?.();
      }
    };
  }, [settingUpRouting, preview?.advice, wanted, projectId, applyPreview]);

  // One way in for both lists: whichever ref was picked becomes the branch the
  // plot will hold. A branch this clone already has is taken up as it is; one
  // that only exists on the remote is followed by a local branch of its name.
  const takeUp = (
    candidate: { ref: string; name: string },
    number?: number,
  ) => {
    setAdopt({ ...candidate, ...(number ? { pullRequest: number } : {}) });
    setBranch(candidate.name);
    setFailure(undefined);
    setSteps([]);
  };

  const setupNamedRouting = () => {
    setFailure(undefined);
    setSettingUpRouting(true);
    void window.silvic.setupNamedRouting().catch((error: unknown) => {
      setFailure(failureMessage(error));
      setSettingUpRouting(false);
    });
  };

  const openPlot = (target: HarnessId) => {
    if (!result) return;
    setFailure(undefined);
    void onOpen(result.plot.path, target).catch((error: unknown) =>
      setFailure(
        `${harnessLabel(target)} could not be opened: ${failureMessage(error)}`,
      ),
    );
  };

  // Everything the Start button needs before it is worth pressing, named once
  // so the button, the form and ⌘↵ cannot drift apart.
  const canStart =
    !creating &&
    Boolean(plotName) &&
    branchFailure === undefined &&
    namedRoutingReady(preview);

  // The dialog turns into a report once the plot exists, and the keys follow
  // it: ⌘↵ opens what was just made rather than making another one. An open
  // harness menu is closer than the dialog, so Escape closes that first.
  useKeyLayer(
    result
      ? {
          dismiss: repairing
            ? undefined
            : openMenu
              ? () => setOpenMenu(false)
              : onCancel,
          confirm: repairing ? undefined : () => openPlot(defaultHarness),
        }
      : {
          dismiss: creating ? undefined : onCancel,
          confirm: canStart ? () => form.current?.requestSubmit() : undefined,
        },
  );

  if (!source) return null;

  if (result) {
    const failed = result.provision.find((step) => step.exitCode !== 0);
    const runtimeFailed = result.runtime.status === "failed";
    const previewFailed = result.readiness.status === "failed";
    const commands = Object.entries(result.commands);
    // Connectors run after creation returns, so a deployment appears a moment
    // later. Reading it from the live snapshot lets the screen fill in rather
    // than freeze at whatever was known the instant the plot was made.
    const attached =
      snapshot.projects
        .flatMap((candidate) => candidate.workspaces)
        .find((candidate) => candidate.path === result.plot.path)
        ?.observations.filter(
          (observation) =>
            observation.kind === "deployment" || observation.kind === "runtime",
        ) ?? [];
    const startAgain = () => {
      setResult(undefined);
      setSteps([]);
      setFailure(undefined);
      setBranch("");
      setBranchQuery("");
    };
    // The repair runs in the plot that already exists, so the dialog reports it
    // exactly as it reported creation: the same steps, live.
    const repair = (remedy: ProvisionRemedyId) => {
      setFailure(undefined);
      setSteps([]);
      setRepairing(true);
      creatingBranch.current = createdFrom?.branch ?? branch.trim();
      void window.silvic
        .provisionPlot({ path: result.plot.path, remedy })
        .then((run) => setResult(applyProvisionRun(result, run)))
        .catch((error: unknown) => setFailure(failureMessage(error)))
        .finally(() => {
          creatingBranch.current = undefined;
          setRepairing(false);
        });
    };
    return (
      <div className="scrim" onMouseDown={repairing ? undefined : onCancel}>
        <section
          className="dialog plot"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {repairing ? (
            <p className="micro">Repairing</p>
          ) : failed ? (
            <p className="micro">Provisioning failed</p>
          ) : runtimeFailed ? (
            <p className="state-pill" data-tone="attention">
              <AlertTriangle size={12} />
              Runtime failed
            </p>
          ) : previewFailed ? (
            <p className="state-pill" data-tone="attention">
              <AlertTriangle size={12} />
              Preview unavailable
            </p>
          ) : (
            <p className="state-pill" data-tone="ready">
              <Check size={12} />
              Plot ready
            </p>
          )}
          <h2>{result.plot.name}</h2>
          {createdFrom && (
            <p className="ready-lineage">
              <GitBranch size={11} />
              <span className="mono">{createdFrom.branch}</span>
              <i className="fact-sep" />
              <span>from {createdFrom.name}</span>
              <i className="fact-sep" />
              <span>
                {createdFrom.mode === "worktree"
                  ? "linked worktree"
                  : "independent clone"}
              </span>
            </p>
          )}
          <div className="plot-columns">
            <div className="plot-column">
              <div className="plot-facts-block">
                <CopyRow label="Address" value={result.plot.url} />
                <CopyRow
                  label="Location"
                  value={result.plot.path}
                  display={pathTail(result.plot.path)}
                />
              </div>
              {attached.length > 0 && (
                <div className="ready-section">
                  <p className="micro">Attached</p>
                  {attached.map((observation) => (
                    <Observation
                      key={`${observation.connectorId}:${observation.kind}:${observation.label}`}
                      observation={observation}
                    />
                  ))}
                </div>
              )}
              {commands.length > 0 && (
                <div className="ready-section">
                  <p className="micro">Run here</p>
                  {commands.map(([name, command]) => (
                    <CopyRow
                      key={name}
                      label={name}
                      value={command.run}
                      display={
                        command.url
                          ? `${command.run}  → serves the address`
                          : command.run
                      }
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="plot-column">
              <PlotOnlineStatus result={result} />
              {repairing ? (
                <ProgressSteps steps={steps} settled={!repairing} />
              ) : result.provision.length === 0 ? (
                <p className="dialog-copy">
                  This repository declares no provisioning steps. Add a
                  <code> silvic.json </code> to install dependencies, create a
                  deployment or write environment files when a plot is made.
                </p>
              ) : failed ? (
                <ProvisionResults
                  results={result.provision}
                  onRemedy={repair}
                />
              ) : (
                <div className="ready-section">
                  <p className="micro">
                    Provisioned in
                    <span className="micro-value">
                      {secondsLabel(
                        result.provision.reduce(
                          (total, step) => total + step.durationMs,
                          0,
                        ),
                      )}
                    </span>
                  </p>
                  <ul className="ready-ran">
                    {result.provision.map((step) => (
                      <li key={step.label}>
                        <i className="dot" data-tone="ready" />
                        <strong>{step.label}</strong>
                        <i className="field-leader" />
                        <span className="mono">
                          {secondsLabel(step.durationMs)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {/* Nothing went wrong, so the commands are trivia — until they
                  are not, and then they are the first thing anybody wants. */}
                  <details className="step-output">
                    <summary>What each command was</summary>
                    <ProvisionResults results={result.provision} />
                  </details>
                </div>
              )}
            </div>
          </div>
          {failure && <p className="dialog-error">{failure}</p>}
          <div className="dialog-actions ready-actions">
            <button
              type="button"
              className="link-button"
              onClick={startAgain}
              disabled={repairing}
            >
              <Plus size={12} />
              Another plot
            </button>
            <span className="dialog-spacer" />
            <button
              type="button"
              className="ghost-button"
              onClick={onCancel}
              disabled={repairing}
            >
              {repairing ? "Working…" : "Done"}
            </button>
            <div className="split-button ready-open">
              <button
                type="button"
                onClick={() => openPlot(defaultHarness)}
                disabled={repairing}
              >
                <HarnessMark id={defaultHarness} size={14} />
                Open in {harnessLabel(defaultHarness)}
              </button>
              <button
                type="button"
                className="split-toggle"
                aria-label="Choose another way in"
                aria-expanded={openMenu}
                onClick={() => setOpenMenu(!openMenu)}
                disabled={repairing}
              >
                <ChevronDown size={13} />
              </button>
              {openMenu && (
                <>
                  <div
                    className="menu-scrim"
                    onClick={() => setOpenMenu(false)}
                  />
                  <div className="menu">
                    <HarnessRows
                      defaultHarness={defaultHarness}
                      onOpen={(id) => {
                        setOpenMenu(false);
                        openPlot(id);
                      }}
                      onSetDefault={onSetDefaultHarness}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="scrim" onMouseDown={creating ? undefined : onCancel}>
      <form
        ref={form}
        className="dialog plot"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canStart) return;
          const requested = wanted;
          setFailure(undefined);
          setSteps([]);
          setCreating(true);
          setCreatedFrom({
            name: adopt ? adopt.ref : source.name,
            branch: requested,
            mode,
          });
          creatingBranch.current = requested;
          void onCreate({
            sourcePath: source.path,
            branch: requested,
            mode,
            ...(adopt ? { adopt: adopt.ref } : {}),
            ...(issue
              ? {
                  task: {
                    title: issue.title,
                    ...(issue.body ? { description: issue.body } : {}),
                    issue: {
                      ...issue,
                      labels: [...issue.labels],
                      assignees: [...issue.assignees],
                    },
                  },
                }
              : {}),
          })
            .then(setResult)
            .catch((error: unknown) => setFailure(failureMessage(error)))
            .finally(() => {
              creatingBranch.current = undefined;
              setCreating(false);
            });
        }}
      >
        <p className="micro">New plot</p>
        <h2>Branch from {source.name}</h2>
        <div className="plot-columns">
          <div className="plot-column">
            <p className="dialog-copy">
              Silvic creates the worktree and stable address, then runs the
              visible recipe. A Convex step creates a dev deployment and scoped
              deploy key, copies local variables, syncs server variables, and
              pushes the repository's schema and functions. Starting the Plot
              confirms those provider changes; once its URL responds, you pick
              the harness to open it in.
            </p>
            <div className="task-source">
              <p className="micro">Start from</p>
              <IssuePicker
                projectId={projectId ?? ""}
                selected={issue}
                disabled={creating || !projectId}
                onSelect={(next) => {
                  setIssue(next);
                  if (next) {
                    setBranch(branchForIssue(next));
                    setAdopt(undefined);
                    setFailure(undefined);
                    setSteps([]);
                  }
                }}
              />
            </div>
            <label className="dialog-field">
              <span className="micro">Plot name</span>
              <input
                autoFocus
                value={branch}
                onChange={(event) => {
                  setBranch(event.target.value);
                  // The name is what was refused, so editing it clears the refusal
                  // and the dead plan left behind by the attempt that failed.
                  if (branchFailure) setFailure(undefined);
                  if (steps.length > 0) setSteps([]);
                  if (adopt) setAdopt(undefined);
                }}
                placeholder="Auth callback, pricing experiment…"
                disabled={creating}
                aria-invalid={branchFailure !== undefined}
                aria-errormessage={branchFailure ? "branch-failure" : undefined}
              />
            </label>
            {/* What pressing Create will do, in one slot of fixed height: a
            branch cut, a branch taken up, or the reason for neither. Three
            things to say and one place to say them, so none of them arrives
            by pushing the others down. */}
            <p
              className="adopted"
              id="branch-failure"
              data-taken={(adopt !== undefined && !branchFailure) || undefined}
              data-refused={branchFailure !== undefined || undefined}
            >
              {branchFailure ? (
                <AlertTriangle size={11} />
              ) : (
                <GitBranch size={11} />
              )}
              {branchFailure ? (
                <span>{branchFailure}</span>
              ) : adopt ? (
                <span>
                  Takes up{" "}
                  {adopt.pullRequest ? (
                    <>
                      <span className="mono">#{adopt.pullRequest}</span> on{" "}
                    </>
                  ) : null}
                  <span className="mono">{adopt.ref}</span>
                  {adopt.ref === adopt.name
                    ? ""
                    : ", following it from here on"}
                </span>
              ) : (
                <span>
                  Git branch <span className="mono">{wanted || "—"}</span>, cut
                  from {source.name}
                </span>
              )}
              {adopt && !branchFailure && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setAdopt(undefined);
                    setBranch("");
                  }}
                  disabled={creating}
                >
                  Cut a new branch instead
                </button>
              )}
            </p>
            {/* Present from the start, holding its place: a preview that appears
            on the first keystroke moves everything under it. */}
            <div
              className="destination"
              data-empty={!preview?.url || undefined}
            >
              <span className="micro">Plot URL</span>
              <strong className="mono">{preview?.url ?? "—"}</strong>
            </div>
            {preview?.advice && (
              <div className="routing-setup">
                <p className="dialog-error">{preview.advice}</p>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={setupNamedRouting}
                  disabled={creating || settingUpRouting}
                >
                  <Terminal size={12} />
                  {settingUpRouting ? "Waiting for setup…" : "Set up HTTPS"}
                </button>
              </div>
            )}
            {steps.length > 0 && (
              <ProgressSteps steps={steps} settled={!creating} />
            )}
            {previewFailure && (
              <div className="routing-setup">
                <p className="dialog-error">{previewFailure}</p>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
                  disabled={creating}
                >
                  <RefreshCw size={12} />
                  Retry URL check
                </button>
              </div>
            )}
            {failure && !branchFailure && (
              <p className="dialog-error">{failure}</p>
            )}
          </div>
          <div className="plot-column">
            {sources.length > 1 && (
              <label className="dialog-field">
                <span className="micro">Branch from</span>
                <select
                  className="dialog-select"
                  value={source.workspaceId}
                  onChange={(event) => setSourceId(event.target.value)}
                  // A branch that exists already knows where it starts.
                  disabled={creating || adopt !== undefined}
                >
                  {[...sources]
                    .sort((left, right) =>
                      left.isPrimary === right.isPrimary
                        ? left.name.localeCompare(right.name)
                        : left.isPrimary
                          ? -1
                          : 1,
                    )
                    .map((candidate) => (
                      <option
                        key={candidate.workspaceId}
                        value={candidate.workspaceId}
                      >
                        {candidate.name}
                        {candidate.isPrimary ? " · the project itself" : ""}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <div className="branch-candidates">
              <p className="micro">
                Take up a branch or pull request
                <span className="micro-value">
                  {query === "" || reference
                    ? openable.length
                    : `${candidates.length} of ${openable.length}`}
                </span>
              </p>
              <label className="branch-search">
                <Search size={12} />
                <input
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                  placeholder="Search branches, or paste a pull request"
                  aria-label="Search branches, or paste a pull request"
                  disabled={creating}
                />
              </label>
              {/* Sized by what could be listed, not by what the search has
                  left, so filtering empties the box instead of resizing the
                  dialog under the field being typed in. Two rows at the least,
                  because a pull request can be looked up where no branch is
                  free to be listed. */}
              <div
                className="branch-candidate-list"
                style={{ height: candidateListHeight(openable.length, 2) }}
                aria-label="Matching branches and pull requests"
                aria-live="polite"
                aria-busy={pullRequestLoading}
              >
                {reference && (
                  <PullRequestResult
                    number={reference.number}
                    pullRequest={pullRequest}
                    loading={pullRequestLoading}
                    failure={pullRequestFailure}
                    holder={
                      pullRequest
                        ? sources.find(
                            (candidate) =>
                              candidate.git.branch === pullRequest.headRefName,
                          )?.name
                        : undefined
                    }
                    selected={
                      pullRequest !== undefined &&
                      adopt?.name === pullRequest.headRefName
                    }
                    disabled={creating}
                    onTake={(found) =>
                      takeUp(
                        {
                          ref: branches.includes(found.headRefName)
                            ? found.headRefName
                            : `origin/${found.headRefName}`,
                          name: found.headRefName,
                        },
                        found.number,
                      )
                    }
                  />
                )}
                {candidates.length === 0 && !reference && (
                  <p className="candidates-empty">
                    {openable.length === 0 ? (
                      "Every branch here is already open as a plot."
                    ) : (
                      <>
                        No branch matches <span className="mono">{query}</span>.
                      </>
                    )}
                  </p>
                )}
                {candidates.map((candidate) => (
                  <button
                    key={candidate.ref}
                    type="button"
                    className="branch-candidate"
                    data-selected={adopt?.ref === candidate.ref || undefined}
                    disabled={creating}
                    onClick={() => takeUp(candidate)}
                  >
                    <GitBranch size={11} />
                    <span className="truncate">{candidate.name}</span>
                    {candidate.remote && (
                      <span className="branch-origin mono">
                        {candidate.ref}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <fieldset className="choices" disabled={creating}>
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
          </div>
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onCancel}
            disabled={creating}
          >
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!canStart}>
            {creating ? "Starting…" : "Start plot"}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * What the branch search found when what was typed named a pull request
 * rather than a branch. It says what is there and, when it cannot be taken
 * up, why: a fork's branch is not in this repository, and one that is already
 * checked out belongs to the plot holding it.
 */
function PullRequestResult({
  number,
  pullRequest,
  loading,
  failure,
  holder,
  selected,
  disabled,
  onTake,
}: {
  number: number;
  pullRequest: PullRequestSummary | undefined;
  loading: boolean;
  failure: string | undefined;
  /** The plot already holding the head branch, when one does. */
  holder: string | undefined;
  selected: boolean;
  disabled: boolean;
  onTake(pullRequest: PullRequestSummary): void;
}) {
  if (loading) {
    return <p className="candidates-empty">Looking up #{number}…</p>;
  }
  if (failure) return <p className="candidates-empty">{failure}</p>;
  if (!pullRequest) return null;
  const refusal = pullRequest.headRepository
    ? `Its branch lives in ${pullRequest.headRepository}, not here`
    : pullRequest.headGone
      ? `Its branch ${pullRequest.headRefName} is gone from GitHub`
      : holder
        ? `Already open as ${holder}`
        : undefined;
  return (
    <button
      type="button"
      className="branch-candidate pull-request-candidate"
      data-selected={selected || undefined}
      disabled={disabled || refusal !== undefined}
      onClick={() => onTake(pullRequest)}
    >
      <GitPullRequest size={12} />
      <span className="pull-request-lines">
        <span className="pull-request-headline">
          <span className="mono">#{pullRequest.number}</span>
          <span className="truncate">{pullRequest.title}</span>
        </span>
        <small className="truncate">
          {refusal ??
            `${pullRequestWord(pullRequest)} · ${pullRequest.headRefName}`}
        </small>
      </span>
    </button>
  );
}

function pullRequestWord(pullRequest: PullRequestSummary): string {
  if (pullRequest.state === "merged") return "Merged";
  if (pullRequest.state === "closed") return "Closed";
  return pullRequest.draft ? "Draft" : "Open";
}

function PlotOnlineStatus({
  result,
}: {
  result: Pick<PlotCreationResult, "runtime" | "readiness">;
}) {
  return (
    <>
      <div className="ready-section">
        <p className="micro">
          Runtimes
          <span className="micro-value">
            {result.runtime.status === "started"
              ? `Started in ${secondsLabel(result.runtime.durationMs)}`
              : result.runtime.status === "failed"
                ? "Startup failed"
                : "Not started"}
          </span>
        </p>
        {result.runtime.detail && (
          <p
            className={
              result.runtime.status === "failed"
                ? "dialog-error"
                : "dialog-copy"
            }
          >
            {result.runtime.detail}
          </p>
        )}
      </div>
      <div className="ready-section">
        <p className="micro">
          Preview
          <span className="micro-value">
            {result.readiness.status === "ready"
              ? `Live after ${secondsLabel(result.readiness.durationMs)}`
              : result.readiness.status === "failed"
                ? "Did not respond"
                : "No auto-starting web command"}
          </span>
        </p>
        {result.readiness.detail && (
          <p
            className={
              result.readiness.status === "failed"
                ? "dialog-error"
                : "dialog-copy"
            }
          >
            {result.readiness.detail}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * A finished run, step by step. Where Silvic recognised a failure it says so in
 * its own words and offers the repair; the tool's output is kept but folded, so
 * the explanation is what you read first.
 */
function ProvisionResults({
  results,
  onRemedy,
}: {
  results: readonly ProvisionResult[];
  onRemedy?: (remedy: ProvisionRemedyId) => void;
}) {
  return (
    <ol className="provision-steps">
      {results.map((step) => {
        const remedy = step.remedy;
        return (
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
            {step.advice && <p className="step-advice">{step.advice}</p>}
            {remedy && onRemedy && (
              <button
                type="button"
                className="ghost-button remedy-button"
                onClick={() => onRemedy(remedy.id)}
              >
                {remedy.label}
              </button>
            )}
            {step.exitCode !== 0 &&
              step.output &&
              // Once Silvic has named the cause, the tool's own words are
              // corroboration rather than the headline, so they fold away.
              (step.advice ? (
                <details className="step-output">
                  <summary>What the command printed</summary>
                  <pre className="patch mono">{step.output}</pre>
                </details>
              ) : (
                <pre className="patch mono">{step.output}</pre>
              ))}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Explicit hand-off from discovery to a runnable Plot. The preview is loaded
 * from the main process, so routes and provider warnings shown here are the
 * same values the run is required to use.
 */
function AdoptionDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceSnapshot;
  onClose(): void;
}) {
  const [scope, setScope] = useState<"single" | "family">("family");
  const [plan, setPlan] = useState<PlotAdoptionPlan>();
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlotAdoptionRunResult>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let current = true;
    setPlan(undefined);
    setFailure(undefined);
    setConfirmed(false);
    void window.silvic
      .planPlotAdoption({ workspaceId: workspace.workspaceId, scope })
      .then((next) => {
        if (current) setPlan(next);
      })
      .catch((error: unknown) => {
        if (current) setFailure(failureMessage(error));
      });
    return () => {
      current = false;
    };
  }, [workspace.workspaceId, scope]);

  const run = () => {
    if (!plan || running) return;
    setRunning(true);
    setFailure(undefined);
    setResult(undefined);
    void window.silvic
      .adoptPlots({
        workspaceId: workspace.workspaceId,
        scope,
        confirmProviderChanges: confirmed,
      })
      .then(setResult)
      .catch((error: unknown) => setFailure(failureMessage(error)))
      .finally(() => setRunning(false));
  };

  const blocked =
    !plan || (plan.requiresProviderConfirmation && !confirmed) || running;
  useKeyLayer({
    dismiss: running ? undefined : onClose,
    confirm: blocked ? undefined : run,
  });

  return (
    <div className="scrim" onMouseDown={running ? undefined : onClose}>
      <section
        className="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="micro">External worktree adoption</p>
        <h2>{workspace.name}</h2>
        <p className="dialog-copy">
          Silvic will keep these worktrees where they are, claim stable routes,
          run the repository recipe, and start configured runtimes. Completed
          members are skipped on retry.
        </p>

        <div className="segmented" aria-label="Adoption scope">
          <button
            type="button"
            data-active={scope === "single" || undefined}
            onClick={() => setScope("single")}
            disabled={running}
          >
            This plot
          </button>
          <button
            type="button"
            data-active={scope === "family" || undefined}
            onClick={() => setScope("family")}
            disabled={running}
          >
            Stack / family
          </button>
        </div>

        {plan && (
          <>
            <ol className="provision-steps">
              {plan.members.map((member) => {
                const outcome = result?.members.find(
                  (item) => item.workspaceId === member.workspaceId,
                );
                return (
                  <li
                    key={member.workspaceId}
                    data-status={
                      outcome?.status === "failed"
                        ? "failed"
                        : outcome
                          ? "done"
                          : "pending"
                    }
                  >
                    <div className="provision-head">
                      <strong>{member.name}</strong>
                      <span className="mono">
                        {outcome?.status === "already-adopted"
                          ? "already adopted"
                          : (outcome?.status ?? member.status)}
                      </span>
                    </div>
                    <code className="mono">{member.url}</code>
                    {outcome?.error && (
                      <p className="step-advice">{outcome.error}</p>
                    )}
                  </li>
                );
              })}
            </ol>
            <div className="dialog-copy">
              <strong>Recipe preview</strong>
              {plan.steps.length === 0 ? (
                <p>
                  No provisioning steps; configured runtimes will still start.
                </p>
              ) : (
                <ul>
                  {plan.steps.map((step, index) => (
                    <li key={`${step.label}-${index}`}>
                      {step.label}
                      {step.providerChanging ? " · may change a provider" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {plan.requiresProviderConfirmation && (
              <div className="checks">
                <label>
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={running}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    I confirm these steps may create deployments or scoped keys,
                    sync environment variables, push code, or make other
                    persistent provider changes.
                  </span>
                </label>
              </div>
            )}
          </>
        )}
        {running && (
          <p className="dialog-copy">Adopting members in lineage order…</p>
        )}
        {failure && <p className="dialog-error">{failure}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            disabled={running}
          >
            Close
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={run}
            disabled={blocked}
          >
            {running
              ? "Adopting…"
              : result
                ? "Retry unfinished"
                : `Adopt ${plan?.members.length ?? ""} plot${plan?.members.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * Provisioning an existing plot: what the last run did, and the means to run it
 * again. A recipe that failed halfway is a state a plot can sit in for days, so
 * it has to be inspectable and repeatable outside the dialog that created it.
 */
function ProvisionDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceSnapshot;
  onClose(): void;
}) {
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<readonly PlotProgressStep[]>([]);
  const [results, setResults] = useState<readonly ProvisionResult[]>(
    workspace.provisioning?.steps ?? [],
  );
  const [online, setOnline] = useState<PlotProvisionRunResult>();
  const [failure, setFailure] = useState<string>();

  useEffect(
    () =>
      window.silvic.onPlotProgress((progress) => {
        if (progress.branch === workspace.branch) setSteps(progress.steps);
      }),
    [workspace.branch],
  );

  const run = (remedy?: ProvisionRemedyId) => {
    setFailure(undefined);
    setSteps([]);
    setOnline(undefined);
    setRunning(true);
    void window.silvic
      .provisionPlot({ path: workspace.path, ...(remedy ? { remedy } : {}) })
      .then((result) => {
        setResults(result.provision);
        setOnline(result);
      })
      .catch((error: unknown) => setFailure(failureMessage(error)))
      .finally(() => setRunning(false));
  };

  const failed = results.find((step) => step.exitCode !== 0);

  useKeyLayer({
    dismiss: running ? undefined : onClose,
    confirm: running ? undefined : () => run(),
  });

  return (
    <div className="scrim" onMouseDown={running ? undefined : onClose}>
      <section
        className="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="micro">
          {running
            ? "Provisioning"
            : failed
              ? "Provisioning failed"
              : online?.runtime.status === "failed"
                ? "Runtime failed"
                : online?.readiness.status === "failed"
                  ? "Preview unavailable"
                  : "Provisioning"}
        </p>
        <h2>{workspace.name}</h2>
        <p className="dialog-copy">
          {running
            ? "Running the steps this repository declares, in the plot."
            : results.length === 0
              ? "Nothing is recorded for this plot. Running the recipe again is safe: its steps are meant to be repeatable. A Convex step may create a dev deployment and scoped deploy key, sync environment variables, and push code."
              : "The last run of this repository's recipe is shown here. “Provision again” confirms repeating its provider changes, including any deployment, scoped key, environment sync, and code push."}
        </p>
        {running ? (
          <ProgressSteps steps={steps} settled={!running} />
        ) : (
          results.length > 0 && (
            <ProvisionResults results={results} onRemedy={(id) => run(id)} />
          )
        )}
        {!running && online && <PlotOnlineStatus result={online} />}
        {failure && <p className="dialog-error">{failure}</p>}
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={onClose}
            disabled={running}
          >
            Close
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => run()}
            disabled={running}
          >
            {running ? "Provisioning…" : "Provision again"}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * What the main process is doing right now. Every step is listed from the
 * start, including the ones still to come, so a long provisioning run reads as
 * progress through a known plan rather than an interface that has stopped.
 */
function ProgressSteps({
  steps,
  settled,
}: {
  steps: readonly PlotProgressStep[];
  /** The run has ended, so nothing still pending is going to happen. */
  settled?: boolean;
}) {
  return (
    <ol className="provision-steps live" data-settled={settled || undefined}>
      {steps.map((step) => (
        <li key={step.id} data-status={step.status}>
          <div className="provision-head">
            <strong>{step.label}</strong>
            <span className="mono">{stepStatusLabel(step, settled)}</span>
          </div>
          {step.detail && <code className="mono">{step.detail}</code>}
        </li>
      ))}
    </ol>
  );
}

function stepStatusLabel(step: PlotProgressStep, settled?: boolean): string {
  // Once the run is over, a step that never started never will. Saying
  // "waiting" then describes an intention nothing holds.
  if (step.status === "pending") return settled ? "not run" : "waiting";
  if (step.status === "running") return settled ? "stopped" : "running";
  if (step.status === "failed") return "failed";
  return step.durationMs === undefined
    ? "done"
    : `${Math.round(step.durationMs / 100) / 10}s`;
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
      .catch((error) => setFailure(failureMessage(error)));
  }, [workspace.path]);

  const generate = async () => {
    setWorking(true);
    setFailure(undefined);
    try {
      setDraft(await window.silvic.draftDelivery({ path: workspace.path }));
    } catch (error) {
      setFailure(failureMessage(error));
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
      setFailure(failureMessage(error));
      setWorking(false);
    }
  };

  const ready =
    !working && changes !== undefined && draft.commitMessage.trim().length > 0;
  useKeyLayer({
    dismiss: onClose,
    confirm: ready ? () => void execute() : undefined,
  });

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
            disabled={!ready}
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
      <p>
        Choose a repository, or a folder containing the projects you work on.
      </p>
      {!loading && (
        <button type="button" className="primary-button" onClick={onAdd}>
          <Plus size={13} /> Add projects
        </button>
      )}
    </div>
  );
}
