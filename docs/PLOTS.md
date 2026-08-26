# Plots

Status: Draft

A **Plot** is one unit of parallel work. It owns a worktree, a name a person
recognises, the processes that make it runnable, the URL it answers on, and the
provider environments it needs. Creating one should be a single action.

This document records the decisions behind that, and what Silvic has to absorb
to deliver it.

## Why a Plot is not just a worktree

Agent harnesses already create worktrees. Codex puts them in
`~/.codex/worktrees/<id>/<repo>`, T3 Code in `~/.t3/worktrees/<repo>/<id>`.
They are correct and invisible: no name, no URL, no deployment, no way to tell
one from another. Switching harness means losing the thread entirely.

Everything a Plot adds exists to answer one question — _what is this, and how do
I get back into it?_

## Scope: replacing work-cli

Silvic takes over the responsibilities currently held by `work`. That is a
larger surface than it first appears, and it is worth naming honestly:

| Responsibility                         | Difficulty | Notes                                                     |
| -------------------------------------- | ---------- | --------------------------------------------------------- |
| Worktree creation in a known directory | Low        | Silvic already does the git half                          |
| Recipe format                          | Low        | Declarative; see below                                    |
| Provisioning steps (env, Convex, auth) | Medium     | Ordered, idempotent, retryable                            |
| Stable URL per plot                    | Medium     | Port allocation and collision handling                    |
| Process supervision                    | **High**   | Survive app restarts, capture logs, restart, stop cleanly |

Silvic may detect `work.config.js` as migration context, but it never imports,
executes, or uses that file as runtime configuration. Instead, Silvic infers a
native recipe from the repository's package manager, scripts, and provider
layout. An explicit `silvic.json` always takes precedence.

## Opinionated, not enforced

Silvic is open source and will meet repositories it did not design. So:

- Every field has a default that works for an ordinary project.
- Every default can be overridden.
- A repository with no configuration at all still produces a usable Plot —
  worktree, name, and whatever Silvic can infer.
- Silvic never silently rewrites a repository's own configuration.

## The recipe

One optional file at the repository root. Every field optional.

```jsonc
{
  // Defaults to the repository name.
  "project": "syntwin-mono",

  "plots": {
    // Defaults to a sibling directory: ../<project>.plots
    "directory": "../syntwin-mono.plots",
  },

  "commands": {
    // Serving commands get a named HTTPS address by default.
    // Set `portless: false` to keep only the stable localhost port.
    "web": { "run": "bun dev", "url": true, "autoStart": true },
    "convex": { "run": "bunx convex dev", "autoStart": true },
    "agent": { "run": "bun run agent:dev", "autoStart": true },
  },

  // Services shown in the Plot inspector. A command links live state and logs.
  "resources": {
    "agent": {
      "provider": "livekit",
      "kind": "agent",
      "isolation": "shared",
      "command": "agent",
    },
    "payments": {
      "provider": "stripe",
      "kind": "payments",
      "isolation": "namespaced",
      "dashboardUrl": "https://dashboard.stripe.com/test/events",
    },
    "auth": {
      "provider": "workos",
      "kind": "auth",
      "isolation": "shared",
    },
  },

  // Ordered, idempotent, retryable. Each step reports what it did.
  "provision": [
    { "run": "bun install" },
    // Team and project are read from the source checkout's CONVEX_DEPLOYMENT
    // when they are left out. Silvic supplies its own compatible Convex CLI.
    { "convex": { "name": "dev/{plot}" } },
  ],
}
```

When no explicit recipe exists, Silvic also recognises LiveKit, Stripe,
Cloudflare/Wrangler, Vercel, Clerk and WorkOS packages or scripts. A matching
long-running script becomes a supervised command; every detected provider
becomes a visible resource. SDK-only findings are marked manual and “detected,
not configured”; they never masquerade as an isolated deployment. Detection
never reads credential values.

`provision` steps are the extension point. `run` covers repository-specific
tasks; named steps like `convex` are implemented by Silvic because they own an
isolation contract and can report structured results — a deployment name Silvic
can then display and link.

