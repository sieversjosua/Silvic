# Silvic automation

Silvic exposes its runtime and preview lifecycle through a local, non-interactive
CLI. The desktop app remains the control plane: it owns discovery, recipes,
processes, routes, and runtime ownership. The CLI and Codex plugin are clients
of that same state; they do not rediscover projects or launch commands on their
own.

## Install the CLI

Packaged macOS applications contain the portable launcher at:

```text
/Applications/Silvic.app/Contents/Resources/bin/silvic
```

Put it on `PATH` with a symlink in a directory your shell already searches:

```sh
sudo ln -s "/Applications/Silvic.app/Contents/Resources/bin/silvic" /usr/local/bin/silvic
```

The launcher uses the Electron runtime signed and shipped inside `Silvic.app`;
it does not resolve `node` through the invoking shell's `PATH`. This makes the
installed CLI work from SSH, launchd, Codex MCP, and other non-interactive
environments. It resolves POSIX symlink chains before locating its bundled
program, so the documented `/usr/local/bin/silvic` link keeps working after an
app update. For repository development, build the same bundled JavaScript program
with:

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

A Convex attachment can also fail permanently when an older schema rejects
stored data or an expiring deployment no longer exists. If a runtime exits with
Convex's known invalid-key response, Silvic marks the previously complete
attachment as failed. The adoption plan then reports `convex-recreate` only
when the typed Convex step has an expiration. On confirmation, the provisioner
also verifies that the selected dev deployment matches the Plot's declared
name, team, and project. This recovery creates a new empty, expiring deployment;
documents and file storage are not copied. Inspect that data-loss boundary
before confirming:

```sh
silvic adoption-plan --plot plot_123 --json
silvic provision --plot plot_123 --confirm plot_123 --remedy convex-recreate --json
```

Shared, manually managed, non-expiring, or mismatched deployments are never
replaced. The failed step instead gives a manual recovery direction.

The MCP equivalents are `plan_plot_adoption`, `adopt_plot`, and
`provision_plot`. Both mutation tools require `confirmPlotId` to equal the
selected stable Plot ID. Results retain every member and provisioning step and
report `failed` and `partialFailure` separately. Starting through CLI or MCP
never confirms provider changes implicitly. This guard applies equally to one
named runtime and to starting every declared runtime.

## Disposable Plot policy

A trusted repository can opt detached, one-use worktrees into bounded adoption:

```json
{
  "automation": { "adoptDisposablePlots": true },
  "provision": [
    { "run": "pnpm install", "providerChanges": false },
    {
      "convex": { "name": "dev/{plot}", "expiration": "in 1 day" }
    },
    { "run": "pnpm build", "providerChanges": false }
  ]
}
```

On `start_runtimes`, Silvic evaluates the same adoption plan exposed by
`plan_plot_adoption`. It proceeds only for one detached Plot when every shell
step is declared local-only, every resource is isolated, and every created
provider resource has a typed lifecycle Silvic can recover or expire. Today
that includes local web runtimes, the WorkOS emulator, and an expiring Convex
dev deployment. Unknown shell effects, provider resources without typed
teardown, and `namespaced`, `shared`, or `manual` resources remain blocked.

The start result includes `automaticAdoption.selectedPlotId`, the evaluated
plan, and the member result. A blocked policy remains `ADOPTION_REQUIRED` and
returns its reasons. Without the repository opt-in, behavior is unchanged.

## Workspace-state diagnostics

State reconciliation is inspect-first and metadata-only:

```sh
silvic state-plan --json
silvic state-prune --confirm state_0123456789abcdef --json
```

`state-plan` reads the already reconciled registry and current observations,
reports stale records and protection reasons, and measures Silvic/Codex storage
without refreshing or persisting state. `state-prune` is the explicitly
mutating operation: it performs a fresh authoritative discovery pass, accepts
only the exact resulting plan ID, and removes only the listed stale Silvic
registry records. It never removes a Git or Codex worktree, directory, branch,
Session, process, or provider resource. See the
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
directory. Protocol revision 2 uses JSON-RPC 2.0-shaped, newline-delimited JSON
with a 64 KiB request-frame limit. The parent directory is mode `0700` and the
socket is mode `0600`. Requests only resolve stable IDs and paths already in the
authoritative snapshot; the interface accepts neither arbitrary working
directories nor shell commands. Adoption and provisioning accept a stable-ID
confirmation and, for a known repair, a closed remedy identifier; they never
accept a command string.

Every request identifies `silvic-cli` or `silvic-codex-plugin` and its release
version; every reply identifies the desktop server version. Protocol and release
versions must match exactly. A stale client receives `UNSUPPORTED_PROTOCOL` or
`INCOMPATIBLE_CLIENT` with the detected versions and the matching-release update
action. It cannot continue with an older tool catalog.

Set `SILVIC_AUTOMATION_DIR` only when running an isolated development or test
instance. The app and every client must receive the same value.

## Codex plugin

The plugin source is in `plugins/silvic`. It contains the manifest,
preview-lifecycle skill, and a bundled MCP server built from the same
`AutomationClient` as the CLI. The MCP process uses the current MCP 2026-07-28
wire implementation while retaining legacy-client negotiation.

