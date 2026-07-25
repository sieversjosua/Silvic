import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronDown,
  Cloud,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Plus,
  RefreshCw,
  Search,
  Terminal,
  TreePine,
  X,
} from "lucide-react";

import type {
  DeliveryDraft,
  HarnessDefinition,
  WorkspaceChanges,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { Grove } from "./Grove";
import { useSilvic } from "./store";

export function App() {
  const {
    snapshot,
    roots,
    selectedProjectId,
    selectedWorkspaceId,
    loading,
    error,
    initialize,
    refresh,
    addRoot,
    createEnvironment,
    selectProject,
    selectWorkspace,
  } = useSilvic();
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState(false);
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

  const project =
    snapshot.projects.find((candidate) => candidate.id === selectedProjectId) ??
    snapshot.projects[0];
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
    <main className="app-shell">
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand">
          <div className="brand-mark">
            <TreePine size={17} />
          </div>
          <div>
            <strong>Silvic</strong>
            <span>Parallel work, grounded.</span>
          </div>
        </div>
        <div className="section-label">
          <span>Projects</span>
          <button
            type="button"
            aria-label="Add project"
            onClick={() => void addRoot()}
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="project-list">
          {snapshot.projects.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              className={candidate.id === project?.id ? "active" : ""}
              onClick={() => selectProject(candidate.id)}
            >
              <FolderGit2 size={15} />
              <span>{candidate.name}</span>
              <small>{candidate.workspaces.length}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            type="button"
            className="location-button"
            onClick={() => void addRoot()}
          >
            <Plus size={14} />
            Add location
          </button>
          <span>
            {roots.length} watched location{roots.length === 1 ? "" : "s"}
          </span>
        </div>
      </aside>

      <section className="project-room">
        {project ? (
          <>
            <header className="project-header">
              <div>
                <p className="eyebrow">Project</p>
                <h1>{project.name}</h1>
                <p className="project-meta">
                  {project.workspaces.length} environment
                  {project.workspaces.length === 1 ? "" : "s"}
                  <span />
                  {project.origin ?? project.rootPath}
                </p>
              </div>
              <div className="header-actions">
                <label className="search-field">
                  <Search size={14} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Find in project"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery("")}>
                      <X size={12} />
                    </button>
                  )}
                </label>
                <button
                  type="button"
                  className="refresh-button"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  <RefreshCw size={14} className={loading ? "spinning" : ""} />
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => setShowEnvironment(true)}
                >
                  <Plus size={14} /> New environment
                </button>
              </div>
            </header>
            <Grove
              project={project}
              query={query}
              selectedWorkspaceId={workspace?.workspaceId}
              onSelect={selectWorkspace}
              onOpen={openWorkspace}
            />
            {snapshot.connectorFailures.length > 0 && (
              <div className="connector-notice">
                <span>
                  {snapshot.connectorFailures.length} optional connector
                  {snapshot.connectorFailures.length === 1 ? "" : "s"}{" "}
                  unavailable
                </span>
                {snapshot.connectorFailures.some(
                  (failure) => failure.connectorId === "github",
                ) && (
                  <button
                    type="button"
                    onClick={() => void window.silvic.connectGitHub()}
                  >
                    Connect GitHub in browser
                  </button>
                )}
              </div>
            )}
          </>
        ) : (
          <EmptyState onAdd={() => void addRoot()} loading={loading} />
        )}
      </section>

      <aside className="inspector">
        {workspace ? (
          <WorkspaceInspector
            workspace={workspace}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
            onOpen={openWorkspace}
            onShip={() => setDeliveryWorkspace(workspace)}
          />
        ) : (
          <div className="inspector-empty">Select a Workspace</div>
        )}
      </aside>

      {error && <div className="error-toast">{error}</div>}
      {showEnvironment && project && (
        <NewEnvironmentDialog
          projectName={project.name}
          projectRoot={project.rootPath}
          source={workspace ?? project.workspaces[0]}
          loading={loading}
          onCancel={() => setShowEnvironment(false)}
          onCreate={async (request) => {
            await createEnvironment(request);
            setShowEnvironment(false);
          }}
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

function NewEnvironmentDialog({
  projectName,
  projectRoot,
  source,
  loading,
  onCancel,
  onCreate,
}: {
  projectName: string;
  projectRoot: string;
  source: WorkspaceSnapshot | undefined;
  loading: boolean;
  onCancel(): void;
  onCreate(request: {
    sourcePath: string;
    destinationPath: string;
    branch: string;
    mode: "worktree" | "clone";
  }): Promise<void>;
}) {
  const [branch, setBranch] = useState("");
  const [mode, setMode] = useState<"worktree" | "clone">("worktree");
  const safeBranch = branch
    .trim()
    .replaceAll("/", "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const destinationPath = `${projectRoot.slice(0, projectRoot.lastIndexOf("/"))}/${projectName}-${safeBranch}`;

  if (!source) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="environment-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!branch.trim() || !safeBranch) return;
          void onCreate({
            sourcePath: source.path,
            destinationPath,
            branch: branch.trim(),
            mode,
          });
        }}
      >
        <p className="eyebrow">New environment</p>
        <h2>Branch from {source.name}</h2>
        <p className="dialog-copy">
          Create a ready-to-open workspace next to the primary checkout.
        </p>
        <label className="dialog-field">
          <span>Branch</span>
          <input
            autoFocus
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder="feature/agent-task"
          />
        </label>
        <fieldset className="mode-picker">
          <legend>Storage</legend>
          <label className={mode === "worktree" ? "selected" : ""}>
            <input
              type="radio"
              name="mode"
              checked={mode === "worktree"}
              onChange={() => setMode("worktree")}
            />
            <strong>Linked worktree</strong>
            <span>Fast and space-efficient</span>
          </label>
          <label className={mode === "clone" ? "selected" : ""}>
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
        {safeBranch && <p className="destination-preview">{destinationPath}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={loading || !safeBranch}
          >
            {loading ? "Creating…" : "Create environment"}
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
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="environment-dialog delivery-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">Confirmed delivery</p>
        <h2>Review &amp; ship {workspace.name}</h2>
        <pre className="change-preview">
          {changes
            ? changes.patch ||
              "No uncommitted changes; existing commits can be pushed."
            : "Loading changes…"}
        </pre>
        {changes?.warnings.map((warning) => (
          <p className="review-warning" key={warning}>
            {warning}
          </p>
        ))}
        <label className="dialog-field">
          <span>Commit message</span>
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
          className="ai-draft-button"
          onClick={() => void generate()}
          disabled={working || !changes?.status.trim()}
        >
          <Bot size={13} /> Draft with Codex
        </button>
        <div className="delivery-options">
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
              <span>Pull request title</span>
              <input
                value={draft.pullRequestTitle}
                onChange={(event) =>
                  setDraft({ ...draft, pullRequestTitle: event.target.value })
                }
              />
            </label>
            <label className="dialog-field">
              <span>Pull request body</span>
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
          <button type="button" onClick={onClose}>
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

function WorkspaceInspector({
  workspace,
  openMenu,
  setOpenMenu,
  onOpen,
  onShip,
}: {
  workspace: WorkspaceSnapshot;
  openMenu: boolean;
  setOpenMenu(value: boolean): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onShip(): void;
}) {
  const changes =
    workspace.git.staged +
    workspace.git.unstaged +
    workspace.git.untracked +
    workspace.git.conflicted;
  const grouped = useMemo(
    () =>
      Map.groupBy(workspace.observations, (observation) => observation.kind),
    [workspace.observations],
  );

  return (
    <>
      <div className="inspector-heading">
        <p className="eyebrow">
          {workspace.isPrimary ? "Primary checkout" : "Workspace"}
        </p>
        <h2>{workspace.name}</h2>
        <p>
          <GitBranch size={13} /> {workspace.branch}
        </p>
        <div className="open-control">
          <button
            type="button"
            onClick={() => void onOpen(workspace.path, "codex")}
          >
            <Bot size={14} /> Open in Codex
          </button>
          <button type="button" onClick={() => setOpenMenu(!openMenu)}>
            <ChevronDown size={14} />
          </button>
          {openMenu && (
            <div className="open-menu">
              {(
                [
                  ["claude", "Claude Code"],
                  ["t3-code", "T3 Code"],
                  ["opencode", "OpenCode"],
                  ["terminal", "Terminal"],
                  ["finder", "Finder"],
                ] as const
              ).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => {
                    setOpenMenu(false);
                    void onOpen(workspace.path, id);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="inspector-scroll">
        <InspectorSection icon={<GitBranch />} title="Code">
          <Fact
            label="Working tree"
            value={changes === 0 ? "Clean" : `${changes} changes`}
          />
          <Fact
            label="Upstream"
            value={workspace.git.upstream ?? "Not configured"}
          />
          <Fact
            label="Sync"
            value={`↑ ${workspace.git.ahead}  ↓ ${workspace.git.behind}`}
          />
          <Fact
            label="Revision"
            value={workspace.git.revision?.slice(0, 9) ?? "Unknown"}
            mono
          />
          {(changes > 0 || workspace.git.ahead > 0) && (
            <button type="button" className="ship-button" onClick={onShip}>
              Review &amp; ship
            </button>
          )}
        </InspectorSection>
        <ObservationSection
          icon={<Terminal />}
          title="Runtime"
          observations={grouped.get("runtime") ?? []}
          empty="No local runtime detected"
        />
        <ObservationSection
          icon={<Cloud />}
          title="Environment"
          observations={grouped.get("deployment") ?? []}
          empty="No environment attached"
        />
        <ObservationSection
          icon={<GitPullRequest />}
          title="Review"
          observations={grouped.get("review") ?? []}
          empty="No pull request"
        />
        <ObservationSection
          icon={<Bot />}
          title="Sessions"
          observations={grouped.get("session") ?? []}
          empty="No active agent session"
        />
        <p className="workspace-path">{workspace.path}</p>
      </div>
    </>
  );
}

function InspectorSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3>
        {icon} {title}
      </h3>
      {children}
    </section>
  );
}

function ObservationSection({
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
    <InspectorSection icon={icon} title={title}>
      {observations.length === 0 ? (
        <p className="empty-copy">{empty}</p>
      ) : (
        observations.map((observation) => (
          <div
            className="observation"
            key={`${observation.connectorId}:${observation.kind}`}
          >
            <span className={`state-dot ${observation.state}`} />
            <div>
              <strong>{observation.label}</strong>
              {observation.detail && <span>{observation.detail}</span>}
            </div>
          </div>
        ))
      )}
    </InspectorSection>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong className={mono ? "mono" : ""}>{value}</strong>
    </div>
  );
}

function EmptyState({ onAdd, loading }: { onAdd(): void; loading: boolean }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <TreePine size={26} />
      </div>
      <h1>{loading ? "Finding your projects…" : "Start with a project"}</h1>
      <p>
        Choose a repository or a folder containing the projects you work on.
      </p>
      {!loading && (
        <button type="button" className="primary-button" onClick={onAdd}>
          <Plus size={14} /> Add projects
        </button>
      )}
    </div>
  );
}
