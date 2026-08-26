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

Start and stop are idempotent and return an outcome for every requested
runtime. Successful siblings stay successful when another runtime fails; the
top-level result sets `partialFailure: true`. Stopping a runtime with
`ownership: "external"` returns `detached`: Silvic removes its route and local
attachment without signalling the external process.

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

| Exit | Meaning                                     |
| ---: | ------------------------------------------- |
|    0 | Success, including an idempotent no-op      |
|    2 | Invalid command or arguments                |
|    3 | Silvic unavailable or protocol-incompatible |
|    4 | Project, Plot, or runtime not found         |
|    5 | Runtime or preview operation failed         |
|    6 | Some runtimes failed and others succeeded   |
|    7 | Readiness deadline exceeded                 |
|  130 | Cancelled                                   |

## Local protocol and security

The app listens on `automation.sock` under its per-user application-support
directory. Protocol revision 1 uses JSON-RPC 2.0-shaped, newline-delimited JSON
with a 64 KiB request-frame limit. The parent directory is mode `0700` and the
socket is mode `0600`. Requests only resolve stable IDs and paths already in the
authoritative snapshot; the interface accepts neither arbitrary working
directories nor shell commands.

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
