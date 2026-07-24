# Architecture

`WorkbenchCore` is a dependency-free Swift library. The SwiftUI executable is a replaceable presentation layer.

## Snapshot pipeline

`WorkspaceService` concurrently loads:

- repository candidates from `RepositoryDiscovery`;
- registered worktrees and status from `GitClient`;
- listeners from `ListeningProcessService`;
- tracked local commands from `WorkCLIService`;
- Codex task metadata from the local read-only SQLite database;
- Convex metadata from environment files; and
- GitHub pull-request/check metadata through `gh`.

`GitHubAuthService` delegates browser OAuth to `gh auth login --web`. The generated command opens visibly in Terminal, while `gh` normally stores credentials in the system credential store and may use its documented fallback when no credential store is available. Silvic never reads or stores the token; it checks the active account through the backward-compatible `gh api user` probe.

It normalizes those inputs into `WorkspaceOverview -> RepositorySnapshot -> WorkspaceSnapshot`. Each Workspace has a durable `WorkspaceRecord` and a `WorkspaceLocation`; the current location is either an ordinary Git checkout (including an independent clone) or a linked Git worktree. Integrations are attached using explicit local evidence such as CWD or matching repository/workspace slugs.

`WorkspaceRegistry` persists stable Workspace identifiers in Application Support.
Git worktree discovery remains an internal implementation detail that can reveal
both the repository's primary checkout and any linked worktrees. The public
Workspace model does not require linked worktrees.

## Mutations

`GitWorkflowService` does not expose ad-hoc shell strings. It produces typed `GitWorkflowPlan` values containing exact `CommandRequest` arguments. A plan is inert until `execute(_:confirmed:)` receives `true`.

## AI

`AIService` gives the local Codex CLI a bounded diff/status context in read-only, ephemeral mode. It cannot execute repository changes. Generated text must still pass through the normal confirmed workflow.
