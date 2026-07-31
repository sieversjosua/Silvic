import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, normalize } from "node:path";
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
  harnessIdSchema,
  deliveryExecuteRequestSchema,
  ipcChannels,
  openLinkRequestSchema,
  openWorkspaceRequestSchema,
  projectActivationRequestSchema,
  teardownRequestSchema,
  plotPreviewRequestSchema,
  plotCommandRequestSchema,
  plotProvisionRequestSchema,
  testStepRequestSchema,
  recipeSaveRequestSchema,
  workspacePathRequestSchema,
  type AppearancePreference,
  type CreateEnvironmentRequest,
  type HarnessId,
  type PlotCreationResult,
  type PlotCommand,
  type PlotProvisioning,
  type PlotProvisionRequest,
  type ProvisionResult,
  type RecipeDocument,
  type OpenWorkspaceRequest,
  type SilvicSnapshot,
  type WorkspaceSnapshot,
} from "@silvic/contracts";
import {
  CommandSupervisor,
  ConnectorRegistry,
  DeliveryService,
  EnvironmentService,
  LocalCommandRunner,
  ProjectService,
  Provisioner,
  TeardownService,
  inspectRepository,
  planTeardown,
  suggestedCommands,
  suggestedSteps,
  provisionOutputLimit,
  remedyCommand,
  remedyLabel,
  WorkspaceRegistry,
  plotPort,
  plotUrl,
  provisionEnvironment,
  provisionCompleted,
  provisionStepLabel,
  readRecipe,
  mergeSnapshots,
  routeNameFor,
  readRecipeSource,
  readWorkCliNames,
  writeRecipe,
  resolvedCommandPath,
  type SupervisedCommand,
  type WorkspaceRecord,
} from "@silvic/core";

import { PlotProgressReporter } from "./plot-progress";

interface Settings {
  roots: string[];
  workspaceRecords: WorkspaceRecord[];
  legacyMigrationCompleted: boolean;
  appearance: AppearancePreference;
  activeProjects: string[];
  defaultHarness: HarnessId;
  /** Plot path to the port it was assigned, so addresses stay stable. */
  plotPorts: Record<string, number>;
  /** Plot path to the outcome of the last provisioning run there. */
  plotProvisioning: Record<string, PlotProvisioning>;
  /** Whether a plot's commands outlive the window that started them. */
  keepCommandsRunning: boolean;
  /** What was left running, so a new window can take it back. */
  runningCommands: SupervisedCommand[];
}

