import { contextBridge, ipcRenderer } from "electron";

import {
  ipcChannels,
  type AppearancePreference,
  type CreateEnvironmentRequest,
  type DeliveryExecuteRequest,
  type HarnessId,
  type OpenLinkRequest,
  type OpenWorkspaceRequest,
  type ProjectActivationRequest,
  type RecipeSaveRequest,
  type PlotPreviewRequest,
  type PlotProgress,
  type PlotRepairRequest,
  type TestStepRequest,
  type TeardownRequestPayload,
  type SilvicDesktopApi,
  type SilvicSnapshot,
} from "@silvic/contracts";

const api: SilvicDesktopApi = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshotGet),
  getRoots: () => ipcRenderer.invoke(ipcChannels.rootsGet),
  addRoot: () => ipcRenderer.invoke(ipcChannels.rootsAdd),
  removeRoot: (root) => ipcRenderer.invoke(ipcChannels.rootsRemove, root),
  refresh: () => ipcRenderer.invoke(ipcChannels.snapshotRefresh),
  createEnvironment: (request: CreateEnvironmentRequest) =>
    ipcRenderer.invoke(ipcChannels.environmentCreate, request),
  repairPlot: (request: PlotRepairRequest) =>
    ipcRenderer.invoke(ipcChannels.plotRepair, request),
  getChanges: (request) => ipcRenderer.invoke(ipcChannels.changesGet, request),
  draftDelivery: (request) =>
    ipcRenderer.invoke(ipcChannels.deliveryDraft, request),
  executeDelivery: (request: DeliveryExecuteRequest) =>
    ipcRenderer.invoke(ipcChannels.deliveryExecute, request),
  connectGitHub: () => ipcRenderer.invoke(ipcChannels.githubConnect),
  openWorkspace: (request: OpenWorkspaceRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceOpen, request),
  openLink: (request: OpenLinkRequest) =>
    ipcRenderer.invoke(ipcChannels.linkOpen, request),
  getAppearance: () => ipcRenderer.invoke(ipcChannels.appearanceGet),
  setAppearance: (preference: AppearancePreference) =>
    ipcRenderer.invoke(ipcChannels.appearanceSet, preference),
  getActiveProjects: () => ipcRenderer.invoke(ipcChannels.projectsActiveGet),
  setProjectActive: (request: ProjectActivationRequest) =>
    ipcRenderer.invoke(ipcChannels.projectsActiveSet, request),
  copyText: (text: string) =>
    ipcRenderer.invoke(ipcChannels.clipboardWrite, text),
  inspectProject: (projectId: string) =>
    ipcRenderer.invoke(ipcChannels.projectInspect, projectId),
  getDefaultHarness: () => ipcRenderer.invoke(ipcChannels.defaultHarnessGet),
  setDefaultHarness: (id: HarnessId) =>
    ipcRenderer.invoke(ipcChannels.defaultHarnessSet, id),
  previewPlot: (request: PlotPreviewRequest) =>
    ipcRenderer.invoke(ipcChannels.plotPreview, request),
  testProvisionStep: (request: TestStepRequest) =>
    ipcRenderer.invoke(ipcChannels.stepTest, request),
  planTeardown: (request: TeardownRequestPayload) =>
    ipcRenderer.invoke(ipcChannels.teardownPlan, request),
  runTeardown: (request: TeardownRequestPayload) =>
    ipcRenderer.invoke(ipcChannels.teardownRun, request),
  getRecipe: (projectId: string) =>
    ipcRenderer.invoke(ipcChannels.recipeGet, projectId),
  saveRecipe: (request: RecipeSaveRequest) =>
    ipcRenderer.invoke(ipcChannels.recipeSave, request),
  onSnapshot: (listener: (snapshot: SilvicSnapshot) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: SilvicSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(ipcChannels.snapshotChanged, handler);
    return () =>
      ipcRenderer.removeListener(ipcChannels.snapshotChanged, handler);
  },
  onPlotProgress: (listener: (progress: PlotProgress) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: PlotProgress,
    ) => listener(progress);
    ipcRenderer.on(ipcChannels.plotProgress, handler);
    return () => ipcRenderer.removeListener(ipcChannels.plotProgress, handler);
  },
};

contextBridge.exposeInMainWorld("silvic", api);
