import { contextBridge, ipcRenderer } from "electron";

import {
  ipcChannels,
  type AppUpdateState,
  type AppearancePreference,
  type CreateEnvironmentRequest,
  type DeliveryExecuteRequest,
  type HarnessId,
  type IssueListRequest,
  type OpenLinkRequest,
  type OpenWorkspaceRequest,
  type ProjectActivationRequest,
  type PullRequestLookupRequest,
  type RecipeSaveRequest,
  type PlotPreviewRequest,
  type PlotRenameRequest,
  type PlotCommandRequest,
  type PlotProcess,
  type PlotProgress,
  type PlotProvisionRequest,
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
  refreshObservations: () =>
    ipcRenderer.invoke(ipcChannels.observationsRefresh),
  setRendererVisible: (visible) =>
    ipcRenderer.invoke(ipcChannels.rendererVisibilitySet, visible),
  createEnvironment: (request: CreateEnvironmentRequest) =>
    ipcRenderer.invoke(ipcChannels.environmentCreate, request),
  provisionPlot: (request: PlotProvisionRequest) =>
    ipcRenderer.invoke(ipcChannels.plotProvision, request),
  getPlotProcesses: () => ipcRenderer.invoke(ipcChannels.plotCommandsGet),
  getKeepCommandsRunning: () => ipcRenderer.invoke(ipcChannels.keepRunningGet),
  setKeepCommandsRunning: (keep: boolean) =>
    ipcRenderer.invoke(ipcChannels.keepRunningSet, keep),
  startPlotCommand: (request: PlotCommandRequest) =>
    ipcRenderer.invoke(ipcChannels.plotCommandStart, request),
  stopPlotCommand: (request: PlotCommandRequest) =>
    ipcRenderer.invoke(ipcChannels.plotCommandStop, request),
  readPlotCommandOutput: (request: PlotCommandRequest) =>
    ipcRenderer.invoke(ipcChannels.plotCommandOutput, request),
  onPlotProcesses: (listener: (processes: readonly PlotProcess[]) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      processes: readonly PlotProcess[],
    ) => listener(processes);
    ipcRenderer.on(ipcChannels.plotCommandsChanged, handler);
    return () =>
      ipcRenderer.removeListener(ipcChannels.plotCommandsChanged, handler);
  },
  getChanges: (request) => ipcRenderer.invoke(ipcChannels.changesGet, request),
  draftDelivery: (request) =>
    ipcRenderer.invoke(ipcChannels.deliveryDraft, request),
  executeDelivery: (request: DeliveryExecuteRequest) =>
    ipcRenderer.invoke(ipcChannels.deliveryExecute, request),
  connectGitHub: () => ipcRenderer.invoke(ipcChannels.githubConnect),
  listIssues: (request: IssueListRequest) =>
    ipcRenderer.invoke(ipcChannels.issuesList, request),
  findPullRequest: (request: PullRequestLookupRequest) =>
    ipcRenderer.invoke(ipcChannels.pullRequestFind, request),
  openWorkspace: (request: OpenWorkspaceRequest) =>
    ipcRenderer.invoke(ipcChannels.workspaceOpen, request),
  openLink: (request: OpenLinkRequest) =>
    ipcRenderer.invoke(ipcChannels.linkOpen, request),
  getAppearance: () => ipcRenderer.invoke(ipcChannels.appearanceGet),
  setAppearance: (preference: AppearancePreference) =>
    ipcRenderer.invoke(ipcChannels.appearanceSet, preference),
  getUpdateState: () => ipcRenderer.invoke(ipcChannels.updateStateGet),
  checkForUpdates: () => ipcRenderer.invoke(ipcChannels.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(ipcChannels.updateDownload),
  moveToApplications: () =>
    ipcRenderer.invoke(ipcChannels.updateMoveToApplications),
  installUpdate: () => ipcRenderer.invoke(ipcChannels.updateInstall),
  onUpdateState: (listener: (state: AppUpdateState) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: AppUpdateState,
    ) => listener(state);
    ipcRenderer.on(ipcChannels.updateStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(ipcChannels.updateStateChanged, handler);
  },
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
  renamePlot: (request: PlotRenameRequest) =>
    ipcRenderer.invoke(ipcChannels.plotRename, request),
  setupNamedRouting: () => ipcRenderer.invoke(ipcChannels.namedRoutingSetup),
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
