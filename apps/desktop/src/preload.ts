import { contextBridge, ipcRenderer } from "electron";

import {
  ipcChannels,
  type AppearancePreference,
  type CreateEnvironmentRequest,
  type DeliveryExecuteRequest,
  type OpenLinkRequest,
  type OpenWorkspaceRequest,
  type ProjectActivationRequest,
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
  getHarnessIcons: () => ipcRenderer.invoke(ipcChannels.harnessIconsGet),
  onSnapshot: (listener: (snapshot: SilvicSnapshot) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: SilvicSnapshot,
    ) => listener(snapshot);
    ipcRenderer.on(ipcChannels.snapshotChanged, handler);
    return () =>
      ipcRenderer.removeListener(ipcChannels.snapshotChanged, handler);
  },
};

contextBridge.exposeInMainWorld("silvic", api);
