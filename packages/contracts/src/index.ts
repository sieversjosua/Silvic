import { z } from "zod";

export const connectorManifestSchema = z
  .object({
    id: z
      .string()
      .max(80)
      .regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    kind: z.enum(["service", "harness"]),
    capabilities: z
      .array(z.enum(["observe", "open", "provision"]))
      .min(1)
      .max(3),
  })
  .strict();

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;
export type ConnectorObservationKind =
  "runtime" | "deployment" | "review" | "session" | "authentication";
export type ConnectorObservationState =
  "active" | "ready" | "waiting" | "attention" | "quiet" | "unknown";

export interface WorkspaceTarget {
  workspaceId: string;
  projectId: string;
  path: string;
  repositoryName: string;
  branch: string;
}

export interface ConnectorObservation {
  connectorId: string;
  workspaceId: string;
  kind: ConnectorObservationKind;
  state: ConnectorObservationState;
  label: string;
  detail?: string | undefined;
  url?: string | undefined;
  metadata?:
    | Readonly<Record<string, string | number | boolean | readonly number[]>>
    | undefined;
}

export const connectorObservationSchema = z
  .object({
    connectorId: z
      .string()
      .max(80)
      .regex(/^[a-z][a-z0-9-]*$/),
    workspaceId: z.string().min(1).max(200),
    kind: z.enum([
      "runtime",
      "deployment",
      "review",
      "session",
      "authentication",
    ]),
    state: z.enum([
      "active",
      "ready",
      "waiting",
      "attention",
      "quiet",
      "unknown",
    ]),
    label: z.string().min(1).max(500),
    detail: z.string().max(2_000).optional(),
    url: z
      .url()
      .max(4_000)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
      .optional(),
    metadata: z
      .record(
        z.string().max(120),
        z.union([
          z.string().max(2_000),
          z.number().finite(),
          z.boolean(),
          z.array(z.number().int()).max(32),
        ]),
      )
      .refine((value) => Object.keys(value).length <= 50)
      .optional(),
  })
  .strict();

export interface ConnectorContext {
  signal?: AbortSignal;
}

export interface Connector {
  readonly manifest: ConnectorManifest;
  /** Discard observations cached by this connector before the next scan. */
  invalidate?(): void;
  observe(
    target: WorkspaceTarget,
    context?: ConnectorContext,
  ): Promise<readonly ConnectorObservation[]>;
}

export interface HarnessDefinition {
  id:
    | "codex"
    | "claude"
    | "t3-code"
    | "opencode"
    | "vscode"
    | "terminal"
    | "finder";
  name: string;
  kind: "application" | "command" | "system";
  applicationName?: string;
  applicationNames?: readonly string[];
  executable?: string;
}

export interface ConnectorFailure {
  connectorId: string;
  message: string;
}

export interface ConnectorResult {
  observations: readonly ConnectorObservation[];
  failures: readonly ConnectorFailure[];
}

/** External work that can seed a Task and its first Plot. */
export interface IssueSummary {
  provider: "github";
  number: number;
  title: string;
  body: string;
  url: string;
  labels: readonly string[];
  assignees: readonly string[];
}

export const issueSummarySchema = z
  .object({
    provider: z.literal("github"),
    number: z.number().int().positive(),
    title: z.string().min(1).max(500),
    body: z.string().max(50_000),
    url: z.url().max(4_000),
    labels: z.array(z.string().min(1).max(120)).max(100),
    assignees: z.array(z.string().min(1).max(120)).max(100),
  })
  .strict();

export const taskContextSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(50_000).optional(),
    issue: issueSummarySchema.optional(),
  })
  .strict();
export type TaskContext = z.infer<typeof taskContextSchema>;

export type WorkspaceLocationKind = "checkout" | "worktree";

