import { create } from "zustand";

import type {
  CreateEnvironmentRequest,
  SilvicSnapshot,
} from "@silvic/contracts";

interface SilvicState {
  snapshot: SilvicSnapshot;
  roots: readonly string[];
  selectedProjectId: string | undefined;
  selectedWorkspaceId: string | undefined;
  loading: boolean;
  error: string | undefined;
  initialize(): Promise<() => void>;
  refresh(): Promise<void>;
  addRoot(): Promise<void>;
  createEnvironment(request: CreateEnvironmentRequest): Promise<void>;
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
  selectedProjectId: undefined,
  selectedWorkspaceId: undefined,
  loading: true,
  error: undefined,
  initialize: async () => {
    try {
      const [snapshot, roots] = await Promise.all([
        window.silvic.getSnapshot(),
        window.silvic.getRoots(),
      ]);
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
      set({ roots });
    } catch (error) {
      set({ error: message(error) });
    }
  },
  createEnvironment: async (request) => {
    set({ loading: true, error: undefined });
    try {
      const snapshot = await window.silvic.createEnvironment(request);
      setSelectionForSnapshot(set, get, snapshot);
      const created = snapshot.projects
        .flatMap((project) => project.workspaces)
        .find((workspace) => workspace.path === request.destinationPath);
      set({
        snapshot,
        selectedWorkspaceId: created?.workspaceId ?? get().selectedWorkspaceId,
        loading: false,
      });
    } catch (error) {
      set({ error: message(error), loading: false });
      throw error;
    }
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
  const selectedProject =
    snapshot.projects.find(
      (project) => project.id === state.selectedProjectId,
    ) ?? snapshot.projects[0];
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
  return error instanceof Error ? error.message : String(error);
}