/** Enough of a failure to show and act on, without keeping whole build logs. */
const recordedOutputLimit = 4_000;

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
const teardownService = new TeardownService(runner);
const workspaceRegistry = new WorkspaceRegistry();
let runtimeRefreshTimer: NodeJS.Timeout | undefined;
const supervisor = new CommandSupervisor({
  logDirectory: join(app.getPath("userData"), "command-logs"),
  onChange: (processes) => {
    // Written down as it changes, so a window that closes does not take the
    // knowledge of what is running with it.
    settings.set("runningCommands", [...processes]);
    mainWindow?.webContents.send(ipcChannels.plotCommandsChanged, processes);
    connectors.invalidate("local-context");
    if (runtimeRefreshTimer) clearTimeout(runtimeRefreshTimer);
    runtimeRefreshTimer = setTimeout(() => {
      connectors.invalidate("local-context");
      void refreshSnapshot(true);
    }, 750);
  },
});
const settings = new Store<Settings>({
  name: "settings",
  defaults: {
    roots: defaultRoots(),
    workspaceRecords: [],
    legacyMigrationCompleted: false,
    appearance: "system",
    activeProjects: [],
    defaultHarness: "codex",
    plotPorts: {},
    plotProvisioning: {},
    keepCommandsRunning: true,
    runningCommands: [],
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
    supervisor.adopt(settings.get("runningCommands"));
    registerIpc();
    createWindow();
    await paintFromGit(settings.get("roots"));
    await refreshSnapshot();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  if (!settings.get("keepCommandsRunning")) supervisor.stopAll();
});

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
  ipcMain.handle(ipcChannels.plotProvision, async (event, request: unknown) => {
    assertTrustedSender(event);
    return provisionPlot(plotProvisionRequestSchema.parse(request));
  });
  ipcMain.handle(ipcChannels.plotCommandsGet, (event) => {
    assertTrustedSender(event);
    return supervisor.list();
  });
  ipcMain.handle(ipcChannels.keepRunningGet, (event) => {
    assertTrustedSender(event);
    return settings.get("keepCommandsRunning");
  });
  ipcMain.handle(ipcChannels.keepRunningSet, (event, keep: unknown) => {
    assertTrustedSender(event);
    if (typeof keep !== "boolean") throw new Error("Invalid setting");
    settings.set("keepCommandsRunning", keep);
    return keep;
  });
  ipcMain.handle(ipcChannels.plotCommandStart, async (event, request) => {
    assertTrustedSender(event);
    const parsed = plotCommandRequestSchema.parse(request);
    return startPlotCommand(parsed.path, parsed.id);
  });
  ipcMain.handle(ipcChannels.plotCommandStop, (event, request) => {
    assertTrustedSender(event);
    const parsed = plotCommandRequestSchema.parse(request);
    supervisor.stop(knownWorkspacePath(parsed.path), parsed.id);
  });
  ipcMain.handle(ipcChannels.plotCommandOutput, (event, request) => {
    assertTrustedSender(event);
    const parsed = plotCommandRequestSchema.parse(request);
    return supervisor.output(knownWorkspacePath(parsed.path), parsed.id);
  });
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
  ipcMain.handle(ipcChannels.defaultHarnessGet, (event) => {
    assertTrustedSender(event);
    return settings.get("defaultHarness");
  });
  ipcMain.handle(ipcChannels.defaultHarnessSet, (event, id: unknown) => {
    assertTrustedSender(event);
    const parsed = harnessIdSchema.parse(id);
    settings.set("defaultHarness", parsed);
    return parsed;
  });
  ipcMain.handle(ipcChannels.plotPreview, async (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = plotPreviewRequestSchema.parse(request);
    const rootPath = knownProjectRoot(parsed.projectId);
    const recipe = await readRecipe(rootPath);
    const plot = safePathSegment(parsed.branch) || "my-branch";
    const port = plotPort(recipe.project, plot, takenPlotPorts());
    const destinationPath = join(recipe.directory, `${recipe.project}-${plot}`);
    // The same question creation asks, asked while the name is still being
    // typed, so a plot that cannot be made is never offered.
    const conflict = parsed.branch.trim()
      ? await environmentService.conflict({
          sourcePath: rootPath,
          branch: parsed.branch.trim(),
          destinationPath,
        })
      : undefined;
    return {
      name: plot,
      path: destinationPath,
      port,
      url: plotUrl(port),
      ...(conflict ? { conflict } : {}),
    };
  });
  ipcMain.handle(ipcChannels.stepTest, async (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = testStepRequestSchema.parse(request);
    const rootPath = knownProjectRoot(parsed.projectId);
    const recipe = await readRecipe(rootPath);
    // Runs in the primary checkout, since there is no plot yet. Typed steps are
    // not testable: creating a deployment is not a rehearsal.
    const [result] = await provisioner.run([parsed.step], {
      root: rootPath,
      sourceRoot: rootPath,
      project: recipe.project,
      plot: "preview",
      ...(recipe.packageManager
        ? { packageManager: recipe.packageManager }
        : {}),
    });
    if (!result) throw new Error("The step produced no result");
    return result;
  });
  ipcMain.handle(ipcChannels.teardownPlan, async (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = teardownRequestSchema.parse(request);
    const workspace = knownWorkspace(parsed.path);
    return planTeardown({
      workspace,
      scope: parsed.scope,
      deleteBranch: parsed.deleteBranch,
      discardChanges: parsed.discardChanges,
      supervised: supervisedIn(workspace.path),
      heldOnlyHere: await commitsHeldOnlyHere(workspace),
    });
  });
  ipcMain.handle(ipcChannels.teardownRun, async (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = teardownRequestSchema.parse(request);
    const workspace = knownWorkspace(parsed.path);
    const project = latestSnapshot.projects.find((candidate) =>
      candidate.workspaces.some(
        (entry) => normalize(entry.path) === normalize(parsed.path),
      ),
    );
    if (!project) throw new Error("Silvic can only tear down a known plot");
    const plan = planTeardown({
      workspace,
      scope: parsed.scope,
      deleteBranch: parsed.deleteBranch,
      discardChanges: parsed.discardChanges,
      supervised: supervisedIn(workspace.path),
      heldOnlyHere: await commitsHeldOnlyHere(workspace),
    });
    const results = await teardownService.execute(plan, {
      path: workspace.path,
      branch: workspace.branch,
      projectRoot: project.rootPath,
      stopCommand: (id) => supervisor.stop(workspace.path, id),
    });
    // Deletion is authoritative, and the returned snapshot must keep connector
    // state for every surviving workspace.
    await refreshSnapshot(true);
    return { results, snapshot: latestSnapshot };
  });
  ipcMain.handle(ipcChannels.recipeGet, async (event, projectId: unknown) => {
    assertTrustedSender(event);
    if (typeof projectId !== "string") throw new Error("Invalid project");
    return recipeDocument(projectId);
  });
  ipcMain.handle(
    ipcChannels.projectInspect,
    async (event, projectId: unknown) => {
      assertTrustedSender(event);
      if (typeof projectId !== "string") throw new Error("Invalid project");
      // The reading and what Silvic makes of it travel together: the interface
      // offers the conclusions, and cannot reach the knowledge that drew them.
      const findings = await inspectRepository(knownProjectRoot(projectId));
      return {
        findings,
        steps: suggestedSteps(findings),
        commands: suggestedCommands(findings),
      };
    },
  );
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

const checkoutStepId = "checkout";
const surveyStepId = "survey";
const remedyStepId = "remedy";

function provisionStepId(index: number): string {
  return `provision:${index}`;
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

  // Named before anything runs, so the dialog can show the whole plan and not
  // just the step that happens to be running.
  const progress = new PlotProgressReporter(
    request.branch,
    [
      {
        id: checkoutStepId,
        label:
          request.mode === "worktree"
            ? "Create the linked worktree"
            : "Clone the repository",
      },
      ...recipe.provision.map((step, index) => ({
        id: provisionStepId(index),
        label: provisionStepLabel(step, index),
      })),
      { id: surveyStepId, label: "Survey the new plot" },
    ],
    (payload) =>
      mainWindow?.webContents.send(ipcChannels.plotProgress, payload),
  );
  progress.announce();

  try {
    progress.began(checkoutStepId);
    await environmentService.create({
      sourcePath,
      destinationPath,
      branch: request.branch,
      mode: request.mode,
      // A branch taken up starts where it already is, so the source's revision
      // is not a start point for it.
      ...(request.adopt
        ? { adopt: request.adopt }
        : source.git.revision
          ? { startPoint: source.git.revision }
          : {}),
      ...(project.origin ? { origin: project.origin } : {}),
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
    settings.set("plotPorts", {
      ...settings.get("plotPorts"),
      [destinationPath]: port,
    });
    progress.finished(checkoutStepId);

    const provision = await provisioner.run(
      recipe.provision,
      {
        root: destinationPath,
        sourceRoot: source.path,
        sourceFallbackRoots: providerSourceRoots(project, source.path),
        project: recipe.project,
        plot,
        branch: request.branch,
        url,
        ...(recipe.packageManager
          ? { packageManager: recipe.packageManager }
          : {}),
      },
      {
        onStepStart: ({ index }) => progress.began(provisionStepId(index)),
        onStepOutput: ({ index, chunk }) =>
          progress.wrote(provisionStepId(index), chunk),
        onStep: (result, index) =>
          result.exitCode === 0
            ? progress.finished(provisionStepId(index), result.durationMs)
            : progress.failed(
                provisionStepId(index),
                result.advice ?? result.output,
              ),
      },
    );

    recordProvisioning(destinationPath, provision);
    progress.began(surveyStepId);
    await paintFromGit([project.rootPath, destinationPath]);
    progress.finished(surveyStepId);
    // The recipe said these should be up; the plot is handed over running.
    if (provisionCompleted(recipe.provision, provision)) {
      await startAutoCommands(destinationPath, recipe.commands);
    }
    void refreshSnapshot(true);
    return {
      snapshot: latestSnapshot,
      plot: { name: plot, path: destinationPath, port, url },
      provision,
      commands: recipe.commands,
    };
  } catch (error) {
    progress.stumbled(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    progress.settled();
  }
}

/**
 * A plot that failed to provision is still a plot, so the recipe can be run in
 * it again — the steps are declared idempotent, and the ones that already
 * succeeded simply pass a second time. A remedy, when Silvic recognised the
 * failure well enough to offer one, runs first.
 */
async function provisionPlot(
  request: PlotProvisionRequest,
): Promise<readonly ProvisionResult[]> {
  const workspace = knownWorkspace(request.path);
  const project = latestSnapshot.projects.find((candidate) =>
    candidate.workspaces.some(
      (candidateWorkspace) =>
        candidateWorkspace.workspaceId === workspace.workspaceId,
    ),
  );
  if (!project) throw new Error("That plot belongs to no known project");

  const recipe = await readRecipe(project.rootPath);
  const packageManager =
    recipe.packageManager ??
    (await inspectRepository(workspace.path)).packageManager;
  const remedy = request.remedy;
  const plot = plotNameIn(workspace.path, recipe.project);
  const port =
    storedPlotPort(workspace.path) ??
    plotPort(recipe.project, plot, takenPlotPorts());
  const sourceRoot =
    project.workspaces.find(
      (candidate) =>
        candidate.workspaceId === workspace.lineage?.parentWorkspaceId,
    )?.path ?? project.rootPath;

  const progress = new PlotProgressReporter(
    workspace.git.branch,
    [
      ...(remedy ? [{ id: remedyStepId, label: remedyLabel(remedy) }] : []),
      ...recipe.provision.map((step, index) => ({
        id: provisionStepId(index),
        label: provisionStepLabel(step, index),
      })),
    ],
    (payload) =>
      mainWindow?.webContents.send(ipcChannels.plotProgress, payload),
  );
  progress.announce();

  try {
    let repair: ProvisionResult | undefined;
    if (remedy) {
      progress.began(remedyStepId);
      const startedAt = Date.now();
      const command = remedyCommand(remedy, packageManager);
      const result = await runner.run({
        executable: "sh",
        arguments: ["-c", command],
        cwd: workspace.path,
        onOutput: (chunk) => progress.wrote(remedyStepId, chunk),
      });
      repair = {
        label: remedyLabel(remedy),
        command,
        exitCode: result.exitCode,
        output: `${result.stdout}${result.stderr}`
          .trim()
          .slice(0, provisionOutputLimit),
        durationMs: Date.now() - startedAt,
      };
      if (repair.exitCode !== 0) {
        progress.failed(remedyStepId, repair.output);
        recordProvisioning(workspace.path, [repair]);
        void refreshSnapshot(true);
        return [repair];
      }
      progress.finished(remedyStepId, repair.durationMs);
    }

    const provision = await provisioner.run(
      recipe.provision,
      {
        root: workspace.path,
        sourceRoot,
        sourceFallbackRoots: providerSourceRoots(project, sourceRoot),
        project: recipe.project,
        plot,
        branch: workspace.git.branch,
        url: plotUrl(port),
        ...(packageManager ? { packageManager } : {}),
      },
      {
        onStepStart: ({ index }) => progress.began(provisionStepId(index)),
        onStepOutput: ({ index, chunk }) =>
          progress.wrote(provisionStepId(index), chunk),
        onStep: (stepResult, index) =>
          stepResult.exitCode === 0
            ? progress.finished(provisionStepId(index), stepResult.durationMs)
            : progress.failed(
                provisionStepId(index),
                stepResult.advice ?? stepResult.output,
              ),
      },
    );

    const results = repair ? [repair, ...provision] : provision;
    recordProvisioning(workspace.path, results);
    await paintFromGit([workspace.path]);
    if (provisionCompleted(recipe.provision, provision)) {
      await startAutoCommands(workspace.path, recipe.commands);
    }
    void refreshSnapshot(true);
    return results;
  } catch (error) {
    progress.stumbled(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    progress.settled();
  }
}

async function startAutoCommands(
  plotPath: string,
  commands: Readonly<Record<string, PlotCommand>>,
): Promise<void> {
  for (const [id, command] of Object.entries(commands)) {
    if (!command.autoStart) continue;
    try {
      await startPlotCommand(plotPath, id);
    } catch {
      // A runtime failure remains visible in its log, without turning a fully
      // provisioned worktree back into a failed plot.
    }
  }
}

function providerSourceRoots(
  project: { workspaces: readonly WorkspaceSnapshot[] },
  selectedPath: string,
): readonly string[] {
  const selected = normalize(selectedPath);
  return project.workspaces
    .filter(
      (workspace) =>
        workspace.locationKind === "checkout" &&
        normalize(workspace.path) !== selected,
    )
    .map((workspace) => workspace.path);
}

/**
 * What the last run did, kept so a plot can say it never finished long after
 * the dialog that ran it has gone. Output is trimmed hard: this is a record of
 * what happened, not a log store.
 */
function recordProvisioning(
  path: string,
  steps: readonly ProvisionResult[],
): void {
  settings.set("plotProvisioning", {
    ...settings.get("plotProvisioning"),
    [path]: {
      status: steps.some((step) => step.exitCode !== 0) ? "failed" : "complete",
      at: new Date().toISOString(),
      steps: steps.map((step) => ({
        ...step,
        output: step.output.slice(0, recordedOutputLimit),
      })),
    },
  });
}

/** A plot carries the outcome of its last provisioning run into the snapshot. */
function withProvisioning(snapshot: SilvicSnapshot): SilvicSnapshot {
  const records = new Map(
    Object.entries(settings.get("plotProvisioning")).map(([path, record]) => [
      normalize(path),
      record,
    ]),
  );
  if (records.size === 0) return snapshot;
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      workspaces: project.workspaces.map((workspace) => {
        const record = records.get(normalize(workspace.path));
        return record ? { ...workspace, provisioning: record } : workspace;
      }),
    })),
  };
}

/**
 * How many commits would stop being reachable if this branch went away: those
 * on it and on no other ref, local or remote. Zero means deleting the branch
 * discards nothing, which is the ordinary state of a plot nobody committed in.
 * Undefined when the question could not be answered, so teardown can refuse
 * rather than assume either way.
 */
async function commitsHeldOnlyHere(
  workspace: WorkspaceSnapshot,
): Promise<number | undefined> {
  const branch = workspace.git.branch;
  if (!branch) return undefined;
  const result = await runner.run({
    executable: "git",
    arguments: [
      "rev-list",
      "--count",
      branch,
      "--not",
      `--exclude=${branch}`,
      "--branches",
      "--remotes",
    ],
    cwd: workspace.path,
  });
  if (result.exitCode !== 0) return undefined;
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isNaN(count) ? undefined : count;
}

/**
 * Starts one of the commands a recipe declares, in the plot. Serving commands
 * get the plot's stable localhost port. A recipe can additionally opt into a
 * named address through portless.
 */
async function startPlotCommand(path: string, id: string): Promise<void> {
  const workspace = knownWorkspace(path);
  const project = latestSnapshot.projects.find((candidate) =>
    candidate.workspaces.some(
      (entry) => entry.workspaceId === workspace.workspaceId,
    ),
  );
  if (!project) throw new Error("That plot belongs to no known project");

  const recipe = await readRecipe(project.rootPath);
  const command = recipe.commands[id];
  if (!command) {
    throw new Error(`This repository declares no command called ${id}`);
  }
  const plot = plotNameIn(workspace.path, recipe.project);
  const port =
    storedPlotPort(workspace.path) ??
    plotPort(recipe.project, plot, takenPlotPorts());

  await supervisor.start({
    plotPath: workspace.path,
    id,
    command,
    routeName: routeNameFor(
      { id, ...(command.routeName ? { routeName: command.routeName } : {}) },
      plot,
      recipe.project,
    ),
    environment: {
      ...provisionEnvironment({
        root: workspace.path,
        sourceRoot: project.rootPath,
        project: recipe.project,
        plot,
        branch: workspace.git.branch,
        url: plotUrl(port),
        ...(recipe.packageManager
          ? { packageManager: recipe.packageManager }
          : {}),
      }),
      // Ignored by a routed command: portless hands out its own.
      PORT: String(port),
    },
    canRoute: await portlessAvailable(),
    detached: settings.get("keepCommandsRunning"),
  });
}

/** The commands Silvic has running in a plot, by their recipe ids. */
function supervisedIn(plotPath: string): readonly string[] {
  return supervisor
    .list()
    .filter(
      (entry) =>
        entry.status === "running" &&
        normalize(entry.plotPath) === normalize(plotPath),
    )
    .map((entry) => entry.id);
}

/** Asked once: whether this machine can publish a command under a name. */
let portlessCheck: Promise<boolean> | undefined;
function portlessAvailable(): Promise<boolean> {
  portlessCheck ??= runner
    .run({ executable: "which", arguments: ["portless"] })
    .then((result) => result.exitCode === 0)
    .catch(() => false);
  return portlessCheck;
}

/** Plots are directories named `<project>-<plot>`; older ones are `<plot>`. */
function plotNameIn(path: string, project: string): string {
  const folder = basename(path);
  return folder.startsWith(`${project}-`)
    ? folder.slice(project.length + 1)
    : folder;
}

/** The address a plot was already given, so a repair cannot move it. */
function storedPlotPort(path: string): number | undefined {
  const target = normalize(path);
  return Object.entries(settings.get("plotPorts")).find(
    ([candidate]) => normalize(candidate) === target,
  )?.[1];
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
  const decorated = withProvisioning(reconciled.snapshot);
  latestSnapshot =
    mode === "merge" ? mergeSnapshots(latestSnapshot, decorated) : decorated;
  mainWindow?.webContents.send(ipcChannels.snapshotChanged, latestSnapshot);
  return latestSnapshot;
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
  const known =
    latestSnapshot.projects.some(
      (project) =>
        project.remoteUrl === url ||
        project.workspaces.some((workspace) =>
          workspace.observations.some((observation) => observation.url === url),
        ),
    ) ||
    // An address Silvic published itself by starting a command. It was never
    // observed, because it exists on Silvic's say-so.
    supervisor.list().some((entry) => entry.url === url);
  if (!known) throw new Error("Silvic can only open a discovered link");
  return url;
}

function knownWorkspace(path: string) {
  const normalized = normalize(path);
  const workspace = latestSnapshot.projects
    .flatMap((project) => project.workspaces)
    .find((candidate) => normalize(candidate.path) === normalized);
  if (!workspace) throw new Error("Silvic can only tear down a known plot");
  return workspace;
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
