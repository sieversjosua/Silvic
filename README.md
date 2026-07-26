# Silvic

Silvic is a local-first macOS control plane for parallel development work.

Coding agents each create their own worktree — Codex in `~/.codex/worktrees/70b0/`,
T3 Code somewhere else again — and none of them tell you which is which. Switch
tools and you lose the thread: no name you recognise, no address, no idea which
deployment belongs to what.

Silvic gives each one an identity and keeps the relationships between them
visible.

## Plots

A **Plot** is one unit of parallel work: a worktree, a name a person recognises,
a stable address, the processes that make it runnable, and the provider
environments it needs.

Plots belong to a **Project**, and a project's plots are drawn as a grove — the
trunk at the centre, plots fanning out either side, quiet ones folded away until
you ask for them.

See [docs/PLOTS.md](docs/PLOTS.md) for the model and the decisions behind it.

## What works

**Finding your work**

- Recursive repository discovery, grouped into projects by normalized Git remote
- Worktrees created by Codex and T3 Code named after what they are, by reading
  work-cli's state or the harness directory, rather than repeating the repository
  name
- A curated project list: nothing appears in the rail until you add it, and
  everything else is offered as a suggestion
- Git branch, revision, upstream, ahead/behind and change state

**Seeing it**

- A deterministic grove canvas: recorded lineage solid, inferred lineage dashed,
  quiet plots folded into one stack, plots draggable with a retidy
- Light and dark, following the system and switchable
- GitHub pull requests and checks through your existing `gh` login
- Convex deployments, localhost runtimes and Codex sessions surfaced per plot,
  each opening in the browser where it has an address

**Creating it**

- A plot recipe per project, stored as `silvic.json` in the repository and
  editable in the app
- Silvic inspects a repository — package manager, dev script, `convex/`, an
  existing `work.config.js` — and proposes a recipe rather than opening a blank
  form
- Provisioning steps run in order at creation, streamed, each reporting what it
  did and stopping at the first failure
- A typed Convex step: team, project and deployment name as fields, defaulting to
  the source checkout's `CONVEX_DEPLOYMENT`
- Stable per-plot addresses, so a URL registered with an identity provider keeps
  working across restarts
- Diff inspection, Codex-assisted delivery drafts, and confirmed commit/push/PR

**Opening it**

- Codex, Claude Code, T3 Code, OpenCode, VS Code, Terminal or Finder, with the
  default pinned from the menu

## What does not work yet

- **Nothing starts.** Commands are configurable but inert: running and
  supervising them is an open design decision, recorded in
  [docs/PLOTS.md](docs/PLOTS.md).
- **No environment contract.** Clerk and WorkOS keys, and the redirect URI a new
  plot needs, are not modelled yet.
- **No teardown.** Archiving and removing provisioned resources is not built, so
  a Convex deployment per plot has to be cleaned up by hand.

## Credentials

Silvic never reads or stores GitHub or Convex credentials. GitHub uses your
existing `gh` authentication, so `gh auth login --web` provides browser OAuth
when needed. A provisioning step that needs a credential borrows an existing
CLI's, the same way.

Change context sent to an AI for a commit or pull-request draft is bounded and
credential-redacted first.

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
apps/web            React renderer, grove canvas, recipe editor
packages/contracts  Shared connector, snapshot, recipe, and IPC types
packages/core       Discovery, naming, recipes, provisioning, delivery
connectors/*        GitHub, Convex, work-cli, and harness integrations
```

See [the connector guide](docs/CONNECTORS.md) to add a harness or service without
coupling it to the UI. Architecture and product intent live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PLOTS.md](docs/PLOTS.md), and
[docs/PRODUCT_CONCEPT.md](docs/PRODUCT_CONCEPT.md).

## Status

Early. Discovery, naming, the canvas, recipes and provisioning form the current
foundation. Running processes, the environment contract, and resource teardown
are next.

## License

MIT
