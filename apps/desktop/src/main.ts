import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import Store from "electron-store";

import { convexConnector } from "@silvic/connector-convex";
import { createGitHubConnector } from "@silvic/connector-github";
import { harnessById, harnesses } from "@silvic/connector-harnesses";
import { createLocalContextConnector } from "@silvic/connector-local";
import { createWorkCliConnector } from "@silvic/connector-work-cli";
import {
  appearancePreferenceSchema,
  createEnvironmentRequestSchema,
  deliveryExecuteRequestSchema,
  ipcChannels,
  openLinkRequestSchema,
  openWorkspaceRequestSchema,
  projectActivationRequestSchema,
  workspacePathRequestSchema,
  type AppearancePreference,
  type CreateEnvironmentRequest,
  type HarnessIcons,
  type OpenWorkspaceRequest,
  type SilvicSnapshot,
} from "@silvic/contracts";
import {
  ConnectorRegistry,
  DeliveryService,
  EnvironmentService,
  LocalCommandRunner,
  ProjectService,
  WorkspaceRegistry,
  readWorkCliNames,
  resolvedCommandPath,
  type WorkspaceRecord,
} from "@silvic/core";

interface Settings {
  roots: string[];
  workspaceRecords: WorkspaceRecord[];
  legacyMigrationCompleted: boolean;
  appearance: AppearancePreference;
  activeProjects: string[];
}

/** Matches `--surface-sunk` in the renderer so the first frame never flashes. */
const windowBackground = { light: "#f4f4f1", dark: "#0f1210" } as const;

const runner = new LocalCommandRunner();
const connectors = new ConnectorRegistry([
  createGitHubConnector(runner),
  convexConnector,
  createWorkCliConnector(runner),
  createLocalContextConnector(runner),
]);
const projectService = new ProjectService({ runner, connectors });
const environmentService = new EnvironmentService(runner);
const deliveryService = new DeliveryService(runner);
const workspaceRegistry = new WorkspaceRegistry();
const settings = new Store<Settings>({
  name: "settings",
  defaults: {
    roots: defaultRoots(),
    workspaceRecords: [],
    legacyMigrationCompleted: false,
    appearance: "system",
    activeProjects: [],
  },
});

let mainWindow: BrowserWindow | undefined;
let latestSnapshot: SilvicSnapshot = {
  projects: [],
  connectorFailures: [],
  refreshedAt: new Date(0).toISOString(),
};
let activeRefresh: Promise<SilvicSnapshot> | undefined;
let queuedFreshRefresh: Promise<SilvicSnapshot> | undefined;
let harnessIconCache: HarnessIcons | undefined;

app.setName("Silvic");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    await migrateLegacySettings();
    nativeTheme.themeSource = settings.get("appearance");
    nativeTheme.on("updated", () => {
      mainWindow?.setBackgroundColor(currentWindowBackground());
    });
    registerIpc();
    createWindow();
    await refreshSnapshot();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: currentWindowBackground(),
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl);
  } else {
    void mainWindow.loadFile(
      join(import.meta.dirname, "../renderer/index.html"),
    );
  }
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const target = new URL(url);
    const allowed = developmentUrl
      ? target.origin === new URL(developmentUrl).origin
      : target.href ===
        pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).href;
    if (!allowed) event.preventDefault();
  });
}