The `workos` step is the second typed step, and the first whose isolation
contract is entirely local: it points the app's `WORKOS_*` variables at a
plot-local [`@workos/emulate`](https://github.com/workos/emulate) instance on
a port derived from the plot's own, keeps the redirect URI on the plot's
address, and pairs with a supervised `workos` command running the pinned
emulator. Nothing in it reaches a real WorkOS environment — which is also why
it is only ever offered: detection suggests the step and the command when a
WorkOS SDK is present, but never writes them into an inferred recipe.
Redirecting an app away from real services is an explicit choice, recorded in
`silvic.json`.

`resources` describe operational truth rather than pretending every provider
has the same API. `isolated` means one resource per Plot, `namespaced` means a
shared provider account with Plot-specific names or events, `shared` means the
Plot uses an existing service, and `manual` means Silvic can display and link it
but cannot configure it. Convex and emulated WorkOS provisioning remain typed
and Silvic-owned; the other provider entries are currently visibility, links
and process supervision where a command is attached.

## Stable named URLs

A Plot's address has to satisfy two audiences: a person reading it, and an
identity provider validating it.

Serving commands are published through the Silvic gate by default (see
`docs/GATE.md`):

```
https://web-my-plot-my-project.localhost
```

The entire identity stays in one DNS label. That permits a single WorkOS
Sandbox redirect such as
`https://web-*-my-project.localhost/auth/callback`: WorkOS permits one
leftmost wildcard with fixed prefixes and suffixes. Clerk development instances
dynamically detect the requesting development origin, so every Plot sends its
own named origin consistently.

Silvic writes that address into the Plot's local and Convex environments before
schema/functions are pushed. The runtime and route deliberately have separate
lifecycles: Silvic starts the declared command, discovers the responding HTTP
listener inside that exact process tree, and registers the route with the gate.
This matters for monorepo scripts that ignore `PORT` or start several sidecars;
the stable URL follows the actual HTML listener instead of pointing at an empty
port. A routed runtime remains `STARTING` until both its direct listener and the
named address answer. Silvic then monitors both and re-registers the route if a
dev server comes back on a different port.

The gate needs Silvic's one-time local HTTPS setup on the machine: a user
launch agent for the gate daemon, plus a loopback firewall redirect and
certificate trust behind a single administrator prompt, both run from the
Plot dialog. Silvic verifies all of it — including that browsers actually
trust the certificate — and rechecks while setup completes. Before creating
the worktree or changing a provider, Silvic verifies that port 443 really
reaches the gate; if the named route cannot be kept, creation stops instead
of writing an auth origin that the runtime will not serve. A recipe can
explicitly choose the deterministic `http://localhost:<port>` alternative
with `"portless": false` (the field keeps its historical name).

Stopping a plot suspends its route rather than deleting it: visiting the URL
later shows a holding page while the gate wakes Silvic, which starts the
plot's commands again. Routes are deleted only when the plot is torn down.

For Next.js, keep the serving command at the repository's normal dev script
(for example, `bun run dev`). Silvic supplies `PORT` itself. Do not add
`--hostname "$HOST"`: middleware can otherwise turn an internal rewrite into
HTTPS while the Next.js development port itself still speaks plain HTTP.

## Auth redirects

A new Plot means a new address, and an identity provider that has never heard of
it. Silvic's job is to make that visible and as close to automatic as the
provider allows:

1. Derive the redirect URI from the plot's URL and the configured callback path.
2. Write it wherever the recipe says it belongs — `.env.local`, Convex env.
3. If the provider cannot be configured programmatically, show the exact URI
   with a way to copy it and a link to the right dashboard page.

Step 3 is not a failure to automate; it is the honest state of most providers.
Silvic should never imply a redirect is registered when it is not.

The emulated WorkOS step removes the question entirely: a plot-local emulator
answers whatever redirect the plot asks for, so there is nothing to register
anywhere.

## Lifecycle

```
create    worktree, name, port
provision ordered steps, streamed, each result recorded
start     commands marked autoStart
resume    reconcile what exists, start only what is missing
```

Provisioning is separate from starting. A Plot that fails to provision is still
a Plot — it reports what failed rather than disappearing. Auto-start commands
do not run against that half-configured worktree.

Typed provider steps are Silvic-owned. The Convex step copies the source
environment without its deployment-specific keys, creates and selects a dev
deployment, creates a deploy key scoped to it, rewrites local URLs, synchronises
the source deployment's server variables through a protected temporary file,
and pushes schema/functions once. Its progress is visible without printing
secret values. Only after every declared provisioning step succeeds does
Silvic start every command marked `autoStart`.

## Tearing down

Activity and retention are separate questions. _Is anything running here_ is
already answered by the operational state — Active or Quiet. What teardown deals
with is _what this Plot still holds, and what releasing it costs_:

| Resource            | Cost to keep         | Getting it back          |
| ------------------- | -------------------- | ------------------------ |
| Processes           | a port, some memory  | start them again         |
| Worktree            | disk                 | recreate from the branch |
| Provider deployment | **money**            | provision again          |
| Branch              | nothing, once pushed | only if it was pushed    |

Stopping is an operational action of its own. Teardown therefore has one clear
meaning in the interface: **remove the Plot**. Silvic first plans the fullest
safe cleanup, then removes the worktree and deletes the branch only when doing
so loses no branch-only work. If the branch still owns commits, it is kept
automatically instead of blocking removal.

The confirmation says exactly what will disappear. Because removal itself is
the destructive confirmation, uncommitted work in the disposable worktree is
discarded without a second checkbox. The primary checkout can never be torn
down — it is the project.

### Steps Silvic cannot perform

A compact follow-up list calls these out without presenting them as steps Silvic
will run. Two matter today:

- **Convex deployments cannot be deleted.** The CLI offers `select`, `create`
  and `token`, and nothing that removes a deployment. Removing a Plot therefore
  cannot stop it costing money; Silvic says so and links to the dashboard.
- **Processes Silvic did not start cannot be stopped safely**, because Silvic
  does not own their process identity or logs.

Claiming a resource was released when it was not would be worse than leaving it
to the user, so the plan is honest about which steps are the user's.

## Open decisions

- **Additional provider credentials.** Silvic borrows account authentication
  from existing CLIs and writes a deployment-scoped Convex key only to the
  plot's protected local environment. Other providers need equivalent,
  explicit contracts before Silvic can configure them.
- **Teardown of paid resources.** Creating a Convex dev deployment per plot has
  a cost. Cleanup must be explicit, listed, and confirmed.
