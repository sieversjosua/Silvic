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
    // `portless: true` additionally publishes a named .localhost address.
    "web": { "run": "bun dev", "url": true, "autoStart": true },
    "convex": { "run": "bunx convex dev", "autoStart": true },
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

`provision` steps are the extension point. `run` covers repository-specific
tasks; named steps like `convex` are implemented by Silvic because they own an
isolation contract and can report structured results — a deployment name Silvic
can then display and link.

## URLs, and why the default is a port

A Plot's address has to satisfy two audiences: a person reading it, and an
identity provider validating it.

Subdomain routing (`https://web-my-plot-my-project.localhost`) reads better.
But WorkOS only guarantees wildcard redirect URIs for **the port on localhost**
(`http://localhost:*/callback`, per RFC 8252); wildcards do not match across
subdomain levels and are rejected for public-suffix domains. A `.localhost`
subdomain is therefore not covered by the one form providers document.

So the default is the boring one that works everywhere:

```
http://localhost:<port>
```

with a **stable** port per plot, derived deterministically from the project and
plot name and adjusted on collision. Stability is the point — a plot's address
must not change between restarts, or every registered redirect breaks.

Pretty subdomain URLs remain available by opting in, for projects willing to
register redirects per plot or to run a proxy. Silvic states the trade-off at
the point of choosing rather than deciding for the user.

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

So teardown is a ladder rather than a state, each rung reversible at increasing
cost:

- **Stop** — end processes. Free, instant, nothing lost.
- **Archive** — release what the Plot holds, keeping its files and branch.
- **Remove** — delete the worktree. The branch is a separate, explicit choice.

Nothing runs without showing the exact ordered plan first, including what
survives. A plan is refused outright rather than partially applied when it would
lose work: uncommitted changes, unpushed commits, or a branch with no upstream
all block it. The primary checkout can never be torn down — it is the project.

### Steps Silvic cannot perform

A plan lists these too, with the reason, rather than dropping them. Two matter
today:

- **Convex deployments cannot be deleted.** The CLI offers `select`, `create`
  and `token`, and nothing that removes a deployment. Archiving a Plot therefore
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
