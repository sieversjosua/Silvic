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

export const createEnvironmentRequestSchema = z
  .object({
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1),
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

export interface DeliveryResult {
  pullRequestUrl?: string;
}

export interface SilvicDesktopApi {
  getSnapshot(): Promise<SilvicSnapshot>;
  getRoots(): Promise<readonly string[]>;
  addRoot(): Promise<readonly string[]>;
  removeRoot(root: string): Promise<readonly string[]>;
  refresh(): Promise<SilvicSnapshot>;
  createEnvironment(request: CreateEnvironmentRequest): Promise<SilvicSnapshot>;
  getChanges(request: WorkspacePathRequest): Promise<WorkspaceChanges>;
  draftDelivery(request: WorkspacePathRequest): Promise<DeliveryDraft>;
  executeDelivery(request: DeliveryExecuteRequest): Promise<DeliveryResult>;
  connectGitHub(): Promise<void>;
  openWorkspace(request: OpenWorkspaceRequest): Promise<void>;
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
} as const;

declare global {
  interface Window {
    silvic: SilvicDesktopApi;
  }
}
