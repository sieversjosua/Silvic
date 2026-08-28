# Silvic automation

Silvic exposes its runtime and preview lifecycle through a local, non-interactive
CLI. The desktop app remains the control plane: it owns discovery, recipes,
processes, routes, and runtime ownership. The CLI and Codex plugin are clients
of that same state; they do not rediscover projects or launch commands on their
own.

## Install the CLI

Packaged macOS applications contain the standalone executable at:

```text
/Applications/Silvic.app/Contents/Resources/bin/silvic
```

Put it on `PATH` with a symlink in a directory your shell already searches:

```sh
sudo ln -s "/Applications/Silvic.app/Contents/Resources/bin/silvic" /usr/local/bin/silvic
```

For repository development, build the same self-contained executable with:

```sh
pnpm --filter @silvic/cli build
apps/cli/dist/silvic.mjs --help
```

On macOS the CLI launches Silvic in the background when its control socket is
not available. Commands never show a picker, focus the desktop window, or
trigger an administrator prompt. If named HTTPS setup is missing, start reports
an actionable diagnostic and leaves gate setup to the desktop UI.

## Preview lifecycle

```sh
# Discover stable machine identifiers.
silvic projects --json
silvic plots --json

# Inspect, start, wait, then stop.
silvic status --plot plot_123 --json
silvic start --plot plot_123 --json
silvic preview --plot plot_123 --timeout 60000 --open
silvic wait --plot plot_123 --timeout 60000 --json
silvic logs --plot plot_123 --runtime web --limit 20000 --json
silvic stop --plot plot_123 --json
```

`--plot` accepts a stable `workspaceId` or the absolute path of an already
watched Plot. A runtime ID is the command key in `silvic.json`. Omitting
`--runtime` applies start, stop, or logs to every declared runtime.

Status also returns every declared resource's `provider`, `kind` and
`isolation`. `shared` and `manual` resources always add a diagnostic: shared
provider infrastructure is not presented as isolated, and manual resources
are explicitly described as unverifiable by Silvic. A command-linked LiveKit
resource reports `runtimeIdentity: "namespaced"`; that qualifies only the
injected agent identity, not the shared provider account, data or credentials.

Start and stop are idempotent and return an outcome for every requested
runtime. Successful siblings stay successful when another runtime fails; the
top-level result sets `partialFailure: true`. Stopping a runtime with
`ownership: "external"` returns `detached`: Silvic removes its route and local
attachment without signalling the external process.

Start fails closed for a non-primary Plot until it has been adopted and every
provisioning step required by its current recipe has completed successfully.
CLI and MCP callers recover without opening the desktop UI, but recovery is a
separate, explicit operation:

```sh
# Read the exact members, stable IDs, routes, and provider-changing steps.
silvic adoption-plan --plot plot_123 --json

# Confirm with the selected stable ID, never with a path or a boolean.
silvic adopt --plot plot_123 --confirm plot_123 --json

# Retry an adopted Plot whose provisioning later failed.
silvic provision --plot plot_123 --confirm plot_123 --json
```

Use `--scope family` on the plan and adoption to resume the selected Plot's
discovered lineage in ancestor-first order. Already-adopted members are reported
as `already-adopted`; failed members retain their attempt state and can be
retried. Provisioning reruns the same idempotent recipe path as the desktop app.
If a failed step offers the `convex-cli` remedy, pass
`--remedy convex-cli` on the retry.

The MCP equivalents are `plan_plot_adoption`, `adopt_plot`, and
`provision_plot`. Both mutation tools require `confirmPlotId` to equal the
selected stable Plot ID. Results retain every member and provisioning step and
report `failed` and `partialFailure` separately. Starting through CLI or MCP
never confirms provider changes implicitly. This guard applies equally to one
named runtime and to starting every declared runtime.

## Workspace-state diagnostics

State reconciliation is inspect-first and metadata-only:

```sh
silvic state-plan --json
silvic state-prune --confirm state_0123456789abcdef --json
```

`state-plan` performs a fresh authoritative discovery pass, reports stale
records and protection reasons, and measures Silvic/Codex storage without
changing it. `state-prune` accepts only the exact current plan ID and removes
only the listed stale Silvic registry records. It never removes a Git or Codex
worktree, directory, branch, Session, process, or provider resource. See the
[workspace-state and ownership guide](WORKSPACE_STATE.md) for retention and
safety boundaries.

`preview` combines start and wait, prints the canonical URL, and optionally
opens it with `--open`. `wait` has no start side effect. It waits until every
serving runtime reports running and the canonical preview URL answers, then
prints that canonical URL.

## Codex environment actions

Open a Project's overflow menu in Silvic and choose **Add Codex actions**. Silvic
adds a managed block to `.codex/environments/environment.toml` with three local
environment actions:

- **Silvic Start** starts every runtime declared for the current Codex worktree.
- **Silvic Preview** starts, waits for readiness, and opens the canonical URL.
- **Silvic Stop** stops Silvic-owned runtimes and detaches external ones.

The commands pass Codex's current working directory as the Plot selector, so the
same checked-in actions work from every Codex worktree. Silvic preserves any
existing setup script and unrelated actions in the environment document. The
same menu updates or removes only Silvic's marked block; conflicts are reported
without rewriting the file.

## Output and exit codes

Every command accepts `--json`. JSON mode writes exactly one compact envelope
to stdout:

```json
{ "schemaVersion": 1, "ok": true, "result": {} }
```

Failures use the same envelope with `ok: false` and a stable error `code`.
Human-mode diagnostics go to stderr. No command reads from stdin or prompts.

| Exit | Meaning                                               |
| ---: | ----------------------------------------------------- |
|    0 | Success, including an idempotent no-op                |
|    2 | Invalid command or arguments                          |
|    3 | Silvic unavailable or protocol-incompatible           |
|    4 | Project, Plot, or runtime not found                   |
|    5 | Lifecycle failed or state-plan confirmation is stale  |
|    6 | Some requested operations failed and others succeeded |
|    7 | Readiness deadline exceeded                           |
|  130 | Cancelled                                             |

## Local protocol and security

The app listens on `automation.sock` under its per-user application-support
directory. Protocol revision 1 uses JSON-RPC 2.0-shaped, newline-delimited JSON
with a 64 KiB request-frame limit. The parent directory is mode `0700` and the
socket is mode `0600`. Requests only resolve stable IDs and paths already in the
authoritative snapshot; the interface accepts neither arbitrary working
directories nor shell commands. Adoption and provisioning accept a stable-ID
confirmation and, for a known repair, a closed remedy identifier; they never
accept a command string.

Set `SILVIC_AUTOMATION_DIR` only when running an isolated development or test
instance. The app and every client must receive the same value.

## Codex plugin

The distributable plugin is in `plugins/silvic`. It contains the manifest,
preview-lifecycle skill, and a bundled MCP server built from the same
`AutomationClient` as the CLI. The MCP process uses the current MCP 2026-07-28
wire implementation while retaining legacy-client negotiation.

After changing CLI or MCP source, refresh the bundled plugin executable and
validate both packages:

```sh
pnpm --filter @silvic/cli build
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/silvic
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/silvic/skills/silvic-preview
```
