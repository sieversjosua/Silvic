import { existsSync, watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, normalize, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  request as httpRequest,
  type RequestOptions as HttpRequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import Store from "electron-store";
import { autoUpdater } from "electron-updater";

import {
  AutomationController,
  startAutomationServer,
  type AutomationServer,
} from "@silvic/automation";
import { convexConnector } from "@silvic/connector-convex";
import {
  createGitHubConnector,
  findGitHubPullRequest,
  listGitHubIssues,
} from "@silvic/connector-github";
import { harnessById } from "@silvic/connector-harnesses";
import { createLocalContextConnector } from "@silvic/connector-local";
import {
  appearancePreferenceSchema,
  codexEnvironmentRequestSchema,
  createEnvironmentRequestSchema,
  harnessIdSchema,
  deliveryExecuteRequestSchema,
  ipcChannels,
  issueListRequestSchema,
  pullRequestLookupRequestSchema,
  openLinkRequestSchema,
  openWorkspaceRequestSchema,
  projectActivationRequestSchema,
  teardownRequestSchema,
  plotPreviewRequestSchema,
  plotRenameRequestSchema,
  plotCommandRequestSchema,
  plotProvisionRequestSchema,
  plotAdoptionPlanRequestSchema,
  plotAdoptionRunRequestSchema,
  testStepRequestSchema,
  recipeSaveRequestSchema,
  workspacePathRequestSchema,
  type AppearancePreference,
  type AppUpdateState,
  type CreateEnvironmentRequest,
  type HarnessId,
  type PlotCreationResult,
  type PlotCommand,
  type PlotProvisionRunResult,
  type PlotProvisioning,
  type PlotProvisionRequest,
  type PlotAdoption,
  type PlotAdoptionPlan,
  type PlotAdoptionPlanRequest,
  type PlotAdoptionRunRequest,
  type PlotAdoptionRunResult,
  type PlotReadiness,
  type PlotRuntimeStart,
  type ProjectSnapshot,
  type ProvisionResult,
  type RecipeDocument,
  type OpenWorkspaceRequest,
  type SilvicSnapshot,
  type WorkspaceSnapshot,
} from "@silvic/contracts";
import {
  CommandSupervisor,
  buildAdoptionPlan,
  configureCodexEnvironment,
  executeAdoption,
  ConnectorRegistry,
  DeliveryService,
  EnvironmentService,
  LocalCommandRunner,
  ProjectService,
  Provisioner,
  TeardownService,
  inspectRepository,
  inspectCodexEnvironment,
  planTeardown,
  suggestedCommands,
  suggestRecipe,
  suggestedSteps,
  provisionOutputLimit,
  remedyCommand,
  remedyLabel,
  WorkspaceRegistry,
  plotPort,
  resolvePlotAddress,
  provisionEnvironment,
  primeResolvedCommandPath,
  provisionCompleted,
  provisionStepLabel,
  waitForReadiness,
  readRecipe,
  mergeSnapshots,
  snapshotsSemanticallyEqual,
  withoutWorkspace,
  workspaceRecordsEqual,
  routeNameFor,
  routes,
  runtimeStartResult,
  readRecipeSource,
  renameWorkspaceRecord,
  writeRecipe,
  resolvedCommandPath,
  type SupervisedCommand,
  type PlotAddress,
  type ResolvedRecipe,
  type WorkspaceRecord,
} from "@silvic/core";

import { GateManager, type GateFailure, type GateWake } from "./gate-manager";
import { PlotProgressReporter } from "./plot-progress";
import {
  updateMenuPresentations,
  type UpdateMenuAction,
} from "./application-menu";
import { DesktopUpdater } from "./updater";

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
const localContextConnector = createLocalContextConnector(runner);
const localContextRegistry = new ConnectorRegistry([localContextConnector]);
const connectors = new ConnectorRegistry([
  createGitHubConnector(runner),
  convexConnector,
  localContextConnector,
]);
const projectService = new ProjectService({ runner, connectors });
/**
 * Git state only. Connectors shell out to `gh`, Convex and the port table, which
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
let runtimeObservationRefreshTimer: NodeJS.Timeout | undefined;
let lastSupervisedPaths = new Set<string>();
const pendingRuntimeObservationPaths = new Set<string>();
const gate = new GateManager(
  (wake) => void wakePlotFromGate(wake),
  (failure) => recoverPlotFromGate(failure),
);
const supervisor = new CommandSupervisor({
  routePublisher: gate.publisher,
  logDirectory: join(app.getPath("userData"), "command-logs"),
  onChange: (processes) => {
    // Written down as it changes, so a window that closes does not take the
    // knowledge of what is running with it.
    settings.set("runningCommands", [...processes]);
    mainWindow?.webContents.send(ipcChannels.plotCommandsChanged, processes);
    connectors.invalidate("local-context");
    const nextPaths = new Set(
      processes.map((process) => normalize(process.plotPath)),
    );
    for (const path of [...lastSupervisedPaths, ...nextPaths]) {
      pendingRuntimeObservationPaths.add(path);
    }
    lastSupervisedPaths = nextPaths;
    scheduleRuntimeObservationRefresh();
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
const automation = new AutomationController({
  snapshot: () => latestSnapshot,
  roots: () => settings.get("roots"),
  definition: automationPlotDefinition,
  processes: () => supervisor.list(),
  start: (plotPath, runtimeId) => startPlotCommand(plotPath, runtimeId, false),
  stop: (plotPath, runtimeId) => supervisor.stop(plotPath, runtimeId),
  output: (plotPath, runtimeId, limit) =>
    supervisor.output(plotPath, runtimeId, limit),
  probe: probePreview,
});

let mainWindow: BrowserWindow | undefined;
let desktopUpdater: DesktopUpdater | undefined;
let automationServer: AutomationServer | undefined;
let latestSnapshot: SilvicSnapshot = {
  projects: [],
  connectorFailures: [],
  refreshedAt: new Date(0).toISOString(),
};
let activeRefresh: Promise<SilvicSnapshot> | undefined;
let queuedFreshRefresh: Promise<SilvicSnapshot> | undefined;
let rootWatchers: FSWatcher[] = [];
let filesystemRefreshTimer: NodeJS.Timeout | undefined;
let rendererVisible = true;
const pendingFilesystemPaths = new Set<string>();

app.setName("Silvic");
if (process.platform === "darwin" && !app.isPackaged) {
  process.title = "Silvic";
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    handleWakeArguments(argv);
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    setDevelopmentDockIcon();
    void primeResolvedCommandPath();
    await migrateLegacySettings();
    nativeTheme.themeSource = settings.get("appearance");
    nativeTheme.on("updated", () => {
      mainWindow?.setBackgroundColor(currentWindowBackground());
    });
    // The silent half of gate setup self-heals at every start, so a fresh
    // machine only ever owes the one administrator prompt.
    void gate.ensureAgent().catch(() => undefined);
    const leftRunning = settings.get("runningCommands");
    await supervisor.adopt(leftRunning);
    try {
      automationServer = await startAutomationServer({
        handle: (request, signal) => automation.handle(request, signal),
      });
    } catch (error) {
      console.error("Silvic automation interface could not start", error);
    }
    const hasUpdateChannel =
      app.isPackaged &&
      process.env.SILVIC_DISABLE_UPDATES !== "1" &&
      existsSync(join(process.resourcesPath, "app-update.yml"));
    desktopUpdater = new DesktopUpdater({
      source: autoUpdater,
      currentVersion: app.getVersion(),
      // A locally packaged build ships without app-update.yml; checking would
      // only ever produce an ENOENT, so it has no update channel at all.
      enabled: hasUpdateChannel,
      relocationRequired:
        hasUpdateChannel &&
        process.platform === "darwin" &&
        !app.isInApplicationsFolder(),
      downloadAutomatically: true,
      onState: publishUpdateState,
    });
    installApplicationMenu();
    registerIpc();
    installRootWatchers();
    createWindow();
    scheduleAutomaticUpdateChecks();
    await paintFromGit(settings.get("roots"), "replace");
    void refreshConnectorObservations();
    handleWakeArguments(process.argv);
    void revivePlotCommands(leftRunning);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  void automationServer?.close();
  automationServer = undefined;
  rootWatchers.forEach((watcher) => watcher.close());
  rootWatchers = [];
  if (runtimeObservationRefreshTimer) {
    clearTimeout(runtimeObservationRefreshTimer);
    runtimeObservationRefreshTimer = undefined;
  }
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
  ipcMain.handle(ipcChannels.snapshotRefresh, async (event) => {
    assertTrustedSender(event);
    await refreshSnapshot(true);
  });
  ipcMain.handle(ipcChannels.observationsRefresh, async (event) => {
    assertTrustedSender(event);
    await refreshConnectorObservations();
  });
  ipcMain.handle(
    ipcChannels.rendererVisibilitySet,
    async (event, visible: unknown) => {
      assertTrustedSender(event);
      if (typeof visible !== "boolean") throw new Error("Invalid visibility");
      rendererVisible = visible;
      if (visible) await flushFilesystemRefresh();
    },
  );
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
    installRootWatchers();
    // Only the chosen paths, and without connectors, so the rail updates as
    // soon as the picker closes. Everything else is re-read in the background.
    await paintFromGit(result.filePaths);
    adoptChosenProjects(result.filePaths);
    void refreshConnectorObservations();
    return roots;
  });
  ipcMain.handle(ipcChannels.rootsRemove, async (event, root: unknown) => {
    assertTrustedSender(event);
    if (typeof root !== "string") throw new Error("Invalid project root");
    const roots = settings
      .get("roots")
      .filter((candidate) => normalize(candidate) !== normalize(root));
    settings.set("roots", roots);
    installRootWatchers();
    await paintFromGit(roots, "replace");
    void refreshConnectorObservations();
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
  ipcMain.handle(
    ipcChannels.plotAdoptionPlan,
    async (event, request: unknown) => {
      assertTrustedSender(event);
      return planPlotAdoption(plotAdoptionPlanRequestSchema.parse(request));
    },
  );
  ipcMain.handle(
    ipcChannels.plotAdoptionRun,
    async (event, request: unknown) => {
      assertTrustedSender(event);
      return adoptPlots(plotAdoptionRunRequestSchema.parse(request));
    },
  );
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
  ipcMain.handle(ipcChannels.issuesList, async (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = issueListRequestSchema.parse(request);
    return listGitHubIssues(
      runner,
      knownProjectRoot(parsed.projectId),
      parsed.query,
    );
  });
  ipcMain.handle(
    ipcChannels.pullRequestFind,
    async (event, request: unknown) => {
      assertTrustedSender(event);
      const parsed = pullRequestLookupRequestSchema.parse(request);
      const rootPath = knownProjectRoot(parsed.projectId);
      const pullRequest = await findGitHubPullRequest(
        runner,
        rootPath,
        parsed.number,
      );
      // A pull request opened elsewhere is usually not fetched here yet, and
      // a worktree cannot be cut from a ref this clone has never seen. The
      // lookup brings the branch down so taking it up is a local matter — and
      // says so when there is no branch left to bring.
      if (!pullRequest || pullRequest.headRepository) return pullRequest;
      await fetchBranch(rootPath, pullRequest.headRefName);
      return (await branchReachable(rootPath, pullRequest.headRefName))
        ? pullRequest
        : { ...pullRequest, headGone: true };
    },
  );
  ipcMain.handle(ipcChannels.linkOpen, async (event, request: unknown) => {
    assertTrustedSender(event);
    const { url } = openLinkRequestSchema.parse(request);
    await openExternalLink(await knownLinkUrl(url));
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
    if (active) void refreshConnectorObservations();
    return next;
  });
  ipcMain.handle(
    ipcChannels.codexEnvironmentGet,
    async (event, projectId: unknown) => {
      assertTrustedSender(event);
      if (typeof projectId !== "string") throw new Error("Invalid project");
      return inspectCodexEnvironment(knownProjectRoot(projectId));
    },
  );
  ipcMain.handle(
    ipcChannels.codexEnvironmentSet,
    async (event, request: unknown) => {
      assertTrustedSender(event);
      const { projectId, enabled } =
        codexEnvironmentRequestSchema.parse(request);
      return configureCodexEnvironment(knownProjectRoot(projectId), enabled);
    },
  );
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
    const address = addressFor(recipe, plot, port);
    const routingIssue = await namedRoutingIssue(address);
    return {
      name: plot,
      path: destinationPath,
      port,
      url: address.url,
      ...(conflict ? { conflict } : {}),
      ...(routingIssue ? { advice: routingIssue } : {}),
    };
  });
  ipcMain.handle(ipcChannels.plotRename, (event, request: unknown) => {
    assertTrustedSender(event);
    const parsed = plotRenameRequestSchema.parse(request);
    const workspace = latestSnapshot.projects
      .flatMap((project) => project.workspaces)
      .find((candidate) => candidate.workspaceId === parsed.workspaceId);
    if (!workspace || workspace.isPrimary) throw new Error("Unknown plot");

    settings.set(
      "workspaceRecords",
      renameWorkspaceRecord(
        settings.get("workspaceRecords"),
        parsed.workspaceId,
        parsed.name,
      ),
    );
    latestSnapshot = {
      ...latestSnapshot,
      projects: latestSnapshot.projects.map((project) => ({
        ...project,
        workspaces: project.workspaces.map((candidate) =>
          candidate.workspaceId === parsed.workspaceId
            ? { ...candidate, name: parsed.name }
            : candidate,
        ),
      })),
    };
    mainWindow?.webContents.send(ipcChannels.snapshotChanged, latestSnapshot);
  });
  ipcMain.handle(ipcChannels.namedRoutingSetup, async (event) => {
    assertTrustedSender(event);
    // Installs Silvic's own gate: a user launch agent, then the loopback 443
    // redirect and certificate trust behind macOS's native administrator
    // dialog. Silvic never handles the password itself.
    await gate.setup();
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
    // Deletion is authoritative, so the plot leaves the canvas as soon as its
    // worktree is gone. Asking every connector again is worth doing and worth
    // nobody's wait: it happens behind the answer and publishes itself.
    const removed = results.some(
      (step) => step.id === "worktree" && step.status === "done",
    );
    if (removed) {
      // The plot is gone for good, so its named routes must not keep waking
      // it; this is the one moment a route identity is truly deleted.
      void forgetPlotRoutes(project.rootPath, workspace.path, workspace.branch);
      publishSnapshot(
        withoutWorkspace(latestSnapshot, workspace.path),
        "replace",
      );
    }
    void refreshSnapshot(true);
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
        recipe: suggestRecipe(findings),
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
  ipcMain.handle(ipcChannels.updateStateGet, (event) => {
    assertTrustedSender(event);
    return knownUpdater().getState();
  });
  ipcMain.handle(ipcChannels.updateCheck, async (event) => {
    assertTrustedSender(event);
    return knownUpdater().check();
  });
  ipcMain.handle(ipcChannels.updateDownload, async (event) => {
    assertTrustedSender(event);
    return knownUpdater().download();
  });
  ipcMain.handle(ipcChannels.updateMoveToApplications, (event) => {
    assertTrustedSender(event);
    return moveApplicationToApplicationsFolder();
  });
  ipcMain.handle(ipcChannels.updateInstall, (event) => {
    assertTrustedSender(event);
    knownUpdater().install();
  });
}

function knownUpdater(): DesktopUpdater {
  if (!desktopUpdater) throw new Error("Silvic's updater is not ready");
  return desktopUpdater;
}

function publishUpdateState(state: AppUpdateState): void {
  mainWindow?.webContents.send(ipcChannels.updateStateChanged, state);
  installApplicationMenu();
}

function installApplicationMenu(): void {
  if (process.platform !== "darwin" || !desktopUpdater) return;
  const updates = updateMenuPresentations(desktopUpdater.getState());
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        ...updates.map((update) => ({
          label: update.label,
          enabled: update.enabled,
          click: () => {
            if (update.action) void performUpdateMenuAction(update.action);
          },
        })),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "File", submenu: [{ role: "close" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function performUpdateMenuAction(
  action: UpdateMenuAction,
): Promise<void> {
  switch (action) {
    case "relocate":
      moveApplicationToApplicationsFolder();
      return;
    case "check":
      await knownUpdater().check();
      return;
    case "download":
      await knownUpdater().download();
      return;
    case "install":
      knownUpdater().install();
  }
}

function moveApplicationToApplicationsFolder(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  if (app.isInApplicationsFolder()) return true;
  try {
    return app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        const options = {
          type: "warning" as const,
          title: "Install Silvic",
          message:
            conflictType === "existsAndRunning"
              ? "Silvic is already running from Applications"
              : "Silvic already exists in Applications",
          detail:
            conflictType === "existsAndRunning"
              ? "Use the installed copy and close this disk-image copy?"
              : "Replace the installed copy? macOS will move it to Trash.",
          buttons: ["Cancel", "Continue"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const response = mainWindow
          ? dialog.showMessageBoxSync(mainWindow, options)
          : dialog.showMessageBoxSync(options);
        return response === 1;
      },
    });
  } catch (error) {
    knownUpdater().reportError(error);
    return false;
  }
}

function scheduleAutomaticUpdateChecks(): void {
  if (
    desktopUpdater &&
    ["unsupported", "relocation-required"].includes(
      desktopUpdater.getState().phase,
    )
  ) {
    return;
  }
  // Every start asks, so a Silvic that is opened daily is never more than a
  // day behind — and one left running for a week still catches up.
  void desktopUpdater?.check();
  const recurringCheck = setInterval(
    () => void desktopUpdater?.check(),
    4 * 60 * 60 * 1_000,
  );
  recurringCheck.unref();
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

/**
 * Update one remote-tracking branch, best effort. Being offline is not a
 * reason to refuse to show the pull request that was asked for; the branch
 * this clone already has is then what taking it up would open, and a branch
 * it has never seen fails loudly at creation instead.
 */
async function branchReachable(
  rootPath: string,
  branch: string,
): Promise<boolean> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const result = await runner.run({
      executable: "git",
      arguments: ["rev-parse", "--verify", "--quiet", ref],
      cwd: rootPath,
    });
    if (result.exitCode === 0) return true;
  }
  return false;
}

