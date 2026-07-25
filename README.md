# Silvic

Silvic is a local-first macOS control plane for parallel development environments.
It groups checkouts, clones, and Git worktrees into projects, then attaches the
runtime, deployment, review, and coding-agent context that belongs to each one.

The app is built with Electron, React, and TypeScript. Git and connector work runs
outside the renderer in a narrow, typed desktop API.

## What works

- Recursive local repository discovery
- Project grouping by normalized Git remote
- Primary checkouts and linked worktrees on a project canvas
- Git branch, revision, upstream, ahead/behind, and change state
- New environments as linked worktrees or independent clones
- Durable Workspace identity with recorded and inferred parent lineage
- GitHub pull request and check state through the authenticated `gh` CLI
- Convex deployment discovery from local environment metadata
- `work-cli`, general localhost runtime, and Codex task discovery
- Open any Workspace in Codex, Claude Code, T3 Code, OpenCode, Terminal, or Finder
- Diff inspection, Codex-assisted delivery drafts, and confirmed commit/push/PR flows
- Connector failures isolated from the rest of the snapshot

Silvic never reads or stores GitHub or Convex credentials. GitHub uses the existing
`gh` authentication, so `gh auth login --web` provides browser OAuth when needed.

## Development

Requirements:

- macOS
- Node.js 22 or newer
- pnpm 11
- Git

```bash
pnpm install
pnpm dev
```

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm package:mac
```

The verified app archive is written to `release/Silvic-mac-arm64.zip`.
Local directory builds receive an ad-hoc signature when no valid Apple signing
identity is available; release distribution still requires Developer ID signing
and notarization.

## Repository layout

```text
apps/desktop        Electron main process, secure preload, packaging
apps/web            React renderer and project-grove interface
packages/contracts  Shared connector, snapshot, and IPC types
packages/core       Git discovery and environment lifecycle
connectors/*        GitHub, Convex, work-cli, and Harness integrations
```

See [the connector guide](docs/CONNECTORS.md) to add a Harness or service without
coupling it to the UI. Architecture and product intent live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/PRODUCT_CONCEPT.md](docs/PRODUCT_CONCEPT.md).

## Status

Silvic is an early open-source project. Discovery, connector enrichment, environment
creation, Harness launching, and the confirmed delivery path form the current
foundation. Recipes, provider provisioning, and environment teardown remain on the
roadmap.

## License

MIT
