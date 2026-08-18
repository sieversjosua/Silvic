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
- Worktrees created by Codex and T3 Code grouped from Git and harness evidence,
  without depending on work-cli at runtime
- A curated project list: nothing appears in the rail until you add it, and
  everything else is offered as a suggestion
- Git branch, revision, upstream, ahead/behind and change state

**Seeing it**

- A deterministic grove canvas: recorded lineage solid, inferred lineage dashed,
  quiet plots folded into one stack, plots draggable with a retidy
- A camera that stays where you left it: tearing a plot down rebalances the
  grove, and the view follows the plot you were watching rather than sliding off
  it, with a way back offered whenever every plot leaves the screen
- Light and dark, following the system and switchable
- GitHub pull requests and checks through your existing `gh` login
- Convex deployments, localhost runtimes and Codex sessions surfaced per plot,
  each opening in the browser where it has an address
- A persistent Plot inspector in the sidebar that brings the task, branch,
  preview, logs, deployments and every attached service together without
  leaving the grove

**Creating it**

- Open GitHub issues can seed a Plot; Silvic carries the issue title, body and
  link into the Plot and proposes a readable branch name
- A plot recipe per project, stored as `silvic.json` in the repository and
  editable in the app
- Silvic inspects a repository — package manager, dev script, `convex/`, an
  existing `work.config.js` marker and common provider SDKs/scripts — and
  proposes a recipe rather than opening a blank form
- LiveKit, Stripe, Cloudflare, Vercel, Clerk and WorkOS are detected as Plot
  resources; commands such as a LiveKit agent or Stripe webhook listener can be
  supervised alongside the web runtime
- `work.config.js` is only a migration signal. Silvic never imports, executes,
  or uses it as runtime configuration
- Provisioning steps run in order at creation, streamed, each reporting what it
  did and stopping at the first failure
- A native Convex step that creates the isolated deployment and scoped deploy
  key, copies local variables, syncs server variables, rewrites plot URLs and
  pushes schema/functions without changing the repository's Convex dependency
- An optional emulated WorkOS step: one recipe entry points the app's
  `WORKOS_*` variables at a plot-local [`@workos/emulate`](https://github.com/workos/emulate)
  instance, supervised like any other command — isolated auth per plot, no
  real WorkOS account touched. Offered as a suggestion, never assumed
- Stable per-plot addresses, so a URL registered with an identity provider keeps
  working across restarts
- Named HTTPS addresses such as
  `https://web-auth-callback-like-photo.localhost`, with an explicit stable-port
  fallback
- Auto-start commands are supervised with logs and stop/restart controls, and
  start only after the complete provisioning sequence succeeds
- Diff inspection, Codex-assisted delivery drafts, and confirmed commit/push/PR

**Opening it**

- Codex, Claude Code, T3 Code, OpenCode, VS Code, Terminal or Finder, with the
  default pinned from the menu

## What does not work yet

- **Provider attachment is broader than provider provisioning.** Silvic can
  detect, display, link and supervise common services, but only Convex (a real
  isolated deployment) and WorkOS (a local emulator) carry fully Silvic-owned
  isolation contracts so far.
- **Provider teardown is limited.** Silvic safely stops its own processes and
  can remove a worktree and branch, but Convex deployments still have to be
  removed in the provider dashboard because the CLI exposes no delete command.

## Credentials

Silvic never stores GitHub or Convex account credentials. It borrows existing
CLI authentication: GitHub through `gh`, Convex through the Convex CLI. During
native Convex provisioning it copies deployment variables directly between the
source and isolated deployment, redacts them from progress output, and removes
its protected temporary file immediately.

Change context sent to an AI for a commit or pull-request draft is bounded and
credential-redacted first.

## Development

Requirements:

- macOS
- Node.js 22 or newer
- pnpm 11
- Git
- Named HTTPS routes need Silvic's one-time local HTTPS setup (run from the
  plot dialog; it asks once for an administrator password). Nothing else has
  to be installed — the Silvic gate ships inside the app.

```bash
pnpm install
pnpm dev
```

For a Next.js repository, use its normal dev script as the serving command
(for example, `bun run dev`). Named routing supplies `PORT`; forcing
`--hostname "$HOST"` can break middleware rewrites behind the HTTPS proxy.

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

Production releases are universal, Developer ID-signed, notarized, and published
through GitHub Actions. Installed builds expose an update control in the sidebar;
downloads remain explicit and install only after **Restart to update**. See
[the release guide](docs/RELEASING.md) for the one-time secret setup and tagged
release flow.

## Repository layout

```text
apps/desktop        Electron main process, secure preload, packaging
apps/web            React renderer, grove canvas, recipe editor
packages/contracts  Shared connector, snapshot, recipe, and IPC types
packages/core       Discovery, naming, recipes, provisioning, delivery
connectors/*        GitHub, Convex, local-context, and harness integrations
```

See [the connector guide](docs/CONNECTORS.md) to add a harness or service without
coupling it to the UI. Architecture and product intent live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/PLOTS.md](docs/PLOTS.md), and
[docs/PRODUCT_CONCEPT.md](docs/PRODUCT_CONCEPT.md).

## Status

Early. Discovery, issue-driven creation, naming, the canvas, recipes, the
Plot inspector, provisioning and supervised multi-service runtimes form
the current foundation. More provider-specific provisioning and resource
teardown are next.

## License

MIT
