import { create } from "zustand";

import { failureMessage } from "./errors";

import type {
  CreateEnvironmentRequest,
  HarnessId,
  PlotCreationResult,
  SilvicSnapshot,
} from "@silvic/contracts";

interface SilvicState {
  snapshot: SilvicSnapshot;
  roots: readonly string[];
  activeProjectIds: readonly string[];
  defaultHarness: HarnessId;
  selectedProjectId: string | undefined;
  selectedWorkspaceId: string | undefined;
  loading: boolean;
  error: string | undefined;
  initialize(): Promise<() => void>;
  refresh(): Promise<void>;
  addRoot(): Promise<void>;
  setProjectActive(projectId: string, active: boolean): Promise<void>;
  setDefaultHarness(id: HarnessId): Promise<void>;
  createEnvironment(request: CreateEnvironmentRequest): Promise<PlotCreationResult>;
  selectProject(id: string): void;
  selectWorkspace(id: string): void;
}

const emptySnapshot: SilvicSnapshot = {
  projects: [],
  connectorFailures: [],
  refreshedAt: new Date(0).toISOString(),
};

export const useSilvic = create<SilvicState>((set, get) => ({
  snapshot: emptySnapshot,
  roots: [],
  activeProjectIds: [],
  defaultHarness: "codex",
  selectedProjectId: undefined,
  selectedWorkspaceId: undefined,
  loading: true,
  error: undefined,
  initialize: async () => {
    try {
      const [snapshot, roots, activeProjectIds, defaultHarness] =
        await Promise.all([
          window.silvic.getSnapshot(),
          window.silvic.getRoots(),
          window.silvic.getActiveProjects(),
          window.silvic.getDefaultHarness(),
        ]);
      set({ activeProjectIds, defaultHarness });
      setSelectionForSnapshot(set, get, snapshot);
      set({ snapshot, roots, loading: false });
      return window.silvic.onSnapshot((nextSnapshot) => {
        setSelectionForSnapshot(set, get, nextSnapshot);
        set({ snapshot: nextSnapshot, loading: false });
      });
    } catch (error) {
      set({ error: message(error), loading: false });
      return () => undefined;
    }
  },
  refresh: async () => {
    set({ loading: true, error: undefined });
    try {
      const snapshot = await window.silvic.refresh();
      setSelectionForSnapshot(set, get, snapshot);
      set({ snapshot, loading: false });
    } catch (error) {
      set({ error: message(error), loading: false });
    }
  },
  addRoot: async () => {
    try {
      const roots = await window.silvic.addRoot();
      // Choosing a repository directly adopts it, so the activation set and the
      // selection both have to catch up once the picker closes.
      const activeProjectIds = await window.silvic.getActiveProjects();
      set({ roots, activeProjectIds });
      setSelectionForSnapshot(set, get, get().snapshot);
    } catch (error) {
      set({ error: message(error) });
    }
  },
  setProjectActive: async (projectId, active) => {
    try {
      const activeProjectIds = await window.silvic.setProjectActive({
        projectId,
        active,
      });
      set({ activeProjectIds });
      setSelectionForSnapshot(set, get, get().snapshot);
    } catch (error) {
      set({ error: message(error) });
    }
  },
  setDefaultHarness: async (id) => {
    set({ defaultHarness: id });
    try {
      await window.silvic.setDefaultHarness(id);
    } catch (error) {
      set({ error: message(error) });
    }
  },
  /**
   * `loading` belongs to the background survey, which runs on a timer. Creating
   * a plot takes minutes and reports its own progress, so it is the dialog that
   * holds the pending state and shows the failure.
   */
  createEnvironment: async (request) => {
    const result = await window.silvic.createEnvironment(request);
    setSelectionForSnapshot(set, get, result.snapshot);
    const created = result.snapshot.projects
      .flatMap((project) => project.workspaces)
      .find((workspace) => workspace.path === result.plot.path);
    set({
      snapshot: result.snapshot,
      selectedWorkspaceId: created?.workspaceId ?? get().selectedWorkspaceId,
    });
    return result;
  },
  selectProject: (selectedProjectId) => {
    const project = get().snapshot.projects.find(
      (candidate) => candidate.id === selectedProjectId,
    );
    set({
      selectedProjectId,
      selectedWorkspaceId: project?.workspaces[0]?.workspaceId,
    });
  },
  selectWorkspace: (selectedWorkspaceId) => set({ selectedWorkspaceId }),
}));

function setSelectionForSnapshot(
  set: (partial: Partial<SilvicState>) => void,
  get: () => SilvicState,
  snapshot: SilvicSnapshot,
): void {
  const state = get();
  // Only projects the user has added are selectable; suggestions stay inert
  // until they are accepted into the rail.
  const available = snapshot.projects.filter((project) =>
    state.activeProjectIds.includes(project.id),
  );
  const selectedProject =
    available.find((project) => project.id === state.selectedProjectId) ??
    available[0];
  const selectedWorkspace =
    selectedProject?.workspaces.find(
      (workspace) => workspace.workspaceId === state.selectedWorkspaceId,
    ) ?? selectedProject?.workspaces[0];
  set({
    selectedProjectId: selectedProject?.id,
    selectedWorkspaceId: selectedWorkspace?.workspaceId,
  });
}

function message(error: unknown): string {
  return failureMessage(error);
}
