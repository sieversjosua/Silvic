# Architecture

Silvic is a pnpm TypeScript monorepo with an Electron desktop shell and a React
renderer. The renderer is replaceable: it only sees serializable snapshots and
commands exposed by `@silvic/contracts`.

## Process boundary

```text
React renderer
    │ window.silvic (context bridge)
    ▼
Electron preload
    │ typed IPC
    ▼
Electron main ── ProjectService ── Git
              └─ ConnectorRegistry ── GitHub / Convex / local context
```

The BrowserWindow uses context isolation, sandboxing, and no Node integration.
Filesystem access, process execution, persistence, and external applications stay
in the main process. IPC mutation handlers validate renderer inputs against the
latest discovered snapshot.

CLI and Codex-plugin automation crosses a separate per-user Unix socket. Its
wire envelope carries a protocol revision plus the client role, client release,
and desktop release. The desktop rejects mismatched protocol or release versions
with a structured update action before dispatching a lifecycle method. This
keeps tool-catalog drift from weakening the explicit stable-ID confirmation used
by adoption and provisioning.

## Snapshot pipeline

`ProjectService.snapshot()` recursively discovers repositories under configured
roots, asks Git for registered worktrees and porcelain-v2 status, and groups local
locations by normalized remote identity. It then calls `ConnectorRegistry.observe()`
for every Workspace.

`WorkspaceRegistry` reconciles those transient Git locations with records persisted
by the main process. Exact-path matches are preferred, unique project/branch matches
survive moves, and environments created in Silvic record their selected parent.

Connector execution is failure-isolated. An unavailable optional CLI or malformed
provider file becomes a visible connector failure; it cannot prevent Git state or
other connectors from loading.

## Connector contract

An observation connector exports a validated manifest and one asynchronous
`observe(target)` function. It returns small, serializable observations such as a
runtime, deployment, review, or Session. Connectors do not import renderer code.

Harness integrations use a capability list consumed by the main process. GUI
Harnesses open a validated Workspace directory. CLI Harnesses launch through a
short-lived, self-deleting Terminal command file.

## Environment lifecycle

`EnvironmentService` supports both linked worktrees and independent clones. The
desktop handler derives and validates the destination from the selected project
and branch before delegating to Git. Environment creation is initiated through an
explicit confirmation dialog and followed by a complete snapshot refresh.

`DeliveryService` produces bounded, secret-redacted change context for the local
Codex CLI. Commit, push, and pull-request creation are separate confirmed requests;
their Workspace path and payload are validated again in the main process.

## Persistence and credentials

Only configured discovery roots are stored through `electron-store`. Silvic
delegates authentication to installed CLIs such as `gh`; it does not persist
provider tokens. The Convex connector reads public deployment metadata from local
environment files and explicitly excludes deploy keys.