function registerIpc(): void {
  ipcMain.handle(ipcChannels.snapshotGet, (event) => {
    assertTrustedSender(event);
    return latestSnapshot;
  });
  ipcMain.handle(ipcChannels.snapshotRefresh, (event) => {
    assertTrustedSender(event);
    return refreshSnapshot();
  });
  ipcMain.handle(ipcChannels.rootsGet, (event) => {
    assertTrustedSender(event);
    return settings.get("roots");
  });
  ipcMain.handle(ipcChannels.rootsAdd, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Add projects to Silvic",
      properties: ["openDirectory", "multiSelections"],
    });
    if (result.canceled) return settings.get("roots");
    const roots = uniquePaths([...settings.get("roots"), ...result.filePaths]);
    settings.set("roots", roots);
    await refreshSnapshot();
    adoptChosenProjects(result.filePaths);
    return roots;
  });
  ipcMain.handle(ipcChannels.rootsRemove, async (event, root: unknown) => {
    assertTrustedSender(event);
    if (typeof root !== "string") throw new Error("Invalid project root");
    const roots = settings
      .get("roots")
      .filter((candidate) => normalize(candidate) !== normalize(root));
    settings.set("roots", roots);
    await refreshSnapshot();
    return roots;
  });
  ipcMain.handle(
    ipcChannels.environmentCreate,
    async (event, request: unknown) => {
      assertTrustedSender(event);
      return createEnvironment(createEnvironmentRequestSchema.parse(request));
    },
  );
  ipcMain.handle(ipcChannels.githubConnect, async (event) => {
    assertTrustedSender(event);
    await openTerminalCommand("gh", ["auth", "login", "--web"]);
  });
  ipcMain.handle(ipcChannels.changesGet, async (event, request: unknown) => {
    assertTrustedSender(event);
    const { path } = workspacePathRequestSchema.parse(request);
    return deliveryService.changes(knownWorkspacePath(path));
  });
  ipcMain.handle(ipcChannels.deliveryDraft, async (event, request: unknown) => {
    assertTrustedSender(event);
    const { path } = workspacePathRequestSchema.parse(request);
    return deliveryService.draft(knownWorkspacePath(path));
  });
  ipcMain.handle(
    ipcChannels.deliveryExecute,
    async (event, request: unknown) => {
      assertTrustedSender(event);
      const parsed = deliveryExecuteRequestSchema.parse(request);
      const result = await deliveryService.execute({
        ...parsed,
        path: knownWorkspacePath(parsed.path),
      });
      await refreshSnapshot(true);
      return result;
    },
  );
  ipcMain.handle(ipcChannels.workspaceOpen, async (event, request: unknown) => {
    assertTrustedSender(event);
    return openWorkspace(openWorkspaceRequestSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.linkOpen, async (event, request: unknown) => {
    assertTrustedSender(event);
    const { url } = openLinkRequestSchema.parse(request);
    await shell.openExternal(knownObservationUrl(url));
  });
  ipcMain.handle(ipcChannels.projectsActiveGet, (event) => {
    assertTrustedSender(event);
    return settings.get("activeProjects");
  });
  ipcMain.handle(ipcChannels.projectsActiveSet, (event, request: unknown) => {
    assertTrustedSender(event);
    const { projectId, active } = projectActivationRequestSchema.parse(request);
    const remaining = settings
      .get("activeProjects")
      .filter((candidate) => candidate !== projectId);
    const next = active ? [...remaining, projectId] : remaining;
    settings.set("activeProjects", next);
    return next;
  });
  ipcMain.handle(ipcChannels.harnessIconsGet, (event) => {
    assertTrustedSender(event);
    return readHarnessIcons();
  });
  ipcMain.handle(ipcChannels.appearanceGet, (event) => {
    assertTrustedSender(event);
    return settings.get("appearance");
  });
  ipcMain.handle(ipcChannels.appearanceSet, (event, preference: unknown) => {
    assertTrustedSender(event);
    const parsed = appearancePreferenceSchema.parse(preference);
    settings.set("appearance", parsed);
    nativeTheme.themeSource = parsed;
    mainWindow?.setBackgroundColor(currentWindowBackground());
    return parsed;
  });
}

/**
 * Picking a folder that is itself a checkout or worktree is an explicit choice,
 * so that Project joins the rail immediately. Picking a folder that merely
 * contains repositories only feeds the suggestion list, which is what keeps the
 * rail from filling up with everything on disk.
 */
function adoptChosenProjects(chosenPaths: readonly string[]): void {
  const chosen = new Set(chosenPaths.map(normalize));
  const adopted = latestSnapshot.projects
    .filter(
      (project) =>
        chosen.has(normalize(project.rootPath)) ||
        project.workspaces.some((workspace) =>
          chosen.has(normalize(workspace.path)),
        ),
    )
    .map((project) => project.id);
  if (adopted.length === 0) return;
  settings.set("activeProjects", [
    ...new Set([...settings.get("activeProjects"), ...adopted]),
  ]);
}

function currentWindowBackground(): string {
  return nativeTheme.shouldUseDarkColors
    ? windowBackground.dark
    : windowBackground.light;
}

/**
 * The real macOS icon for each Harness, read from whichever application bundle
 * is actually installed. Harnesses that only exist as a CLI resolve to nothing
 * and keep their drawn glyph in the interface.
 */
async function readHarnessIcons(): Promise<HarnessIcons> {
  if (harnessIconCache) return harnessIconCache;
  const icons: Record<string, string> = {};
  for (const harness of harnesses) {
    const bundle = applicationBundlePath(harness.id);
    if (!bundle) continue;
    try {
      const icon = await app.getFileIcon(bundle, { size: "normal" });
      if (!icon.isEmpty()) icons[harness.id] = icon.toDataURL();
    } catch {
      // A missing or unreadable bundle simply has no icon.
    }
  }
  harnessIconCache = icons;
  return icons;
}

function applicationBundlePath(id: string): string | undefined {
  if (id === "finder") return "/System/Library/CoreServices/Finder.app";
  const harness = harnessById(id as OpenWorkspaceRequest["target"]);
  const names =
    harness.applicationNames ??
    (harness.applicationName ? [harness.applicationName] : []);
  const directories = [
    "/Applications",
    join(homedir(), "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities",
  ];
  for (const name of names) {
    for (const directory of directories) {
      const candidate = join(directory, `${name}.app`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error("Untrusted Silvic request");
  }
}

async function createEnvironment(
  request: CreateEnvironmentRequest,
): Promise<SilvicSnapshot> {
  const sourcePath = normalize(request.sourcePath);
  const project = latestSnapshot.projects.find((candidate) =>
    candidate.workspaces.some(
      (workspace) => normalize(workspace.path) === sourcePath,
    ),
  );
  const source = project?.workspaces.find(
    (workspace) => normalize(workspace.path) === sourcePath,
  );
  if (!project || !source) throw new Error("Choose a discovered Workspace");

  const destinationPath = join(
    dirname(project.rootPath),
    `${safePathSegment(project.name)}-${safePathSegment(request.branch)}`,
  );
  if (normalize(request.destinationPath) !== normalize(destinationPath)) {
    throw new Error("The environment destination is not valid");
  }

  await environmentService.create({
    sourcePath,
    destinationPath,
    branch: request.branch,
    mode: request.mode,
    ...(project.origin ? { origin: project.origin } : {}),
    ...(source.git.revision ? { startPoint: source.git.revision } : {}),
  });
  if (request.mode === "clone") {
    settings.set(
      "roots",
      uniquePaths([...settings.get("roots"), destinationPath]),
    );
  }
  settings.set("workspaceRecords", [
    ...settings
      .get("workspaceRecords")
      .filter(
        (record) => normalize(record.path) !== normalize(destinationPath),
      ),
    {
      workspaceId: randomUUID(),
      projectId: project.id,
      path: destinationPath,
      branch: request.branch,
      parentWorkspaceId: source.workspaceId,
      displayName: request.branch,
    },
  ]);
  return refreshSnapshot(true);
}

function refreshSnapshot(forceFresh = false): Promise<SilvicSnapshot> {
  if (activeRefresh) {
    if (!forceFresh) return activeRefresh;
    if (!queuedFreshRefresh) {
      queuedFreshRefresh = activeRefresh
        .then(startSnapshotRefresh, startSnapshotRefresh)
        .finally(() => {
          queuedFreshRefresh = undefined;
        });
    }
    return queuedFreshRefresh;
  }
  return startSnapshotRefresh();
}

function startSnapshotRefresh(): Promise<SilvicSnapshot> {
  const refresh = Promise.all([
    projectService.snapshot(settings.get("roots")),
    readWorkCliNames(),
  ])
    .then(([rawSnapshot, workCliNames]) => {
      const reconciled = workspaceRegistry.reconcile(
        rawSnapshot,
        settings.get("workspaceRecords"),
        workCliNames,
      );
      settings.set("workspaceRecords", [...reconciled.records]);
      latestSnapshot = reconciled.snapshot;
      mainWindow?.webContents.send(
        ipcChannels.snapshotChanged,
        reconciled.snapshot,
      );
      return reconciled.snapshot;
    });
  activeRefresh = refresh;
  void refresh.then(
    () => {
      if (activeRefresh === refresh) activeRefresh = undefined;
    },
    () => {
      if (activeRefresh === refresh) activeRefresh = undefined;
    },
  );
  return refresh;
}

async function openWorkspace(request: OpenWorkspaceRequest): Promise<void> {
  const normalizedPath = knownWorkspacePath(request.path);

  const harness = harnessById(request.target);
  if (harness.id === "finder") {
    const error = await shell.openPath(normalizedPath);
    if (error) throw new Error(error);
    return;
  }
  if (harness.kind === "command" && harness.executable) {
    await openTerminalCommand(harness.executable, [], normalizedPath);
    return;
  }
  const applicationNames =
    harness.applicationNames ??
    (harness.applicationName ? [harness.applicationName] : []);
  if (applicationNames.length === 0) {
    throw new Error(`${harness.name} is not configured`);
  }
  let lastError = "";
  for (const applicationName of applicationNames) {
    const result = await runner.run({
      executable: "open",
      arguments: ["-a", applicationName, normalizedPath],
    });
    if (result.exitCode === 0) return;
    lastError = result.stderr.trim();
  }
  throw new Error(lastError || `${harness.name} could not be opened`);
}

/**
 * Only links a connector actually reported can be opened, so the renderer can
 * never hand the browser an arbitrary address.
 */
function knownObservationUrl(url: string): string {
  const known = latestSnapshot.projects.some((project) =>
    project.workspaces.some((workspace) =>
      workspace.observations.some((observation) => observation.url === url),
    ),
  );
  if (!known) throw new Error("Silvic can only open a discovered link");
  return url;
}

function knownWorkspacePath(path: string): string {
  const normalizedPath = normalize(path);
  const isKnownWorkspace = latestSnapshot.projects.some((project) =>
    project.workspaces.some(
      (workspace) => normalize(workspace.path) === normalizedPath,
    ),
  );
  if (!isKnownWorkspace) {
    throw new Error("Silvic can only operate on a discovered Workspace");
  }
  return normalizedPath;
}

async function openTerminalCommand(
  executable: string,
  arguments_: readonly string[],
  path?: string,
): Promise<void> {
  const launchers = join(app.getPath("userData"), "launchers");
  await mkdir(launchers, { recursive: true });
  const launcher = join(launchers, `${executable}-${randomUUID()}.command`);
  const script = [
    "#!/bin/zsh",
    'rm -- "$0"',
    `export PATH=${shellQuote(resolvedCommandPath())}`,
    ...(path ? [`cd -- ${shellQuote(path)} || exit`] : []),
    `exec ${[executable, ...arguments_].map(shellQuote).join(" ")}`,
  ].join("\n");
  await writeFile(launcher, script, { encoding: "utf8", mode: 0o700 });
  await chmod(launcher, 0o700);
  const error = await shell.openPath(launcher);
  if (error) throw new Error(error);
}

function defaultRoots(): string[] {
  return [
    join(homedir(), "01_Local_Workspace"),
    join(homedir(), "Developer"),
    join(homedir(), "Projects"),
  ].filter(existsSync);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalize))].sort();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safePathSegment(value: string): string {
  return value
    .trim()
    .replaceAll("/", "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function migrateLegacySettings(): Promise<void> {
  if (settings.get("legacyMigrationCompleted")) return;
  const roots = await readLegacyRoots();
  if (roots.length > 0) settings.set("roots", uniquePaths(roots));

  try {
    const contents = await readFile(
      join(
        homedir(),
        "Library",
        "Application Support",
        "Silvic",
        "workspaces.json",
      ),
      "utf8",
    );
    const value: unknown = JSON.parse(contents);
    if (
      typeof value === "object" &&
      value !== null &&
      "workspaces" in value &&
      Array.isArray(value.workspaces)
    ) {
      const records = value.workspaces.flatMap(legacyWorkspaceRecord);
      if (records.length > 0) {
        settings.set(
          "workspaceRecords",
          mergeWorkspaceRecords(settings.get("workspaceRecords"), records),
        );
      }
    }
  } catch {
    // A missing or older unreadable registry must not block startup.
  }
  settings.set("legacyMigrationCompleted", true);
}

async function readLegacyRoots(): Promise<string[]> {
  for (const domain of [
    "de.josuasievers.silvic",
    "de.josuasievers.branchdeck",
    "de.josuasievers.worktreepilot",
  ]) {
    const result = await runner.run({
      executable: "defaults",
      arguments: ["export", domain, "-"],
    });
    if (result.exitCode !== 0) continue;
    const block = result.stdout.match(
      /<key>repositoryRoots<\/key>\s*<array>([\s\S]*?)<\/array>/,
    )?.[1];
    const roots = [...(block ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)]
      .map((match) => decodeXml(match[1] ?? ""))
      .filter(Boolean);
    if (roots.length > 0) return roots;
  }
  return [];
}

function legacyWorkspaceRecord(value: unknown): WorkspaceRecord[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("location" in value) ||
    typeof value.location !== "object" ||
    value.location === null ||
    !("path" in value.location) ||
    typeof value.location.path !== "string"
  ) {
    return [];
  }
  const workspaceId = legacyIdentifier(value.id);
  if (!workspaceId) return [];
  const parentWorkspaceId =
    "parentWorkspaceID" in value
      ? legacyIdentifier(value.parentWorkspaceID)
      : undefined;
  return [
    {
      workspaceId,
      projectId: "legacy",
      path: value.location.path,
      branch: "",
      ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
      ...("displayName" in value && typeof value.displayName === "string"
        ? { displayName: value.displayName }
        : {}),
      ...("purpose" in value && typeof value.purpose === "string"
        ? { purpose: value.purpose }
        : {}),
    },
  ];
}

function legacyIdentifier(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "object" &&
    value !== null &&
    "rawValue" in value &&
    typeof value.rawValue === "string"
    ? value.rawValue
    : undefined;
}

function mergeWorkspaceRecords(
  current: readonly WorkspaceRecord[],
  legacy: readonly WorkspaceRecord[],
): WorkspaceRecord[] {
  const paths = new Set(current.map((record) => normalize(record.path)));
  return [
    ...current,
    ...legacy.filter((record) => !paths.has(normalize(record.path))),
  ];
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}