async function fetchBranch(rootPath: string, branch: string): Promise<void> {
  await runner.run({
    executable: "git",
    arguments: [
      "fetch",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    cwd: rootPath,
  });
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
const runtimeStepId = "runtime";
const readinessStepId = "readiness";
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
  const address = addressFor(recipe, plot, port);
  await requireNamedRouting(address);
  const url = address.url;
  const autoCommands = Object.values(recipe.commands).filter(
    (command) => command.autoStart,
  );
  const servesAddress = autoCommands.some((command) => command.url === true);

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
      ...(autoCommands.length > 0
        ? [{ id: runtimeStepId, label: "Start plot runtimes" }]
        : []),
      ...(servesAddress
        ? [{ id: readinessStepId, label: "Wait for the preview" }]
        : []),
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
        adoption: {
          status: "adopted",
          at: new Date().toISOString(),
          attempt: 1,
        },
        ...(request.task
          ? { purpose: request.task.title, task: request.task }
          : {}),
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
        port,
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
    const online = provisionCompleted(recipe.provision, provision)
      ? await bringPlotOnline({
          plotPath: destinationPath,
          commands: recipe.commands,
          url,
          progress,
        })
      : blockedPlotStartup(
          "Provisioning did not complete, so runtimes were not started.",
        );
    void refreshSnapshot(true);
    return {
      snapshot: latestSnapshot,
      plot: { name: plot, path: destinationPath, port, url },
      provision,
      ...online,
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
): Promise<PlotProvisionRunResult> {
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
  const plot = plotNameIn(
    workspace.path,
    recipe.project,
    workspace.isPrimary ? undefined : workspace.git.branch,
  );
  const port =
    storedPlotPort(workspace.path) ??
    plotPort(recipe.project, plot, takenPlotPorts());
  // Adoption and a manual retry both claim the route before running anything.
  // A crash or failed provider step therefore cannot change the address later.
  settings.set("plotPorts", {
    ...settings.get("plotPorts"),
    [workspace.path]: port,
  });
  const address = addressFor(recipe, plot, port);
  await requireNamedRouting(address);
  const autoCommands = Object.values(recipe.commands).filter(
    (command) => command.autoStart,
  );
  const servesAddress = autoCommands.some((command) => command.url === true);
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
      ...(autoCommands.length > 0
        ? [{ id: runtimeStepId, label: "Start plot runtimes" }]
        : []),
      ...(servesAddress
        ? [{ id: readinessStepId, label: "Wait for the preview" }]
        : []),
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
        return {
          provision: [repair],
          ...blockedPlotStartup(
            "The repair did not complete, so runtimes were not started.",
          ),
        };
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
        url: address.url,
        port,
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
    const online = provisionCompleted(recipe.provision, provision)
      ? await bringPlotOnline({
          plotPath: workspace.path,
          commands: recipe.commands,
          url: address.url,
          progress,
        })
      : blockedPlotStartup(
          "Provisioning did not complete, so runtimes were not started.",
        );
    void refreshSnapshot(true);
    return { provision: results, ...online };
  } catch (error) {
    progress.stumbled(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    progress.settled();
  }
}

async function planPlotAdoption(
  request: PlotAdoptionPlanRequest,
): Promise<PlotAdoptionPlan> {
  const project = latestSnapshot.projects.find((candidate) =>
    candidate.workspaces.some(
      (workspace) => workspace.workspaceId === request.workspaceId,
    ),
  );
  if (!project) throw new Error("Choose a discovered worktree");
  const recipe = await readRecipe(project.rootPath);
  const claimed = takenPlotPorts();
  return buildAdoptionPlan({
    project,
    selectedWorkspaceId: request.workspaceId,
    scope: request.scope,
    steps: recipe.provision,
    member: (workspace) => {
      const plot = plotNameIn(workspace.path, recipe.project, workspace.branch);
      const stored = storedPlotPort(workspace.path);
      const port = stored ?? plotPort(recipe.project, plot, claimed);
      claimed.add(port);
      return {
        port,
        url: addressFor(recipe, plot, port).url,
      };
    },
  });
}

async function adoptPlots(
  request: PlotAdoptionRunRequest,
): Promise<PlotAdoptionRunResult> {
  const plan = await planPlotAdoption(request);
  if (plan.requiresProviderConfirmation && !request.confirmProviderChanges) {
    throw new Error(
      "Confirm the listed provider changes before adopting these plots",
    );
  }
  const members = await executeAdoption({
    members: plan.members,
    state: workspaceAdoption,
    persist: setWorkspaceAdoption,
    run: async (member) => {
      // Claim exactly the route shown in the preview before provisioning.
      settings.set("plotPorts", {
        ...settings.get("plotPorts"),
        [member.path]: member.port,
      });
      const result = await provisionPlot({ path: member.path });
      const failed = result.provision.find((step) => step.exitCode !== 0);
      if (failed) throw new Error(`${failed.label} failed`);
      if (result.runtime.status === "failed") {
        throw new Error(
          result.runtime.detail ?? "Plot runtimes failed to start",
        );
      }
      if (result.readiness.status === "failed") {
        throw new Error(
          result.readiness.detail ?? "Plot preview did not become ready",
        );
      }
      return {
        provision: result.provision,
        runtime: result.runtime,
        readiness: result.readiness,
      };
    },
  });
  await paintFromGit(plan.members.map((member) => member.path));
  void refreshSnapshot(true);
  return { members };
}

function workspaceAdoption(workspaceId: string): PlotAdoption | undefined {
  return settings
    .get("workspaceRecords")
    .find((record) => record.workspaceId === workspaceId)?.adoption;
}

function setWorkspaceAdoption(
  workspaceId: string,
  adoption: PlotAdoption,
): void {
  const records = settings.get("workspaceRecords");
  if (!records.some((record) => record.workspaceId === workspaceId)) {
    throw new Error("Unknown discovered worktree");
  }
  settings.set(
    "workspaceRecords",
    records.map((record) =>
      record.workspaceId === workspaceId ? { ...record, adoption } : record,
    ),
  );
  latestSnapshot = {
    ...latestSnapshot,
    projects: latestSnapshot.projects.map((project) => ({
      ...project,
      workspaces: project.workspaces.map((workspace) =>
        workspace.workspaceId === workspaceId
          ? { ...workspace, adoption }
          : workspace,
      ),
    })),
  };
  mainWindow?.webContents.send(ipcChannels.snapshotChanged, latestSnapshot);
}

/**
 * Commands that should have outlived the last quit but did not — an update
 * restarted the machine's processes, or something crashed the group — are
 * started again instead of sitting as ghosts. Running until Stop is the
 * promise keepCommandsRunning makes; reviving is what keeps it after the
 * process is gone.
 */
async function revivePlotCommands(
  previous: readonly SupervisedCommand[],
): Promise<void> {
  if (!settings.get("keepCommandsRunning")) return;
  const alive = new Set(
    supervisor
      .list()
      .map((entry) => `${normalize(entry.plotPath)}::${entry.id}`),
  );
  for (const entry of previous) {
    if (entry.status !== "running" && entry.status !== "starting") continue;
    if (alive.has(`${normalize(entry.plotPath)}::${entry.id}`)) continue;
    try {
      // Not interactive: nobody asked just now, so no surprise admin dialog.
      await startPlotCommand(entry.plotPath, entry.id, false);
    } catch {
      // A plot that no longer exists has nothing to revive.
    }
  }
}

/**
 * Someone visited a sleeping plot's URL. The gate names the owner; Silvic
 * answers by starting what the plot declares, exactly as Start would.
 * Right after launch the snapshot may still be loading, so an unknown plot
 * is retried briefly rather than dropped.
 */
async function wakePlotFromGate(wake: GateWake): Promise<void> {
  const plotPath =
    wake.plotPath ??
    (await gate.client.status())?.routes.find(
      (route) => route.name === wake.route,
    )?.plotPath;
  if (!plotPath) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const workspace = knownWorkspace(plotPath);
      const project = latestSnapshot.projects.find((candidate) =>
        candidate.workspaces.some(
          (entry) => entry.workspaceId === workspace.workspaceId,
        ),
      );
      if (!project) throw new Error("The plot's project is not loaded yet");
      const recipe = await readRecipe(project.rootPath);
      await startAutoCommands(workspace.path, recipe.commands);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

function recoverPlotFromGate(failure: GateFailure): void {
  supervisor.reportRouteFailure(failure.route, failure.failure);
}

/** `open -b dev.silvic.app --args --silvic-wake=<route>`, from the gate. */
function handleWakeArguments(argv: readonly string[]): void {
  for (const argument of argv) {
    if (argument.startsWith("--silvic-wake=")) {
      void wakePlotFromGate({
        route: argument.slice("--silvic-wake=".length),
      });
    }
  }
}

/** Deletes the named routes a torn-down plot registered with the gate. */
async function forgetPlotRoutes(
  projectRoot: string,
  plotPath: string,
  branch?: string,
): Promise<void> {
  try {
    const recipe = await readRecipe(projectRoot);
    const plot = plotNameIn(plotPath, recipe.project, branch);
    for (const [id, command] of Object.entries(recipe.commands)) {
      if (!routes(command)) continue;
      await gate.removeRoute(
        routeNameFor(
          {
            id,
            ...(command.routeName ? { routeName: command.routeName } : {}),
          },
          plot,
          recipe.project,
        ),
      );
    }
  } catch {
    // A stale route only costs a wake attempt against a missing plot.
  }
}

async function startAutoCommands(
  plotPath: string,
  commands: Readonly<Record<string, PlotCommand>>,
): Promise<PlotRuntimeStart> {
  const declared = Object.entries(commands).filter(
    ([, command]) => command.autoStart,
  );
  if (declared.length === 0) {
    return {
      status: "not-required",
      durationMs: 0,
      detail: "This repository declares no auto-starting runtimes.",
    };
  }

  const startedAt = Date.now();
  const failures = new Map<string, string>();
  for (const [id] of declared) {
    try {
      await startPlotCommand(plotPath, id);
    } catch (error) {
      failures.set(id, error instanceof Error ? error.message : String(error));
    }
  }

  // Spawn succeeding only proves that the process existed. Commands that are
  // misconfigured usually exit immediately, so give every declared runtime a
  // short settling window before calling the Plot ready.
  await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  return runtimeStartResult({
    commands: declared.map(([id]) => id),
    processes: supervisor
      .list()
      .filter((process) => normalize(process.plotPath) === normalize(plotPath)),
    failures: Object.fromEntries(failures),
    durationMs: Date.now() - startedAt,
  });
}

function blockedPlotStartup(detail: string): {
  runtime: PlotRuntimeStart;
  readiness: PlotReadiness;
} {
  return {
    runtime: { status: "not-required", durationMs: 0, detail },
    readiness: {
      status: "not-required",
      durationMs: 0,
      detail: "Preview readiness was not checked.",
    },
  };
}

async function bringPlotOnline({
  plotPath,
  commands,
  url,
  progress,
}: {
  plotPath: string;
  commands: Readonly<Record<string, PlotCommand>>;
  url: string;
  progress: PlotProgressReporter;
}): Promise<{ runtime: PlotRuntimeStart; readiness: PlotReadiness }> {
  const autoCommands = Object.entries(commands).filter(
    ([, command]) => command.autoStart,
  );
  let runtime: PlotRuntimeStart = {
    status: "not-required",
    durationMs: 0,
    detail: "This repository declares no auto-starting runtimes.",
  };
  if (autoCommands.length > 0) {
    progress.began(runtimeStepId);
    runtime = await startAutoCommands(plotPath, commands);
    if (runtime.status === "failed") {
      progress.failed(
        runtimeStepId,
        runtime.detail ?? "A runtime failed during startup",
      );
    } else {
      progress.finished(runtimeStepId, runtime.durationMs);
    }
  }

  const servingCommands = autoCommands.filter(
    ([, command]) => command.url === true,
  );
  if (servingCommands.length === 0) {
    return {
      runtime,
      readiness: {
        status: "not-required",
        durationMs: 0,
        detail: "This repository declares no auto-starting preview command.",
      },
    };
  }

  progress.began(readinessStepId);
  const failedPreviewCommands = servingCommands
    .map(([id]) => id)
    .filter((id) => runtime.failedCommands?.includes(id));
  const readiness: PlotReadiness =
    failedPreviewCommands.length > 0
      ? {
          status: "failed",
          durationMs: 0,
          detail: `Preview runtimes stopped during startup: ${failedPreviewCommands.join(", ")}`,
        }
      : await waitForReadiness({
          url,
          probe: async (target) => {
            const processes = new Map(
              supervisor
                .list()
                .filter(
                  (process) =>
                    normalize(process.plotPath) === normalize(plotPath),
                )
                .map((process) => [process.id, process]),
            );
            const failed = servingCommands
              .map(([id]) => processes.get(id))
              .find((process) => process?.status === "failed");
            if (failed) {
              throw new Error(
                failed.advice ??
                  `The preview runtime exited with code ${failed.exitCode ?? 1}`,
              );
            }
            // A named runtime is "starting" until its actual listener and
            // Portless alias have both answered. This prevents Portless's own
            // missing-route 404 from becoming a false-positive readiness.
            if (
              servingCommands.some(
                ([id]) => processes.get(id)?.status !== "running",
              )
            ) {
              return false;
            }
            return probePreview(target);
          },
        });
  if (readiness.status === "ready") {
    progress.finished(readinessStepId, readiness.durationMs);
  } else {
    progress.failed(readinessStepId, readiness.detail ?? "Preview failed");
  }
  return { runtime, readiness };
}

/** A response below 500 means the local preview itself is reachable. */
function probePreview(url: string): Promise<boolean> {
  const target = new URL(url);
  const localTls =
    target.protocol === "https:" &&
    (target.hostname === "localhost" || target.hostname.endsWith(".localhost"));
  const options: HttpRequestOptions & { rejectUnauthorized?: boolean } = {
    protocol: target.protocol,
    hostname: target.hostname,
    ...(target.port ? { port: target.port } : {}),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    headers: { connection: "close" },
    ...(localTls ? { rejectUnauthorized: false } : {}),
  };

  return new Promise<boolean>((resolve, reject) => {
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(options, (response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      resolve(status >= 200 && status < 500);
    });
    request.setTimeout(2_000, () => {
      request.destroy(new Error("The preview check timed out"));
    });
    request.once("error", reject);
    request.end();
  });
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
async function startPlotCommand(
  path: string,
  id: string,
  /** Whether a person just asked, which may show the admin dialog again. */
  interactive = true,
): Promise<void> {
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
  const plot = plotNameIn(
    workspace.path,
    recipe.project,
    workspace.isPrimary ? undefined : workspace.git.branch,
  );
  const port =
    storedPlotPort(workspace.path) ??
    plotPort(recipe.project, plot, takenPlotPorts());
  const address = addressFor(recipe, plot, port);
  let routeAdvice: string | undefined;
  if (address.named) {
    // Starting a named runtime is the moment the gate must exist: set it up
    // automatically rather than failing with advice to do so by hand. When
    // that fails, the reason goes onto the card instead of a generic hint.
    try {
      await gate.ensureReady({ reprompt: interactive });
    } catch (error) {
      routeAdvice = error instanceof Error ? error.message : String(error);
    }
  }

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
        url: address.url,
        port,
        ...(recipe.packageManager
          ? { packageManager: recipe.packageManager }
          : {}),
      }),
      // Ignored by a routed command: portless hands out its own.
      PORT: String(port),
    },
    canRoute: await gate.available(),
    ...(routeAdvice ? { routeAdvice } : {}),
    detached: settings.get("keepCommandsRunning"),
  });
}

