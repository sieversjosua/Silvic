# Silvic product and interface concept

Status: Draft

## Product thesis

Silvic is the local operations layer for parallel software-development
environments.

It creates, understands, resumes, ships, and safely retires a Workspace across
Git, local runtimes, cloud development environments, GitHub, and coding-agent
harnesses.

Silvic is not primarily a Git client, a worktree browser, or a launcher. Ordinary
Git checkouts—including independent clones—and linked worktrees are
interchangeable infrastructure beneath the durable object the user cares about:
the Workspace.

## Core model

### Project

The top-level object in Silvic. A Project represents one software product or
repository identity and gathers every local checkout, independent clone, and
linked worktree that belongs to it. Repositories with the same normalized remote
origin are presented as one Project.

The Project is the stable context users enter before reasoning about parallel
work. Its primary checkout forms the trunk of the Project Grove.

### Workspace

A durable identity for one stream of development work. It can use an ordinary
checkout, an independent clone, a linked Git worktree, or eventually a remote
environment. It survives individual harness sessions and local processes.

A Workspace can attach:

- a repository, optional branch, and canonical directory;
- Codex, Claude Code, T3 Code, OpenCode, terminal, and other Harness Sessions;
- local runtimes, ports, health checks, and URLs;
- a Convex or other provider environment;
- a GitHub pull request, reviews, and CI checks; and
- a human-readable purpose and activity history.

### Workspace location

The mechanism that gives a Workspace its files and isolation:

- **Git checkout** — use an existing repository or independent full clone and
  switch branches normally.
- **Git worktree** — create a lightweight parallel checkout.
- **Remote location** — a future adapter for a remote machine, container, or
  cloud sandbox.

Silvic must offer the same status, Harness, runtime, environment, delivery, and
archive experience wherever the underlying capabilities permit it. Features
that genuinely require Git or a branch should be absent or explained, rather
than making the entire Workspace invalid.

### Recipe

Repository-specific instructions for preparing and running a Workspace:

- setup commands;
- start and stop commands;
- port requirements;
- readiness checks;
- environment-file rules; and
- optional service-provider attachments.

### Adapter

A capability-based integration with an external Harness or service. Harness
adapters report their honest capability level:

1. Open directory
2. Focus existing application
3. Resume known Session
4. Generate a context handoff

Community integrations should use a small external manifest/command contract
rather than requiring contributors to modify the renderer.

### Task and Attempt

An optional future grouping:

- A Task is the intended outcome.
- An Attempt is one isolated Workspace pursuing that outcome.

This is valuable for comparing parallel agent approaches, but it should not be
required for the first version. Every existing Git checkout or linked worktree
must be useful immediately after Silvic discovers it.

## Recommended interaction concept

Use a project-first **Project Grove**. The user enters one Project and sees its
primary checkout and parallel task environments as a deterministic tree canvas.
This matches the way coding agents work: each Harness enters a directory, while
Silvic preserves the relationship between those directories.

The canvas is not a freeform whiteboard or a decorative Git graph:

- the Project and primary checkout stay anchored;
- recorded parentage uses solid connections;
- imported locations with unknown ancestry use dashed connections and are
  labelled honestly;
- task nodes expose Git, runtime, provider, PR/CI, and Harness evidence;
- selecting a node opens the persistent Workspace inspector;
- zoom, search, quiet-environment folding, and keyboard navigation keep large
  Projects usable; and
- a task environment can be created from any selected node using either a linked
  worktree or an independent clone.

Each Workspace still has one derived operational state and recommended primary
action, but those states annotate the Project tree instead of reorganizing the
entire product into a global queue.

| State           | Meaning                                                 | Primary action   |
| --------------- | ------------------------------------------------------- | ---------------- |
| Needs attention | conflict, failed CI, crashed runtime, broken attachment | Repair / Inspect |
| Active          | a Harness Session or runtime is live                    | Focus            |
| Changed         | local work is waiting for review                        | Review changes   |
| Waiting         | CI, review, deployment, or agent activity is pending    | Inspect          |
| Ready to resume | inactive but healthy                                    | Resume           |
| Ready to land   | pushed, PR open, required checks green                  | Open PR / Merge  |
| Quiet           | clean and inactive                                      | Resume           |
| Stale           | inactive resources remain without recent work           | Archive          |
| Shipped         | work landed and resources can be retired                | Clean up         |

Ambiguous evidence must produce `Unknown`, never a confident guess.

## Main window

Use a narrow Project switcher, a large Project Grove, and a persistent inspector.

```text
┌──────────────┬───────────────────────────────────────┬───────────────────────┐
│ PROJECTS     │ shop                         + New env │ Auth refactor         │
│ shop         │                                       │ Code · Runtime        │
│ api          │ PROJECT ─ PRIMARY ─ ─ Auth refactor  │ Environment · Review │
│ website      │                  └ ─ Pricing test     │ Sessions              │
│              │                                       │                       │
│ + Add        │          Search · Zoom · Hide quiet   │ Review changes        │
└──────────────┴───────────────────────────────────────┴───────────────────────┘
```

