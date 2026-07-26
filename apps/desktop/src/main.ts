import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import Store from "electron-store";

import { convexConnector } from "@silvic/connector-convex";
import { createGitHubConnector } from "@silvic/connector-github";
import { harnessById } from "@silvic/connector-harnesses";
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
  recipeSaveRequestSchema,
  workspacePathRequestSchema,
  type AppearancePreference,
  type CreateEnvironmentRequest,
  type PlotCreationResult,
  type RecipeDocument,
  type OpenWorkspaceRequest,
  type SilvicSnapshot,
} from "@silvic/contracts";
import {
  ConnectorRegistry,
  DeliveryService,
  EnvironmentService,
  LocalCommandRunner,
  ProjectService,
  Provisioner,
  inspectRepository,
  WorkspaceRegistry,
  plotPort,
  plotUrl,
  readRecipe,
  readRecipeSource,
  readWorkCliNames,
  writeRecipe,
  resolvedCommandPath,
  type WorkspaceRecord,
} from "@silvic/core";

interface Settings {
  roots: string[];
  workspaceRecords: WorkspaceRecord[];
  legacyMigrationCompleted: boolean;
  appearance: AppearancePreference;
  activeProjects: string[];
  /** Plot path to the port it was assigned, so addresses stay stable. */
  plotPorts: Record<string, number>;
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
/**
 * Git state only. Connectors shell out to `gh`, `work` and the port table, which
 * is most of the cost of a scan, so first paint uses this and the enrichment
 * arrives afterwards.
 */
const fastProjectService = new ProjectService({
  runner,
  connectors: new ConnectorRegistry([]),
});
const environmentService = new EnvironmentService(runner);
const deliveryService = new DeliveryService(runner);
const provisioner = new Provisioner(runner);
const workspaceRegistry = new WorkspaceRegistry();
const settings = new Store<Settings>({
  name: "settings",
  defaults: {
    roots: defaultRoots(),
    workspaceRecords: [],
    legacyMigrationCompleted: false,
    appearance: "system",
    activeProjects: [],
    plotPorts: {},
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

app.setName("Silvic");
if (process.platform === "darwin" && !app.isPackaged) {
  process.title = "Silvic";
}

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
    setDevelopmentDockIcon();
    await migrateLegacySettings();
    nativeTheme.themeSource = settings.get("appearance");
    nativeTheme.on("updated", () => {
      mainWindow?.setBackgroundColor(currentWindowBackground());
    });
    registerIpc();
    createWindow();
    await paintFromGit(settings.get("roots"));
    await refreshSnapshot();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function setDevelopmentDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged) return;

  const iconPath = join(
    app.getAppPath(),
    "../../Resources/Brand/Silvic-Electron-AppIcon-1024.png",
  );
  if (existsSync(iconPath)) app.dock?.setIcon(iconPath);
}

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
    // Only the chosen paths, and without connectors, so the rail updates as
    // soon as the picker closes. Everything else is re-read in the background.
    await paintFromGit(result.filePaths);
    adoptChosenProjects(result.filePaths);
    void refreshSnapshot(true);
    return roots;
  });
  ipcMain.handle(ipcChannels.rootsRemove, async (event, root: unknown) => {
    assertTrustedSender(event);
    if (typeof root !== "string") throw new Error("Invalid project root");
    const roots = settings
      .get("roots")
      .filter((candidate) => normalize(candidate) !== normalize(root));
    settings.set("roots", roots);
    await paintFromGit(roots, "replace");
    void refreshSnapshot(true);
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
      await paintFromGit([parsed.path]);
      void refreshSnapshot(true);
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
  ipcMain.handle(ipcChannels.clipboardWrite, (event, text: unknown) => {
    assertTrustedSender(event);
    if (typeof text !== "string" || text.length > 8_000) {
      throw new Error("Invalid text to copy");
    }
    clipboard.writeText(text);
  });
  ipcMain.handle(ipcChannels.recipeGet, async (event, projectId: unknown) => {
    assertTrustedSender(event);
    if (typeof projectId !== "string") throw new Error("Invalid project");
    return recipeDocument(projectId);
  });
  ipcMain.handle(ipcChannels.projectInspect, async (event, projectId: unknown) => {
    assertTrustedSender(event);
    if (typeof projectId !== "string") throw new Error("Invalid project");
    return inspectRepository(knownProjectRoot(projectId));
  });
  ipcMain.handle(ipcChannels.recipeSave, async (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = recipeSaveRequestSchema.parse(request);
    await writeRecipe(knownProjectRoot(parsed.projectId), parsed.recipe);
    return recipeDocument(parsed.projectId);
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

async function recipeDocument(projectId: string): Promise<RecipeDocument> {
  const rootPath = knownProjectRoot(projectId);
  const [source, resolved] = await Promise.all([
    readRecipeSource(rootPath),
    readRecipe(rootPath),
  ]);
  return {
    projectId,
    path: source.path,
    exists: source.exists,
    recipe: source.recipe,
    resolved: { project: resolved.project, directory: resolved.directory },
  };
}

/** Silvic only reads or writes a recipe inside a project it has discovered. */
function knownProjectRoot(projectId: string): string {
  const project = latestSnapshot.projects.find(
    (candidate) => candidate.id === projectId,
  );
  if (!project) throw new Error("Silvic can only configure a known project");
  return project.rootPath;
}

function currentWindowBackground(): string {
  return nativeTheme.shouldUseDarkColors
    ? windowBackground.dark
    : windowBackground.light;
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
): Promise<PlotCreationResult> {
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

  // The recipe decides where plots live and what the project is called, so the
  // renderer no longer has to guess a destination path.
  const recipe = await readRecipe(project.rootPath);
  const plot = safePathSegment(request.branch);
  if (!plot) throw new Error("That branch name has no usable plot name");
  // A harness shows the directory's last segment and nothing else, so the
  // project belongs in it: `feature-auth` alone says nothing about which
  // repository you have opened.
  const destinationPath = join(recipe.directory, `${recipe.project}-${plot}`);
  const port = plotPort(recipe.project, plot, takenPlotPorts());
  const url = plotUrl(port);

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
  settings.set("plotPorts", { ...settings.get("plotPorts"), [destinationPath]: port });

  const provision = await provisioner.run(recipe.provision, {
    root: destinationPath,
    sourceRoot: project.rootPath,
    project: recipe.project,
    plot,
    branch: request.branch,
    url,
    ...(recipe.packageManager
      ? { packageManager: recipe.packageManager }
      : {}),
  });

  await paintFromGit([project.rootPath, destinationPath]);
  void refreshSnapshot(true);
  return {
    snapshot: latestSnapshot,
    plot: { name: plot, path: destinationPath, port, url },
    provision,
  };
}

/** Ports already handed out, so two plots never land on the same one. */
function takenPlotPorts(): Set<number> {
  return new Set(Object.values(settings.get("plotPorts")));
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
  ]).then(([rawSnapshot, workCliNames]) =>
    publishSnapshot(rawSnapshot, workCliNames, "replace"),
  );
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

function publishSnapshot(
  rawSnapshot: SilvicSnapshot,
  workCliNames: ReadonlyMap<string, string>,
  mode: "replace" | "merge",
): SilvicSnapshot {
  const reconciled = workspaceRegistry.reconcile(
    rawSnapshot,
    settings.get("workspaceRecords"),
    workCliNames,
  );
  settings.set("workspaceRecords", [...reconciled.records]);
  latestSnapshot =
    mode === "merge"
      ? mergeSnapshots(latestSnapshot, reconciled.snapshot)
      : reconciled.snapshot;
  mainWindow?.webContents.send(ipcChannels.snapshotChanged, latestSnapshot);
  return latestSnapshot;
}

/** A partial scan replaces the projects it covers and leaves the rest alone. */
function mergeSnapshots(
  current: SilvicSnapshot,
  incoming: SilvicSnapshot,
): SilvicSnapshot {
  const byId = new Map(current.projects.map((project) => [project.id, project]));
  for (const project of incoming.projects) byId.set(project.id, project);
  return {
    projects: [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    connectorFailures:
      incoming.connectorFailures.length > 0
        ? incoming.connectorFailures
        : current.connectorFailures,
    refreshedAt: incoming.refreshedAt,
  };
}

/**
 * Git-only pass so the interface reflects a change immediately. Connector
 * enrichment is an order of magnitude slower and arrives afterwards, so no
 * user-facing action should ever wait for it.
 */
async function paintFromGit(
  paths: readonly string[],
  mode: "replace" | "merge" = "merge",
): Promise<void> {
  try {
    const [rawSnapshot, workCliNames] = await Promise.all([
      fastProjectService.snapshot(paths),
      readWorkCliNames(),
    ]);
    publishSnapshot(rawSnapshot, workCliNames, mode);
  } catch {
    // The full refresh reports anything that genuinely failed.
  }
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
  const known = latestSnapshot.projects.some(
    (project) =>
      project.remoteUrl === url ||
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