async function automationPlotDefinition(
  project: ProjectSnapshot,
  workspace: WorkspaceSnapshot,
): Promise<{
  commands: Readonly<Record<string, PlotCommand>>;
  previewUrl?: string;
}> {
  const recipe = await readRecipe(project.rootPath);
  const plot = plotNameIn(
    workspace.path,
    recipe.project,
    workspace.isPrimary ? undefined : workspace.git.branch,
  );
  const port =
    storedPlotPort(workspace.path) ??
    plotPort(recipe.project, plot, takenPlotPorts());
  const servesPreview = Object.values(recipe.commands).some(
    (command) => command.url === true,
  );
  return {
    commands: recipe.commands,
    ...(servesPreview
      ? { previewUrl: addressFor(recipe, plot, port).url }
      : {}),
  };
}

/** The commands Silvic has running in a plot, by their recipe ids. */
function supervisedIn(plotPath: string): readonly string[] {
  return supervisor
    .list()
    .filter(
      (entry) =>
        (entry.status === "starting" || entry.status === "running") &&
        normalize(entry.plotPath) === normalize(plotPath),
    )
    .map((entry) => entry.id);
}

function addressFor(
  recipe: ResolvedRecipe,
  plot: string,
  port: number,
): PlotAddress {
  return resolvePlotAddress({
    commands: recipe.commands,
    plot,
    project: recipe.project,
    port,
  });
}