### Install the Codex plugin once

The packaged app carries a signed local marketplace at
`Contents/Resources/codex-marketplace`. On first launch, Silvic offers to add
that source with `codex plugin marketplace add` and install the permanent
selector `silvic@silvic`. The app asks before the first installation and does
not register a source until the bundle is named `Silvic.app` under
`/Applications` or `~/Applications`.

If automatic installation is unavailable, quit Codex and run:

```sh
codex plugin marketplace list --json
codex plugin marketplace add "/Applications/Silvic.app/Contents/Resources/codex-marketplace"
codex plugin add silvic@silvic
codex plugin list --json
```

Stop before `marketplace add` if the first command reports a marketplace named
`silvic` whose root is not the displayed app path. The last command must report
an installed, enabled `silvic@silvic` whose version equals Silvic Desktop. Then
fully restart Codex and open a new task.

### Normal updates

The macOS updater replaces the signed app bundle as one unit, including Desktop,
CLI, and the marketplace source. At the next Silvic launch, the app refreshes
the existing selector with `codex plugin add silvic@silvic`; it does not remove
the selector first. Silvic then treats `codex plugin list --json` as the
authoritative enabled inventory and verifies all three versions. Finally it
starts the installed plugin copy with no Node dependency on `PATH`, completes a
real MCP `initialize`, and compares the complete `tools/list` catalog.

When that check passes after a change, Silvic asks for a full Codex restart.
Silvic never kills Codex or an MCP process. A task that was already open can
still hold the old process, so only a new task after the restart is current.
Silvic keeps the versioned restart reminder across its own launches until the
user confirms that Codex was fully restarted.

### Migration from older selectors

An existing `silvic@silvic-0-1-*` or `silvic@personal` installation is migrated
only when its source manifest names this Silvic repository. The app first adds,
version-checks, and MCP-checks
`silvic@silvic`; only after all checks pass does it remove the recognized old
selector. It leaves the old marketplace registered and does not touch any other
plugin or marketplace.

If Silvic reports an unrecognized selector or a different marketplace already
named `silvic`, inspect both public inventories before changing anything:

```sh
codex plugin marketplace list --json
codex plugin list --json
```

Do not remove the colliding entry unless you have established that it is the
old Silvic source. Silvic stops and leaves it unchanged.

### Rollback, manual distribution, and uninstall

Every GitHub release still contains `Silvic-Codex-Plugin-<version>.tar.gz` and
its `.sha256`. These are rollback and manual-distribution artifacts, not the
normal companion update path. Use an artifact only with the exactly matching
Silvic app, verify it with `shasum -a 256 -c`, and follow its `INSTALL.md`. The
archive also uses marketplace `silvic` and selector `silvic@silvic`.

Rolling back the signed app restores its matching marketplace source. Launch
Silvic, let it refresh and verify the selector, then restart Codex. If the
rollback fails before app replacement, the previous complete app and source
remain; Silvic never stages individual plugin files beside the app.

To use the extracted artifact as the source for a deliberate manual rollback,
first inspect `codex plugin marketplace list --json`. Continue only when the
existing `silvic` root is the exact app-bound path (or another extracted Silvic
artifact) and its `plugins/silvic/.codex-plugin/plugin.json` names this
repository. Then switch only that marketplace:

```sh
codex plugin marketplace remove silvic
codex plugin marketplace add "$PWD/Silvic-Codex-Plugin-<version>"
codex plugin add silvic@silvic
```

After the rollback check, restart Codex. To resume normal Desktop updates,
repeat the same identity checks on the extracted source, remove only marketplace
`silvic`, and add the marketplace under the installed `Silvic.app` again. Silvic
never performs this source switch automatically because a same-named foreign
marketplace must remain untouched.

Removing `Silvic.app` also removes the signed source, but it intentionally does
not rewrite Codex settings. The cached launcher then fails closed because the
packaged Silvic runtime is missing. Remove only the companion selector when it
is no longer wanted:

```sh
codex plugin remove silvic@silvic
```

For any version mismatch, failed Codex command, MCP error, or tool-catalog
difference, Silvic shows the failure. If Codex may already have refreshed its
cached copy, the restart reminder remains active even though verification
failed. A migration failure restores any legacy selector already removed and
confirms that recovery with `codex plugin list --json`; if restoration itself
fails, the dialog names the selector that remains removed. Silvic never uses a
cache directory as evidence of an active plugin and never edits Codex
configuration or cache files directly.
The complete update contract and source-placement rationale are documented in
[Codex plugin updates](CODEX_PLUGIN_UPDATES.md).

After changing CLI or MCP source, refresh the bundled plugin executable and
validate both packages:

```sh
pnpm --filter @silvic/cli build
pnpm package:plugin
node Scripts/verify-packaged-distribution.mjs --app /path/to/Silvic.app --plugin-archive release/Silvic-Codex-Plugin-0.1.53.tar.gz
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/silvic
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/silvic/skills/silvic-preview
```
