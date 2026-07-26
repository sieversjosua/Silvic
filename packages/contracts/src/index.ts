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
  metadata?: Readonly<Record<string, string | number | boolean>> | undefined;
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
        z.union([z.string().max(2_000), z.number().finite(), z.boolean()]),
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
  observe(
    target: WorkspaceTarget,
    context?: ConnectorContext,
  ): Promise<readonly ConnectorObservation[]>;
}

export interface HarnessDefinition {
  id: "codex" | "claude" | "t3-code" | "opencode" | "terminal" | "finder";
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
  locationKind: WorkspaceLocationKind;
  isPrimary: boolean;
  git: GitStatus;
  observations: readonly ConnectorObservation[];
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
  workspaces: readonly WorkspaceSnapshot[];
}

export interface SilvicSnapshot {
  projects: readonly ProjectSnapshot[];
  connectorFailures: readonly ConnectorFailure[];
  refreshedAt: string;
}

export const openWorkspaceRequestSchema = z
  .object({
    path: z.string().min(1),
    target: z.enum([
      "codex",
      "claude",
      "t3-code",
      "opencode",
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
      })
      .strict(),
    label: z.string().min(1).max(120).optional(),
  })
  .strict();

export const provisionStepSchema = z.union([
  shellStepSchema,
  convexStepSchema,
]);
export type ShellStep = z.infer<typeof shellStepSchema>;
export type ConvexStep = z.infer<typeof convexStepSchema>;
export type ProvisionStep = z.infer<typeof provisionStepSchema>;

export function isConvexStep(step: ProvisionStep): step is ConvexStep {
  return "convex" in step;
}

export const packageManagerSchema = z.enum(["bun", "pnpm", "npm", "yarn"]);
export type PackageManager = z.infer<typeof packageManagerSchema>;

export interface RepositoryFindings {
  packageManager?: PackageManager;
  devScript?: string;
  convex: boolean;
  workConfig: boolean;
  envExample?: string;
}

export const plotCommandSchema = z
  .object({
    run: z.string().min(1).max(2_000),
    url: z.boolean().optional(),
    autoStart: z.boolean().optional(),
  })
  .strict();
export type PlotCommand = z.infer<typeof plotCommandSchema>;

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
        z.string().regex(/^[a-z][a-z0-9-]*$/).max(60),
        plotCommandSchema,
      )
      .optional(),
    provision: z.array(provisionStepSchema).max(50).optional(),
  })
  .strict();
export type Recipe = z.infer<typeof recipeSchema>;

export interface ProvisionResult {
  label: string;
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
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
  })
  .strict();
export type CreateEnvironmentRequest = z.infer<
  typeof createEnvironmentRequestSchema
>;

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

export interface PlotCreationResult {
  snapshot: SilvicSnapshot;
  plot: { name: string; path: string; port: number; url: string };
  provision: readonly ProvisionResult[];
}

export interface DeliveryResult {
  pullRequestUrl?: string;
}

export const appearancePreferenceSchema = z.enum(["system", "light", "dark"]);
export type AppearancePreference = z.infer<typeof appearancePreferenceSchema>;

export const projectActivationRequestSchema = z
  .object({
    projectId: z.string().min(1).max(400),
    active: z.boolean(),
  })
  .strict();
export type ProjectActivationRequest = z.infer<
  typeof projectActivationRequestSchema
>;

/** Harness id to a data URL of the installed application's real macOS icon. */
export type HarnessIcons = Readonly<Record<string, string>>;

export interface SilvicDesktopApi {
  getSnapshot(): Promise<SilvicSnapshot>;
  getRoots(): Promise<readonly string[]>;
  addRoot(): Promise<readonly string[]>;
  removeRoot(root: string): Promise<readonly string[]>;
  refresh(): Promise<SilvicSnapshot>;
  createEnvironment(request: CreateEnvironmentRequest): Promise<PlotCreationResult>;
  getChanges(request: WorkspacePathRequest): Promise<WorkspaceChanges>;
  draftDelivery(request: WorkspacePathRequest): Promise<DeliveryDraft>;
  executeDelivery(request: DeliveryExecuteRequest): Promise<DeliveryResult>;
  connectGitHub(): Promise<void>;
  openWorkspace(request: OpenWorkspaceRequest): Promise<void>;
  openLink(request: OpenLinkRequest): Promise<void>;
  getAppearance(): Promise<AppearancePreference>;
  setAppearance(preference: AppearancePreference): Promise<AppearancePreference>;
  getActiveProjects(): Promise<readonly string[]>;
  setProjectActive(
    request: ProjectActivationRequest,
  ): Promise<readonly string[]>;
  getHarnessIcons(): Promise<HarnessIcons>;
  copyText(text: string): Promise<void>;
  getRecipe(projectId: string): Promise<RecipeDocument>;
  inspectProject(projectId: string): Promise<RepositoryFindings>;
  saveRecipe(request: RecipeSaveRequest): Promise<RecipeDocument>;
  onSnapshot(listener: (snapshot: SilvicSnapshot) => void): () => void;
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
  workspaceOpen: "silvic:workspace:open",
  linkOpen: "silvic:link:open",
  appearanceGet: "silvic:appearance:get",
  appearanceSet: "silvic:appearance:set",
  projectsActiveGet: "silvic:projects:active:get",
  projectsActiveSet: "silvic:projects:active:set",
  harnessIconsGet: "silvic:harness:icons:get",
  clipboardWrite: "silvic:clipboard:write",
  recipeGet: "silvic:recipe:get",
  projectInspect: "silvic:project:inspect",
  recipeSave: "silvic:recipe:save",
} as const;

declare global {
  interface Window {
    silvic: SilvicDesktopApi;
  }
}