async function namedRoutingIssue(
  address: PlotAddress,
): Promise<string | undefined> {
  if (!address.named) return undefined;
  return gate.issue();
}

async function requireNamedRouting(address: PlotAddress): Promise<void> {
  if (!address.named) return;
  // Creation is explicit, so the setup dialog may appear again — and when
  // setup fails, its concrete reason beats the generic diagnosis.
  await gate.ensureReady({ reprompt: true });
  const issue = await namedRoutingIssue(address);
  if (issue) throw new Error(issue);
}

/**
 * Plots are directories named `<project>-<plot>`; older ones are `<plot>`.
 * Worktrees made by other tools are often named after the repository itself
 * (Codex: `~/.codex/worktrees/<id>/mono`) — that folder says nothing and
 * would collide with the primary checkout's route, so the branch is the
 * speaking identity such a plot falls back to.
 */
function plotNameIn(path: string, project: string, branch?: string): string {
  const folder = basename(path);
  const stripped = folder.startsWith(`${project}-`)
    ? folder.slice(project.length + 1)
    : folder;
  if ((stripped === project || stripped.length === 0) && branch) return branch;
  return stripped;
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

function installRootWatchers(): void {
  rootWatchers.forEach((watcher) => watcher.close());
  rootWatchers = [];
  for (const root of settings.get("roots")) {
    try {
      const watcher = watch(
        root,
        { recursive: true, persistent: false },
        (_event, filename) => {
          const changedPath = filename ? join(root, filename.toString()) : root;
          if (ignoredFilesystemEvent(changedPath)) return;
          pendingFilesystemPaths.add(normalize(changedPath));
          scheduleFilesystemRefresh();
        },
      );
      watcher.on("error", () => undefined);
      rootWatchers.push(watcher);
    } catch {
      // An offline or unsupported root remains available to explicit refresh.
    }
  }
}

/**
 * A process change invalidates the expensive lsof shelf immediately, but the
 * resulting local observation still has to reach the renderer. Refresh only
 * the affected workspaces and only this connector: a Stop must not leave a
 * ghost `node :port` row, and it must not wake GitHub or Convex to remove it.
 */
function scheduleRuntimeObservationRefresh(): void {
  if (runtimeObservationRefreshTimer) {
    clearTimeout(runtimeObservationRefreshTimer);
  }
  runtimeObservationRefreshTimer = setTimeout(() => {
    runtimeObservationRefreshTimer = undefined;
    void refreshRuntimeObservations();
  }, 350);
}

async function refreshRuntimeObservations(): Promise<void> {
  const paths = new Set(pendingRuntimeObservationPaths);
  pendingRuntimeObservationPaths.clear();
  if (paths.size === 0 || latestSnapshot.projects.length === 0) return;
  const failures: { connectorId: string; message: string }[] = [];
  const projects = await Promise.all(
    latestSnapshot.projects.map(async (project) => ({
      ...project,
      workspaces: await Promise.all(
        project.workspaces.map(async (workspace) => {
          if (!paths.has(normalize(workspace.path))) return workspace;
          const result = await localContextRegistry.observe({
            ...workspace,
            ...(project.origin ? { origin: project.origin } : {}),
          });
          failures.push(...result.failures);
          return {
            ...workspace,
            observations: [
              ...workspace.observations.filter(
                (observation) => observation.connectorId !== "local-context",
              ),
              ...result.observations,
            ],
          };
        }),
      ),
    })),
  );
  publishSnapshot(
    {
      projects,
      connectorFailures: [
        ...latestSnapshot.connectorFailures.filter(
          (failure) => failure.connectorId !== "local-context",
        ),
        ...failures,
      ],
      refreshedAt: new Date().toISOString(),
    },
    "replace",
  );
}

function ignoredFilesystemEvent(path: string): boolean {
  const segments = normalize(path).split("/");
  if (
    segments.some((segment) =>
      new Set([
        ".build",
        ".cache",
        ".next",
        ".pnpm-store",
        "DerivedData",
        "node_modules",
        "Pods",
        "vendor",
      ]).has(segment),
    )
  ) {
    return true;
  }
  const gitIndex = segments.lastIndexOf(".git");
  return (
    gitIndex >= 0 && ["logs", "objects"].includes(segments[gitIndex + 1] ?? "")
  );
}

function scheduleFilesystemRefresh(): void {
  if (!rendererVisible) return;
  if (filesystemRefreshTimer) clearTimeout(filesystemRefreshTimer);
  filesystemRefreshTimer = setTimeout(() => {
    filesystemRefreshTimer = undefined;
    void flushFilesystemRefresh();
  }, 750);
}

async function flushFilesystemRefresh(): Promise<void> {
  if (!rendererVisible || pendingFilesystemPaths.size === 0) return;
  if (filesystemRefreshTimer) {
    clearTimeout(filesystemRefreshTimer);
    filesystemRefreshTimer = undefined;
  }
  const changed = [...pendingFilesystemPaths];
  pendingFilesystemPaths.clear();
  if (activeRefresh) {
    try {
      await activeRefresh;
    } catch {
      // The targeted read below gets its own chance to recover.
    }
  }
  const affected = latestSnapshot.projects.filter((project) =>
    changed.some((path) =>
      project.workspaces.some((workspace) =>
        containsPath(workspace.path, path),
      ),
    ),
  );
  if (affected.length === 0) {
    if (changed.some((path) => normalize(path).split("/").includes(".git"))) {
      await refreshSnapshot(true);
    }
    return;
  }
  try {
    const rawSnapshot = await projectService.snapshot(
      affected.map((project) => project.rootPath),
      {
        force: true,
        enrichProjectIds: new Set<string>(),
      },
    );
    publishSnapshot(rawSnapshot, "merge");
  } catch {
    // A later filesystem event or explicit refresh retries the survey.
  }
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(normalize(parent), normalize(child));
  return (
    relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
  );
}

async function refreshConnectorObservations(): Promise<void> {
  const active = new Set(settings.get("activeProjects"));
  const failures: { connectorId: string; message: string }[] = [];
  const projects = await Promise.all(
    latestSnapshot.projects.map(async (project) => {
      if (!active.has(project.id)) return project;
      const workspaces = await Promise.all(
        project.workspaces.map(async (workspace) => {
          const result = await connectors.observe({
            ...workspace,
            ...(project.origin ? { origin: project.origin } : {}),
          });
          failures.push(...result.failures);
          return { ...workspace, observations: result.observations };
        }),
      );
      return { ...project, workspaces };
    }),
  );
  publishSnapshot(
    {
      projects,
      connectorFailures: uniqueConnectorFailures(failures),
      refreshedAt: new Date().toISOString(),
    },
    "replace",
  );
}

function uniqueConnectorFailures(
  failures: readonly { connectorId: string; message: string }[],
): { connectorId: string; message: string }[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.connectorId}:${failure.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function refreshSnapshot(forceFresh = false): Promise<SilvicSnapshot> {
  // Forced means something happened: connectors must look again rather than
  // answer from their shelf.
  if (forceFresh) connectors.invalidate();
  if (activeRefresh) {
    if (!forceFresh) return activeRefresh;
    if (!queuedFreshRefresh) {
      queuedFreshRefresh = activeRefresh
        .then(
          () => startSnapshotRefresh(true),
          () => startSnapshotRefresh(true),
        )
        .finally(() => {
          queuedFreshRefresh = undefined;
        });
    }
    return queuedFreshRefresh;
  }
  return startSnapshotRefresh(forceFresh);
}

function startSnapshotRefresh(forceFresh: boolean): Promise<SilvicSnapshot> {
  const refresh = projectService
    .snapshot(settings.get("roots"), {
      force: forceFresh,
      enrichProjectIds: new Set(settings.get("activeProjects")),
    })
    .then((rawSnapshot) => publishSnapshot(rawSnapshot, "replace"));
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
  mode: "replace" | "merge",
): SilvicSnapshot {
  const provisionedPaths = new Set(
    Object.keys(settings.get("plotProvisioning")).map(normalize),
  );
  // Pre-adoption releases already persisted discovered workspaces. Preserve
  // the meaning of those that have a provisioning record during migration;
  // the registry marks every other external worktree as not adopted.
  const existingRecords = settings.get("workspaceRecords").map((record) =>
    !record.adoption && provisionedPaths.has(normalize(record.path))
      ? {
          ...record,
          adoption: {
            status: "adopted" as const,
            at: new Date().toISOString(),
            attempt: 1,
          },
        }
      : record,
  );
  const reconciled = workspaceRegistry.reconcile(rawSnapshot, existingRecords);
  if (
    !workspaceRecordsEqual(settings.get("workspaceRecords"), reconciled.records)
  ) {
    settings.set("workspaceRecords", [...reconciled.records]);
  }
  const decorated = withProvisioning(reconciled.snapshot);
  const candidate =
    mode === "merge" ? mergeSnapshots(latestSnapshot, decorated) : decorated;
  if (snapshotsSemanticallyEqual(latestSnapshot, candidate)) {
    return latestSnapshot;
  }
  latestSnapshot = candidate;
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
    const rawSnapshot = await fastProjectService.snapshot(paths, {
      force: true,
    });
    publishSnapshot(rawSnapshot, mode);
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
async function knownLinkUrl(url: string): Promise<string> {
  const known =
    latestSnapshot.projects.some(
      (project) =>
        project.remoteUrl === url ||
        project.workspaces.some(
          (workspace) =>
            workspace.task?.issue?.url === url ||
            workspace.observations.some(
              (observation) => observation.url === url,
            ),
        ),
    ) ||
    // An address Silvic published itself by starting a command. It was never
    // observed, because it exists on Silvic's say-so.
    supervisor.list().some((entry) => entry.url === url);
  if (known) return url;
  for (const project of latestSnapshot.projects) {
    const recipe = await readRecipe(project.rootPath);
    if (
      Object.values(recipe.resources).some(
        (resource) => resource.url === url || resource.dashboardUrl === url,
      )
    ) {
      return url;
    }
  }
  throw new Error("Silvic can only open a discovered or declared link");
}

async function openExternalLink(url: string): Promise<void> {
  // Electron's generic development bundle can lose LaunchServices URL handoffs.
  // Keep packaged builds on the user's configured default browser.
  if (platform() === "darwin" && !app.isPackaged) {
    try {
      const result = await runner.run({
        executable: "open",
        arguments: ["-b", "com.google.Chrome", url],
      });
      if (result.exitCode === 0) return;
    } catch {
      // Chrome is optional. Preserve the system-default browser fallback.
    }
  }
  await shell.openExternal(url, { activate: true });
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
