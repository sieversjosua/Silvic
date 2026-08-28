# Workspace state and ownership

Silvic keeps a small `workspaceRecords` registry so a Workspace retains its
stable Plot ID, name, lineage, task, and adoption status when its path moves or
the app restarts. This registry is metadata. It is not an inventory of things
Silvic may delete.

## Ownership boundary

| State or resource                                           | Owner                           | Silvic's authority                                                         |
| ----------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Stable Plot records and stale timestamps in `settings.json` | Silvic                          | Mark and, after confirmation, remove only eligible records                 |
| Runtimes started by Silvic and their named routes           | Silvic                          | Start, inspect, read logs, and stop through the lifecycle API              |
| `~/.codex`, Codex tasks, and Codex worktrees                | Codex                           | Observe paths, active tasks, and disk usage only                           |
| Git checkouts, linked worktrees, branches, and user files   | Git/user/Harness                | Discover and describe; state reconciliation never deletes or rewrites them |
| External listeners and processes                            | Their launching Harness or user | Observe and attach a route; never signal them during state reconciliation  |
| Provider deployments, reviews, and other remote state       | Provider/user                   | Observe, or provision only through an explicitly confirmed Plot recovery   |

Workspace-state pruning therefore cannot remove directories, Git registrations,
branches, processes, Sessions, provider resources, or anything below
`~/.codex/worktrees`. Those require their own owner-specific lifecycle and are
outside this operation.

## Reconciliation and retention

An authoritative full discovery scan sets `missingSince` the first time a
previously known record is absent. Partial Git-only paints never mark unrelated
records stale. If the same Workspace returns, its stable ID is reused and the
stale marker is cleared.

A stale record becomes eligible for metadata pruning after 30 full days. It
remains protected, regardless of age, when any of these are true:

- its directory still exists;
- the current authoritative snapshot contains it;
- a running, starting, or stopping runtime uses its path;
- an active Harness Session uses its path;
- a saved provider/provisioning attachment, provider-backed task, or completed,
  in-progress, or failed adoption is associated with it;
- its stale timestamp cannot be parsed safely.

Silvic does not prune automatically. The delay gives temporarily offline roots,
renamed locations, and delayed Harness observations time to recover without
losing identity.

## Inspect, plan, then apply

Inspection is read-only:

```sh
silvic state-plan --json
```

It does not trigger discovery, reconcile records, or persist timestamps. The
result reflects the latest reconciliation already held by the desktop control
plane and lists every stale record with `protect`, `retain`, or
`prune-metadata`, its protection reasons, the 30-day retention, and measured
disk usage for Silvic state, `~/.codex`, and `~/.codex/worktrees`. Codex disk
usage is diagnostic only.

The plan ID is a digest of the current stale records, paths, timestamps,
decisions, and protection reasons. Apply requires that exact ID:

```sh
silvic state-prune --confirm state_0123456789abcdef --json
```

The explicitly mutating apply performs a fresh authoritative scan and
recomputes the plan immediately before writing settings. A changed target set
or protection reason produces
`STATE_PLAN_CONFIRMATION_REQUIRED`; the caller must inspect and confirm the new
plan. A successful apply removes exactly the listed `workspaceRecords` entries
and reports their stable IDs.

The MCP equivalents are `plan_workspace_state` and `prune_workspace_state`.
The latter is declared destructive because metadata is removed, even though the
operation has no filesystem, process, Git, or provider deletion capability.

## Distribution boundary

The lifecycle and state tools are implemented in the shared CLI/MCP source.
Plugin packaging, notarized app distribution, and release publication remain in
the separate distribution workstream. Runtime process-group isolation remains
in the runtime-isolation workstream; this reconciliation uses the existing
supervisor ownership contract and does not change it.