export interface GitStatus {
  branch: string;
  revision?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface WorkspaceSnapshot extends WorkspaceTarget {
  name: string;
  purpose?: string;
  /** Why this Workspace exists, independent of its branch or location. */
  task?: TaskContext;
  locationKind: WorkspaceLocationKind;
  isPrimary: boolean;
  git: GitStatus;
  observations: readonly ConnectorObservation[];
  /** The last provisioning run, absent for plots made before it was recorded. */
  provisioning?: PlotProvisioning;
  lineage?: {
    parentWorkspaceId: string;
    evidence: "recorded" | "inferred";
  };
}

export interface ProjectSnapshot {
  id: string;
  name: string;
  rootPath: string;
  origin?: string;
  /** Browsable address of the origin, when one can be derived. */
  remoteUrl?: string;
  workspaces: readonly WorkspaceSnapshot[];
  /**
   * Every local branch. Carried so naming a new plot can be answered in the
   * interface as it is typed, rather than by asking Git across a process
   * boundary between one keystroke and the next.
   */
  branches: readonly string[];
  /**
   * Every remote-tracking branch, as `origin/feature-x`. Somebody else's work
   * is a plot waiting to happen, and nobody remembers its exact name.
   */
  remoteBranches: readonly string[];
}

export interface SilvicSnapshot {
  projects: readonly ProjectSnapshot[];
  connectorFailures: readonly ConnectorFailure[];
  refreshedAt: string;
}

export const harnessIdSchema = z.enum([
  "codex",
  "claude",
  "t3-code",
  "opencode",
  "vscode",
  "terminal",
  "finder",
]);
export type HarnessId = z.infer<typeof harnessIdSchema>;

export const openWorkspaceRequestSchema = z
  .object({
    path: z.string().min(1),
    target: z.enum([
      "codex",
      "claude",
      "t3-code",
      "opencode",
      "vscode",
      "terminal",
      "finder",
    ]),
  })
  .strict();
export type OpenWorkspaceRequest = z.infer<typeof openWorkspaceRequestSchema>;

/**
 * The optional `silvic.json` at a repository root. Every field has a working
 * default, so a repository with no recipe still produces a usable Plot.
 */
export const shellStepSchema = z
  .object({
    run: z.string().min(1).max(2_000),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * A typed step Silvic understands well enough to show and validate, rather than
 * an opaque shell string. Team and project are optional: when absent they are
 * read from the source checkout's CONVEX_DEPLOYMENT comment.
 */
export const convexStepSchema = z
  .object({
    convex: z
      .object({
        team: z.string().min(1).max(120).optional(),
        project: z.string().min(1).max(120).optional(),
        /** Deployment name; `{plot}` is replaced with the plot's name. */
        name: z.string().min(1).max(200).default("dev/{plot}"),
        /** Optional Convex expiration expression, for example `in 7 days`. */
        expiration: z.string().min(1).max(120).optional(),
      })
      .strict(),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();

/**
 * A typed step that points a plot at a local WorkOS emulator instead of a real
 * WorkOS environment. Silvic owns the wiring — the `WORKOS_*` overrides land in
 * the plot's private `.env.local` — while the emulator itself runs as an
 * ordinary recipe command, supervised and visible like any other.
 */
export const workosStepSchema = z
  .object({
    workos: z
      .object({
        /** Emulator port; derived from the plot's own port when left out. */
        port: z.number().int().min(1024).max(65_535).optional(),
        /** Appended to the plot address to form the app's redirect URI. */
        callbackPath: z
          .string()
          .min(1)
          .max(400)
          .startsWith("/")
          .default("/callback"),
      })
      .strict(),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();

export const provisionStepSchema = z.union([
  shellStepSchema,
  convexStepSchema,
  workosStepSchema,
]);
export type ShellStep = z.infer<typeof shellStepSchema>;
export type ConvexStep = z.infer<typeof convexStepSchema>;
export type WorkosStep = z.infer<typeof workosStepSchema>;
export type ProvisionStep = z.infer<typeof provisionStepSchema>;

export function isConvexStep(step: ProvisionStep): step is ConvexStep {
  return "convex" in step;
}

export function isWorkosStep(step: ProvisionStep): step is WorkosStep {
  return "workos" in step;
}

export const packageManagerSchema = z.enum(["bun", "pnpm", "npm", "yarn"]);
export type PackageManager = z.infer<typeof packageManagerSchema>;

export interface RepositoryFindings {
  packageManager?: PackageManager;
  devScript?: string;
  convex: boolean;
  workConfig: boolean;
  envExample?: string;
  /** A seed file for the WorkOS emulator, when the repository carries one. */
  workosSeed?: string;
  /** The repository's own scripts, so suggestions can be its own words. */
  scripts?: Readonly<Record<string, string>>;
  /** Provider SDKs or scripts found without reading credential values. */
  providers?: readonly PlotResourceProvider[];
}

/**
 * A step or command Silvic proposes because of what it found in the
 * repository. Offered one at a time rather than as a whole recipe, since most
 * repositories already have some of it.
 */
export interface RecipeSuggestion {
  id: string;
  label: string;
  /** What it would actually run, shown so nothing is added blind. */
  detail: string;
  step?: ProvisionStep;
  command?: { id: string; command: PlotCommand };
  /**
   * Offered in the editor but never assumed into the inferred recipe: taking
   * it changes how the plot behaves rather than describing what the
   * repository already does.
   */
  optIn?: boolean;
}

/** What Silvic read in a repository, and what it makes of it. */
export interface RepositoryReading {
  findings: RepositoryFindings;
  steps: readonly RecipeSuggestion[];
  commands: readonly RecipeSuggestion[];
  /** The same complete inference used when no silvic.json exists. */
  recipe: Recipe;
}

export const plotCommandSchema = z
  .object({
    run: z.string().min(1).max(2_000),
    /** Working directory relative to the plot root. */
    cwd: z.string().min(1).max(400).optional(),
    /** Additional variables declared by the repository for this command. */
    env: z
      .record(z.string().max(120), z.string().max(4_000))
      .refine((value) => Object.keys(value).length <= 50)
      .optional(),
    /** Serves the plot's canonical browser and auth address. */
    url: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    /** First segment of that name; the command's id when left out. */
    routeName: z.string().min(1).max(60).optional(),
    /** Named HTTPS routing is the default; false keeps the stable port URL. */
    portless: z.boolean().optional(),
  })
  .strict();
export type PlotCommand = z.infer<typeof plotCommandSchema>;

export const plotResourceProviderSchema = z.enum([
  "web",
  "convex",
  "livekit",
  "stripe",
  "cloudflare",
  "vercel",
  "clerk",
  "workos",
  "github",
  "custom",
]);
export type PlotResourceProvider = z.infer<typeof plotResourceProviderSchema>;
export const plotResourceKindSchema = z.enum([
  "runtime",
  "agent",
  "backend",
  "auth",
  "payments",
  "ingress",
  "deployment",
  "review",
  "service",
]);
export type PlotResourceKind = z.infer<typeof plotResourceKindSchema>;
export const resourceIsolationSchema = z.enum([
  "isolated",
  "namespaced",
  "shared",
  "manual",
]);
export type ResourceIsolation = z.infer<typeof resourceIsolationSchema>;

export const plotResourceDefinitionSchema = z
  .object({
    provider: plotResourceProviderSchema,
    label: z.string().min(1).max(120).optional(),
    kind: plotResourceKindSchema.default("service"),
    isolation: resourceIsolationSchema.default("shared"),
    /** Optional recipe command whose process is this resource's live status. */
    command: z.string().min(1).max(60).optional(),
    url: z.url().max(4_000).optional(),
    dashboardUrl: z.url().max(4_000).optional(),
    detail: z.string().min(1).max(2_000).optional(),
  })
  .strict();
export type PlotResourceDefinition = z.infer<
  typeof plotResourceDefinitionSchema
>;

export const plotResourceProviderCatalog: Readonly<
  Record<
    PlotResourceProvider,
    {
      label: string;
      description: string;
      kind: PlotResourceKind;
      isolation: ResourceIsolation;
    }
  >
> = {
  web: {
    label: "Web",
    description: "A browser-facing runtime",
    kind: "runtime",
    isolation: "isolated",
  },
  convex: {
    label: "Convex",
    description: "An isolated backend deployment",
    kind: "backend",
    isolation: "isolated",
  },
  livekit: {
    label: "LiveKit Agent",
    description: "An agent or worker attached to the Plot",
    kind: "agent",
    isolation: "shared",
  },
  stripe: {
    label: "Stripe",
    description: "Test payments and webhook forwarding",
    kind: "payments",
    isolation: "namespaced",
  },
  cloudflare: {
    label: "Cloudflare",
    description: "A Worker, tunnel or public ingress",
    kind: "ingress",
    isolation: "namespaced",
  },
  vercel: {
    label: "Vercel",
    description: "A shareable Preview Deployment",
    kind: "deployment",
    isolation: "isolated",
  },
  clerk: {
    label: "Clerk",
    description: "Authentication origin and instance",
    kind: "auth",
    isolation: "shared",
  },
  workos: {
    label: "WorkOS",
    description: "Authentication and callback configuration",
    kind: "auth",
    isolation: "shared",
  },
  github: {
    label: "GitHub",
    description: "Issue, pull request and checks",
    kind: "review",
    isolation: "shared",
  },
  custom: {
    label: "Custom",
    description: "Any external service Silvic should track",
    kind: "service",
    isolation: "shared",
  },
};

/** A resource projected for one Plot from its recipe and live evidence. */
export interface PlotResource {
  id: string;
  provider: PlotResourceProvider;
  label: string;
  kind: PlotResourceKind;
  isolation: ResourceIsolation;
  state: ConnectorObservationState;
  detail?: string;
  url?: string;
  dashboardUrl?: string;
  commandId?: string;
}

export const recipeSchema = z
  .object({
    project: z.string().min(1).max(120).optional(),
    packageManager: packageManagerSchema.optional(),
    plots: z
      .object({ directory: z.string().min(1).max(400).optional() })
      .strict()
      .optional(),
    commands: z
      .record(
        z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(60),
        plotCommandSchema,
      )
      .optional(),
    resources: z
      .record(
        z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(60),
        plotResourceDefinitionSchema,
      )
      .optional(),
    provision: z.array(provisionStepSchema).max(50).optional(),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;

/**
 * A repair Silvic can carry out itself. The renderer asks for it by name and
 * never by command: what actually runs is decided in the main process, from
 * the package manager the repository uses.
 */
export const provisionRemedyIdSchema = z.enum(["convex-cli"]);
export type ProvisionRemedyId = z.infer<typeof provisionRemedyIdSchema>;

export interface ProvisionRemedy {
  id: ProvisionRemedyId;
  /** What the button offering it says. */
  label: string;
}

export interface ProvisionResult {
  label: string;
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
  /** Silvic's reading of a failure it recognises, in its own words. */
  advice?: string;
  remedy?: ProvisionRemedy;
}

export const recipeSaveRequestSchema = z
  .object({
    projectId: z.string().min(1).max(400),
    recipe: recipeSchema,
  })
  .strict();
export type RecipeSaveRequest = z.infer<typeof recipeSaveRequestSchema>;

export interface RecipeDocument {
  projectId: string;
  /** Absolute path of the file Silvic reads and writes. */
  path: string;
  exists: boolean;
  recipe: Recipe;
  /** What the recipe resolves to once defaults are applied. */
  resolved: { project: string; directory: string };
}

export const plotPreviewRequestSchema = z
  .object({
    projectId: z.string().min(1).max(400),
    branch: z.string().max(240),
  })
  .strict();
export type PlotPreviewRequest = z.infer<typeof plotPreviewRequestSchema>;

/** What the next plot becomes, computed the same way creation computes it. */
export interface PlotPreview {
  name: string;
  path: string;
  port: number;
  url: string;
  /** Why this plot cannot be created, asked of the repository before trying. */
  conflict?: string;
  /** A local prerequisite that must be satisfied before creation. */
  advice?: string;
}

export const testStepRequestSchema = z
  .object({
    projectId: z.string().min(1).max(400),
    step: shellStepSchema,
  })
  .strict();
export type TestStepRequest = z.infer<typeof testStepRequestSchema>;

export const teardownScopeSchema = z.enum(["stop", "archive", "remove"]);

export const teardownRequestSchema = z
  .object({
    path: z.string().min(1),
    scope: teardownScopeSchema,
    deleteBranch: z.boolean(),
    /** Throw away uncommitted work rather than refusing to remove the plot. */
    discardChanges: z.boolean().default(false),
  })
  .strict();
export type TeardownRequestPayload = z.infer<typeof teardownRequestSchema>;

export const openLinkRequestSchema = z
  .object({
    url: z
      .url()
      .max(4_000)
      .refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  })
  .strict();
export type OpenLinkRequest = z.infer<typeof openLinkRequestSchema>;

export const createEnvironmentRequestSchema = z
  .object({
    sourcePath: z.string().min(1),
    branch: z.string().min(1).max(240),
    mode: z.enum(["worktree", "clone"]),
    /**
     * A branch that already exists, taken up rather than cut: either a local
     * one nothing has checked out, or `origin/feature-x`, which becomes a
     * local branch tracking it. Absent means a new branch, as before.
     */
    adopt: z.string().min(1).max(280).optional(),
    task: taskContextSchema.optional(),
  })
  .strict();
export type CreateEnvironmentRequest = z.infer<
  typeof createEnvironmentRequestSchema
>;

export const issueListRequestSchema = z
  .object({
    projectId: z.string().min(1).max(400),
    query: z.string().trim().max(500).default(""),
  })
  .strict();
export type IssueListRequest = z.infer<typeof issueListRequestSchema>;

export const plotProvisionRequestSchema = z
  .object({
    path: z.string().min(1),
    /** Runs before the recipe, when a failure named a repair Silvic can make. */
    remedy: provisionRemedyIdSchema.optional(),
  })
  .strict();
export type PlotProvisionRequest = z.infer<typeof plotProvisionRequestSchema>;

export const workspacePathRequestSchema = z
  .object({ path: z.string().min(1) })
  .strict();
export type WorkspacePathRequest = z.infer<typeof workspacePathRequestSchema>;

export interface WorkspaceChanges {
  status: string;
  summary: string;
  patch: string;
  truncated: boolean;
  reviewDigest: string;
  warnings: readonly string[];
}

export interface DeliveryDraft {
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export const deliveryExecuteRequestSchema = z
  .object({
    path: z.string().min(1),
    commitMessage: z.string().trim().min(1).max(500),
    push: z.boolean(),
    createPullRequest: z.boolean(),
    pullRequestTitle: z.string().trim().max(500),
    pullRequestBody: z.string().max(20_000),
    reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict()
  .refine((value) => !value.createPullRequest || value.push, {
    message: "A pull request requires pushing the branch",
  });
export type DeliveryExecuteRequest = z.infer<
  typeof deliveryExecuteRequestSchema
>;

export interface TeardownStepPayload {
  id: string;
  label: string;
  detail: string;
  manual?: string;
  url?: string;
}

export interface TeardownPlanPayload {
  scope: z.infer<typeof teardownScopeSchema>;
  steps: readonly TeardownStepPayload[];
  blockers: readonly string[];
  keeps: readonly string[];
}

export interface TeardownRunResult {
  results: readonly {
    id: string;
    label: string;
    status: "done" | "skipped" | "failed";
    output: string;
  }[];
  snapshot: SilvicSnapshot;
}

export interface PlotCreationResult {
  snapshot: SilvicSnapshot;
  plot: { name: string; path: string; port: number; url: string };
  provision: readonly ProvisionResult[];
  /** Whether every command the recipe says should run stayed alive at startup. */
  runtime: PlotRuntimeStart;
  /** Whether the published address actually answered after runtimes started. */
  readiness: PlotReadiness;
  /** What the recipe says can be run in a plot, so a new one can say so too. */
  commands: Readonly<Record<string, PlotCommand>>;
}

export interface PlotReadiness {
  status: "ready" | "failed" | "not-required";
  durationMs: number;
  detail?: string;
}

export interface PlotRuntimeStart {
  status: "started" | "failed" | "not-required";
  durationMs: number;
  detail?: string;
  failedCommands?: readonly string[];
}

export interface PlotProvisionRunResult {
  provision: readonly ProvisionResult[];
  runtime: PlotRuntimeStart;
  readiness: PlotReadiness;
}

export interface PlotProgressStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed";
  /** The newest line the step printed, so a long step still shows movement. */
  detail?: string;
  durationMs?: number;
}

/**
 * What provisioning did the last time it ran here. A plot whose recipe failed
 * halfway is still a plot, so it has to be able to say so long after the
 * dialog that created it has been closed.
 */
/** A command a plot can run, and what it is doing. */
export interface PlotProcess {
  plotPath: string;
  id: string;
  status: "running" | "stopping" | "stopped" | "failed";
  processId?: number;
  /** Where it can be reached, when it was published under a name. */
  url?: string;
  startedAt?: string;
  exitCode?: number;
  /** Why this is not what was asked for, when Silvic had to settle. */
  advice?: string;
}

export const plotCommandRequestSchema = z
  .object({ path: z.string().min(1), id: z.string().min(1).max(60) })
  .strict();
export type PlotCommandRequest = z.infer<typeof plotCommandRequestSchema>;

export interface PlotProvisioning {
  status: "complete" | "failed";
  /** When the run finished, ISO 8601. */
  at: string;
  steps: readonly ProvisionResult[];
}

/**
 * Creation can take minutes, so the whole plan is sent on every change: the
 * steps still to come are as informative as the one running, and a full state
 * cannot arrive out of order the way a stream of deltas can.
 */
export interface PlotProgress {
  /** Which creation these steps belong to. Git allows one branch once. */
  branch: string;
  steps: readonly PlotProgressStep[];
}

export interface DeliveryResult {
  pullRequestUrl?: string;
}

export const appearancePreferenceSchema = z.enum(["system", "light", "dark"]);
export type AppearancePreference = z.infer<typeof appearancePreferenceSchema>;

/** The complete update story shown by the installed desktop app. */
interface AppUpdateStateBase {
  currentVersion: string;
}

export type AppUpdateState =
  | (AppUpdateStateBase & {
      phase: "unsupported" | "idle" | "checking" | "current";
    })
  | (AppUpdateStateBase & {
      phase: "available" | "ready";
      availableVersion: string;
    })
  | (AppUpdateStateBase & {
      phase: "downloading";
      availableVersion: string;
      progressPercent: number;
    })
  | (AppUpdateStateBase & {
      phase: "error";
      message: string;
    });

export type AppUpdatePhase = AppUpdateState["phase"];

export const projectActivationRequestSchema = z
  .object({
    projectId: z.string().min(1).max(400),
    active: z.boolean(),
  })
  .strict();
export type ProjectActivationRequest = z.infer<
  typeof projectActivationRequestSchema
>;

export interface SilvicDesktopApi {
  getSnapshot(): Promise<SilvicSnapshot>;
  getRoots(): Promise<readonly string[]>;
  addRoot(): Promise<readonly string[]>;
  removeRoot(root: string): Promise<readonly string[]>;
  refresh(): Promise<SilvicSnapshot>;
  createEnvironment(
    request: CreateEnvironmentRequest,
  ): Promise<PlotCreationResult>;
  getPlotProcesses(): Promise<readonly PlotProcess[]>;
  /** Whether a plot's commands outlive the window that started them. */
  getKeepCommandsRunning(): Promise<boolean>;
  setKeepCommandsRunning(keep: boolean): Promise<boolean>;
  startPlotCommand(request: PlotCommandRequest): Promise<void>;
  stopPlotCommand(request: PlotCommandRequest): Promise<void>;
  readPlotCommandOutput(request: PlotCommandRequest): Promise<string>;
  onPlotProcesses(
    listener: (processes: readonly PlotProcess[]) => void,
  ): () => void;
  /** Runs the recipe in an existing plot, after a named repair when given. */
  provisionPlot(request: PlotProvisionRequest): Promise<PlotProvisionRunResult>;
  getChanges(request: WorkspacePathRequest): Promise<WorkspaceChanges>;
  draftDelivery(request: WorkspacePathRequest): Promise<DeliveryDraft>;
  executeDelivery(request: DeliveryExecuteRequest): Promise<DeliveryResult>;
  connectGitHub(): Promise<void>;
  listIssues(request: IssueListRequest): Promise<readonly IssueSummary[]>;
  openWorkspace(request: OpenWorkspaceRequest): Promise<void>;
  openLink(request: OpenLinkRequest): Promise<void>;
  getAppearance(): Promise<AppearancePreference>;
  setAppearance(
    preference: AppearancePreference,
  ): Promise<AppearancePreference>;
  getUpdateState(): Promise<AppUpdateState>;
  checkForUpdates(): Promise<AppUpdateState>;
  downloadUpdate(): Promise<AppUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(listener: (state: AppUpdateState) => void): () => void;
  getActiveProjects(): Promise<readonly string[]>;
  setProjectActive(
    request: ProjectActivationRequest,
  ): Promise<readonly string[]>;
  copyText(text: string): Promise<void>;
  getDefaultHarness(): Promise<HarnessId>;
  setDefaultHarness(id: HarnessId): Promise<HarnessId>;
  previewPlot(request: PlotPreviewRequest): Promise<PlotPreview>;
  /** Opens the explicit Terminal/admin flow for the persistent HTTPS proxy. */
  setupNamedRouting(): Promise<void>;
  testProvisionStep(request: TestStepRequest): Promise<ProvisionResult>;
  planTeardown(request: TeardownRequestPayload): Promise<TeardownPlanPayload>;
  runTeardown(request: TeardownRequestPayload): Promise<TeardownRunResult>;
  getRecipe(projectId: string): Promise<RecipeDocument>;
  inspectProject(projectId: string): Promise<RepositoryReading>;
  saveRecipe(request: RecipeSaveRequest): Promise<RecipeDocument>;
  onSnapshot(listener: (snapshot: SilvicSnapshot) => void): () => void;
  onPlotProgress(listener: (progress: PlotProgress) => void): () => void;
}

export const ipcChannels = {
  snapshotGet: "silvic:snapshot:get",
  snapshotRefresh: "silvic:snapshot:refresh",
  snapshotChanged: "silvic:snapshot:changed",
  rootsGet: "silvic:roots:get",
  rootsAdd: "silvic:roots:add",
  rootsRemove: "silvic:roots:remove",
  environmentCreate: "silvic:environment:create",
  changesGet: "silvic:changes:get",
  deliveryDraft: "silvic:delivery:draft",
  deliveryExecute: "silvic:delivery:execute",
  githubConnect: "silvic:github:connect",
  issuesList: "silvic:issues:list",
  workspaceOpen: "silvic:workspace:open",
  linkOpen: "silvic:link:open",
  appearanceGet: "silvic:appearance:get",
  appearanceSet: "silvic:appearance:set",
  updateStateGet: "silvic:update:state:get",
  updateCheck: "silvic:update:check",
  updateDownload: "silvic:update:download",
  updateInstall: "silvic:update:install",
  updateStateChanged: "silvic:update:state:changed",
  projectsActiveGet: "silvic:projects:active:get",
  projectsActiveSet: "silvic:projects:active:set",
  clipboardWrite: "silvic:clipboard:write",
  defaultHarnessGet: "silvic:harness:default:get",
  defaultHarnessSet: "silvic:harness:default:set",
  plotPreview: "silvic:plot:preview",
  namedRoutingSetup: "silvic:routing:setup",
  plotProgress: "silvic:plot:progress",
  plotProvision: "silvic:plot:provision",
  plotCommandsGet: "silvic:plot:commands:get",
  keepRunningGet: "silvic:commands:keep:get",
  keepRunningSet: "silvic:commands:keep:set",
  plotCommandStart: "silvic:plot:command:start",
  plotCommandStop: "silvic:plot:command:stop",
  plotCommandOutput: "silvic:plot:command:output",
  plotCommandsChanged: "silvic:plot:commands:changed",
  stepTest: "silvic:step:test",
  teardownPlan: "silvic:teardown:plan",
  teardownRun: "silvic:teardown:run",
  recipeGet: "silvic:recipe:get",
  projectInspect: "silvic:project:inspect",
  recipeSave: "silvic:recipe:save",
} as const;

declare global {
  interface Window {
    silvic: SilvicDesktopApi;
  }
}