A task-environment node should expose:

- Workspace purpose, repository, and branch;
- local Git state;
- runtime URL and health;
- attached provider environment;
- PR/CI state;
- active or resumable Harness Sessions; and
- the recommended next action.

Selecting a node opens a persistent inspector without losing Project context.
Cross-project attention and quick switching can later be layered on top; it is
not the primary information architecture.

## Workspace inspector

Organize detail by the resources attached to the Workspace:

1. Code
2. Runtime
3. Environment
4. Review
5. Sessions

The header contains one dominant contextual action: `Resume`, `Focus`, `Repair`,
`Review Changes`, `Inspect CI`, or `Archive`.

A short joined activity stream explains what happened across tools:

> Claude session ended → 4 files changed → commit pushed → CI failed

Raw Git state, commands, paths, logs, and provider identifiers remain available
as evidence behind every summary.

## Key workflows

### Adopt existing work

1. Discover repositories, ordinary checkouts, worktrees, runtimes, ports, and
   known Harness Sessions.
2. Create local Workspace identities without moving or modifying them.
3. Show uncertain attachments explicitly and allow the user to repair them.
4. Deliver useful status immediately without requiring setup.

### Create and open a Workspace

1. Ask what the user is working on.
2. Select Project, parent environment, location strategy, optional base branch, Recipe, and
   preferred Harness.
3. Preview the directory, optional branch/worktree/clone, ports, commands, and
   service attachments.
4. Create the Workspace identity first.
5. Provision each resource as an idempotent, retryable step.
6. Start missing services, wait for readiness, and open the Harness in the
   canonical directory.

The primary action is `Create & Open`, not `Create Worktree`.

### Resume

1. Reconcile what still exists.
2. Start only missing runtime resources.
3. Wait for readiness.
4. Restore relevant local URLs.
5. Focus or open the last Harness.

Switching Harness generates an optional concise handoff; it does not pretend
Sessions are portable between tools.

### Ship

1. Review the diff.
2. Generate or edit a commit message with AI.
3. Confirm the exact commit/push plan.
4. Create or update a pull request.
5. Follow CI and reviews from the Workspace.

### Archive and clean up

Archival is reversible and separate from destructive cleanup.

Before cleanup, Silvic shows:

- uncommitted or unpushed changes;
- open processes and occupied ports;
- PR and merge state;
- local branch and worktree removal;
- provider environments that will remain or be removed; and
- the exact ordered cleanup plan.

## Functional roadmap

### Foundation

- Use Silvic consistently across the product, bundle, and local data.
- Durable local Workspace registry with stable identifiers.
- Adopt existing repositories, ordinary checkouts, independent clones, and
  linked worktrees.
- A location-provider abstraction so the functional core never assumes that a
  Workspace is a worktree.
- Derive operational state and recommended next action.
- Fast event-driven local refresh with slower remote refresh.
- Search by purpose, repository, branch, path, PR, or URL.
- Group independent clones and linked worktrees into a Project by repository
  identity.
- Deterministic Project Grove layout with persisted recorded lineage and honest
  imported lineage.

### Environment lifecycle

- Create an isolated Workspace.
- Repository Recipes for setup, runtime, readiness, and environment rules.
- Automatic port allocation and collision detection.
- Start, stop, repair, and resume.
- Bundled Harness adapters for Codex, Claude Code, T3 Code, OpenCode, terminal,
  Finder, and browser.
- Global quick switcher for Resume, Focus, Open With, and Copy URL.

### Delivery lifecycle

- Git status and change inspection.
- AI commit and pull-request drafting with sanitized context.
- Confirmed commit, push, and pull-request workflows.
- GitHub PR, review, and CI state.
- Safe archive and resource-aware cleanup.

### Provider lifecycle

- Discover and manually associate Convex environments first.
- Later: transactional provision, repair, drift detection, and teardown.
- Use the same provider contract for Vercel and future services.

### Later: parallel Attempts

- Group multiple Workspaces under one Task.
- Compare changes, tests, CI, runtime health, and outcomes.
- Warn about overlapping changes.
- Select, supersede, combine, or archive Attempts.
- Generate cross-Harness handoffs and optional AI synthesis plans.

## Design principles

- Dense, calm, native, and keyboard-first.
- Plain operational language; keep the forest metaphor in the name and visual
  identity rather than forcing it into every label.
- Show one recommended action, with complete secondary actions nearby.
- Explain failures in words instead of relying on colored badges.
- Summaries must reveal their evidence.
- Never hide or lock the underlying Git repository.
- Local discovery is automatic; remote state is progressively enriched.
- State-changing Git, GitHub, paid provisioning, and destructive cleanup require
  explicit confirmation.

## Product boundary

Silvic should integrate with excellent Git tools rather than reproduce their
entire history, blame, merge, and review interfaces.

Its durable advantage is the joined lifecycle:

> create the environment once, use it from any Harness, understand its complete
> state, ship the result, and retire every attached resource safely.
