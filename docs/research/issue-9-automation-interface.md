# Issue #9: local automation interface and Codex plugin

Checked: 2026-08-25

## Scope and evidence standard

This note researches the implementation choices for
[Issue #9](https://github.com/sieversjosua/Silvic/issues/9): a non-interactive
CLI and installable Codex plugin for listing Plots, inspecting runtime and
preview state, starting and stopping runtimes, waiting for readiness, and
reading recent logs. It uses only the Silvic source at commit
[`76a4837`](https://github.com/sieversjosua/Silvic/tree/76a4837752cd533f2daf5a8291c43781e79ae3af),
official OpenAI documentation, the official Model Context Protocol (MCP)
specification and TypeScript SDK, and official Node.js/TypeScript documentation.

Statements labelled **Verified** come directly from those sources. Statements
labelled **Recommendation** or **Silvic inference** are design conclusions drawn
from them.

## Executive decision

**Recommendation:** add one private, versioned local automation protocol owned
by the Electron main process. Both the `silvic` CLI and the plugin's stdio MCP
server should be thin adapters over the same `AutomationClient`; neither should
rediscover projects, read recipes independently, or implement process lifecycle
logic.

```text
silvic CLI ────────────────┐
                          ├─ AutomationClient ─ Unix socket ─ AutomationServer
Codex ─ stdio MCP server ─┘                                      │
                                      Runtime/Preview application service
                                            │          │          │
                                      ProjectService  Supervisor  GateManager
```

The initial server belongs in Electron main because that process currently owns
the authoritative snapshot, settings, `CommandSupervisor`, `GateManager`, and
the orchestration functions that compose them
([desktop main](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/apps/desktop/src/main.ts),
[supervisor](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/core/src/command-supervisor.ts)).
Extract those orchestration functions behind a testable application-service
interface, then have both renderer IPC and the new local server call that same
interface. This gives the UI and automation one source of truth and leaves a
clean seam for moving the control plane into its own daemon later.

Do **not** move runtime ownership into the existing gate daemon for this first
version. The gate is deliberately a small, Electron-free, always-on router; its
socket currently knows only route status/set/suspend/remove plus pushed wake and
route-failure events
([gate design](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/docs/GATE.md),
[gate protocol](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/gate/src/control-protocol.ts)).
Making it the lifecycle owner would either duplicate desktop discovery and
settings or require a substantially larger ownership migration than Issue #9
needs. A relay through the gate would also introduce a second RPC hop without
removing the desktop dependency.

## Current Silvic facts to preserve

- **Verified:** `WorkspaceRegistry` replaces transient path-derived IDs with
  persisted UUIDs and reconciles them across path moves when it can match a
  unique project/branch. Expose `ProjectSnapshot.id` and the reconciled
  `workspaceId` as machine identifiers; use the recipe command key as a runtime
  ID scoped to that workspace
  ([workspace registry](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/core/src/workspace-registry.ts),
  [contracts](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/contracts/src/index.ts)).
- **Verified:** `CommandSupervisor.start()` is already a no-op for starting,
  running, or stopping entries; `stop()` is a no-op when nothing is active.
  For an externally owned listener, stop removes Silvic's route and local state
  without calling `process.kill()`. `output()` already returns a bounded 20,000
  character tail
  ([supervisor](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/core/src/command-supervisor.ts)).
- **Verified:** current readiness waits until the serving runtime state is
  `running` and the canonical HTTP(S) address answers, with a default 60-second
  deadline and 500 ms polling interval
  ([desktop orchestration](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/apps/desktop/src/main.ts),
  [readiness helper](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/core/src/readiness.ts)).
- **Verified:** the existing gate protocol is newline-delimited JSON with
  numeric request IDs, request timeouts, fragmented-frame buffering, and a
  64,000-character receive cap. These are useful local precedents, but its
  parser silently drops malformed requests and the server does not explicitly
  version the protocol
  ([gate client](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/gate/src/client.ts),
  [gate server](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/gate/src/control.ts)).

## Technology baseline: current as of the check date

- **Verified:** MCP `2026-07-28` is the latest dated protocol revision. It
  removes protocol-level sessions/initialization for the modern wire format and
  makes requests self-contained; the Tier 1 SDKs support it
  ([MCP release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)).
- **Verified:** the official TypeScript SDK v2 is the stable line implementing
  that revision. New server code uses the split
  `@modelcontextprotocol/server` package; v2 replaces the monolithic v1 package
  ([SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/),
  [server package](https://ts.sdk.modelcontextprotocol.io/v2/api/%40modelcontextprotocol/server/),
  [2.0.0 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/%40modelcontextprotocol/server%402.0.0)).
- **Verified:** a stdio server should use
  `serveStdio(() => buildServer())`. That entry point can negotiate the modern
  `2026-07-28` era while preserving legacy clients; directly connecting an
  `McpServer` to `StdioServerTransport` remains on the 2025-era wire
  ([2026-07-28 SDK support](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)).
- **Verified:** MCP stdio reserves stdout exclusively for newline-delimited,
  UTF-8 JSON-RPC messages; server logging belongs on stderr. The official SDK
  warns that even one `console.log` corrupts the protocol stream
  ([MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio),
  [TypeScript server tutorial](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)).
- **Verified:** Zod v4 schemas work directly with SDK v2. `registerTool`
  derives advertised JSON Schema and validates arguments; `outputSchema` plus
  `structuredContent` gives validated machine-readable results; tool annotations
  describe read-only, destructive, idempotent, and open-world behavior
  ([SDK tools](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html)).
- **Verified:** Silvic already targets Node `>=22`, TypeScript 7, and Zod 4
  ([root package](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/package.json),
  [contracts package](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/contracts/package.json)).
  Node 24 is the current LTS line while Node 26 is Current, so packaged
  standalone artifacts should be built and tested against Node 24 without
  unnecessarily dropping the repository's Node 22 compatibility
  ([Node release schedule](https://nodejs.org/en/about/previous-releases)).
- **Verified:** Node's built-in `util.parseArgs()` is stable and strict by
  default, so this focused CLI does not need another argument-parser dependency
  ([Node `parseArgs`](https://nodejs.org/download/release/latest-v24.x/docs/api/util.html#utilparseargsconfig)).

## Local automation protocol

**Recommendation:** create a shared package containing strict Zod request,
response, result, and error schemas plus an `AutomationClient`. Use JSON-RPC 2.0
objects framed as one JSON value per line over a Unix domain socket. This keeps
request correlation and errors conventional while matching Silvic's proven
local framing and MCP's reliable-stream framing. Include a protocol revision
and server/app version in an initial `system/hello` result so an old CLI fails
with an actionable version-mismatch error rather than misreading a newer shape.

Suggested method surface:

| Method           | Purpose                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `projects/list`  | Watched projects and stable IDs                                                            |
| `plots/list`     | Plots, project IDs, stable workspace IDs, names, paths                                     |
| `plot/status`    | Declared and supervised runtimes, routes, ownership, readiness, diagnostics, canonical URL |
| `runtimes/start` | All declared/auto-start runtimes or one runtime ID                                         |
| `runtimes/stop`  | All active runtimes or one runtime ID                                                      |
| `preview/wait`   | Wait only; never start implicitly; return canonical URL when ready                         |
| `runtime/logs`   | Bounded recent output with truncation metadata                                             |

Paths and display names can be optional ergonomic selectors in the CLI, but the
wire protocol should require stable IDs and reject ambiguous selectors. Every
ID must be resolved against the authoritative current snapshot and recipe; the
socket must never accept arbitrary filesystem paths or shell command strings.
That retains the same trust boundary as current renderer IPC, whose mutations
revalidate requests against known workspaces
([architecture](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/docs/ARCHITECTURE.md),
[desktop validation](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/apps/desktop/src/main.ts)).

### Desired-state and partial-failure contract

**Recommendation:** start and stop must return per-runtime outcomes, never just
`void`:

```json
{
  "status": "partial",
  "runtimes": [
    {
      "runtimeId": "web",
      "before": "stopped",
      "after": "running",
      "outcome": "started",
      "ownership": "silvic"
    },
    {
      "runtimeId": "convex",
      "before": "failed",
      "after": "failed",
      "outcome": "failed",
      "diagnostics": ["Exited with code 1"]
    }
  ]
}
```

Use the outcomes `started`, `already-running`, `stopped`, `already-stopped`,
`detached`, and `failed`. Repeated start/stop succeeds as a no-op. A multi-
runtime operation does not roll back successful siblings; it reports top-level
`ok`, `partial`, or `failed`. Serialize desired-state changes per
workspace/runtime so concurrent start/stop calls cannot race. A start received
while the runtime is stopping should wait for the stop to settle and then
ensure the requested running state, rather than returning before the desired
state exists.

For `ownership: "external"`, stop must return `outcome: "detached"`, remove the
Silvic route, and never signal the process. This makes the existing safety
behavior explicit and testable
([current external-stop branch](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/packages/core/src/command-supervisor.ts)).

### Availability, cancellation, and security

**Recommendation:** the CLI should connect first, then launch the installed app
in a non-focusing automation mode and retry for a short bounded interval when
the socket is absent. Automation must call runtime start with
`interactive = false`; it must never open a picker, focus a window, or cause an
administrator/certificate prompt. Missing gate setup becomes a structured,
actionable diagnostic telling the person which explicit UI setup is required
([current interactive boundary](https://github.com/sieversjosua/Silvic/blob/76a4837752cd533f2daf5a8291c43781e79ae3af/apps/desktop/src/main.ts)).

Place the socket under a short per-user state path because macOS Unix-socket
paths are typically limited to 103 bytes. A crashed process can leave the
filesystem entry behind, so startup must probe an existing socket before
unlinking only a proven-stale entry. Explicitly create the parent directory as
`0700` and `chmod` the listening socket to `0600`; do not rely on the user's
`umask`. Enforce a maximum frame size, cap pending requests, apply method
deadlines, and honor `socket.write()` backpressure
([Node IPC sockets](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html#ipc-support)).

Propagate cancellation from CLI `SIGINT`, client disconnects, MCP request
signals, and request deadlines down through socket calls and readiness polling.
`AbortSignal.timeout()` and `AbortSignal.any()` are stable in the supported Node
lines
([Node `AbortSignal`](https://nodejs.org/download/release/latest-v24.x/docs/api/globals.html#static-method-abortsignaltimeoutdelay)).
Bound logs by both requested lines/bytes and a server-side hard maximum; return
`truncated`, byte count, runtime state, and diagnostic hints alongside the text.

## CLI contract

**Recommendation:** human-readable output may remain the TTY default, but every
command—not only reads—should support `--json` and emit exactly one versioned
JSON document on stdout. Human diagnostics and debug logging go to stderr. No
command may prompt or depend on a TTY.

Suggested commands are deliberately isomorphic to the local methods:

```text
silvic projects list --json
silvic plots list --project-id <id> --json
silvic plot status --plot-id <workspace-id> --json
silvic runtime start --plot-id <workspace-id> [--runtime-id web] --json
silvic preview wait --plot-id <workspace-id> [--timeout 60s] --json
silvic runtime logs --plot-id <workspace-id> --runtime-id web --json
silvic runtime stop --plot-id <workspace-id> [--runtime-id web] --json
```

Document stable application exit codes below 126:

| Code | Meaning                                           |
| ---: | ------------------------------------------------- |
|  `0` | Success, including an idempotent no-op            |
|  `2` | CLI usage or schema error                         |
|  `3` | Control plane unavailable or incompatible version |
|  `4` | Project, Plot, or runtime not found               |
|  `5` | Operation failed                                  |
|  `6` | Partial multi-runtime failure                     |
|  `7` | Readiness deadline exceeded                       |

Set `process.exitCode` and let stdout/stderr flush; Node warns that immediate
`process.exit()` can truncate asynchronous writes
([Node process exit](https://nodejs.org/download/release/latest-v24.x/docs/api/process.html#processexitcode)).

## MCP server and Codex plugin

**Recommendation:** use `@modelcontextprotocol/server` v2,
`registerTool()`, Zod v4 `inputSchema`/`outputSchema`, and
`serveStdio(() => buildServer())`. Each handler calls the shared
`AutomationClient`; it must not shell out to the CLI. Return the same result
envelope in `structuredContent` and as compact JSON text for compatibility.
Domain failures return a valid result with `isError: true`; malformed arguments
and unknown tools remain SDK/protocol errors
([SDK tools and errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html)).

Expose a small, explicit tool set matching the methods above. Annotations should
be truthful:

| Tools                                 | Annotations                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| list, status, logs, diagnostics, wait | `readOnlyHint: true`, `openWorldHint: false`                                                    |
| start                                 | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` |
| stop                                  | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`  |

Keep start and stop separate so their safety annotations remain accurate. Wait
is read-only and should not hide a start side effect. MCP annotations are client
hints rather than enforcement, so server-side ownership and identifier checks
remain mandatory
([tool annotations](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html#annotate-the-tool)).

**Verified:** OpenAI defines a plugin as an installable package containing
skills, an MCP server, or both, and recommends a combined skill + MCP server
when workflow guidance should teach the model how to sequence MCP tools
([OpenAI plugin architecture](https://developers.openai.com/plugins/concepts/plugins)).
The distributable folder requires `.codex-plugin/plugin.json` and may include a
`skills/` directory plus `.mcp.json` for a locally distributed MCP server
([OpenAI packaging guide](https://developers.openai.com/plugins/build/plugins)).

Recommended plugin shape:

```text
plugins/silvic/
├── .codex-plugin/plugin.json
├── .mcp.json
├── bin/silvic-mcp
└── skills/
    └── silvic-preview/
        └── SKILL.md
```

The skill should be short and operational: list/select by stable ID, start,
wait, inspect the returned canonical URL, inspect/log only when needed, then
stop. It must state that wait never starts a runtime, partial results require
inspection, and external stop only detaches the Silvic route. OpenAI's guidance
puts tool sequences, decision points, and safety boundaries in the skill while
keeping live data and controlled actions in the MCP server
([OpenAI skill guide](https://developers.openai.com/plugins/build/skills)).

## Verification bar

**Recommendation:** the implementation is not complete until all of these are
covered:

1. **Application service:** stopped, starting, ready, failed, partially
   running, and externally managed states; repeated start/stop; concurrent
   opposing requests; named-route setup unavailable non-interactively; wait
   success/timeout/cancel; stable canonical URL; external stop asserts no
   process signal.
2. **Local protocol:** fragmented and coalesced frames, malformed and oversized
   frames, concurrent IDs, bounded pending requests, write backpressure,
   disconnect cancellation, stale socket recovery, permissions, and
   app/client protocol-version skew. Node documents both persistent crash-stale
   socket paths and stream backpressure behavior
   ([Node net](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html)).
3. **CLI subprocess:** stdout is one valid JSON document, stderr stays separate,
   every exit-code mapping is exact, partial aggregates remain parseable, and
   `SIGINT` cancels a wait without corrupting output.
4. **MCP subprocess:** deterministic `tools/list` schemas and annotations,
   structured success and error calls, absolutely clean stdout, cancellation,
   and both modern `2026-07-28` and legacy negotiation through `serveStdio`.
   Use the official MCP Inspector for manual smoke tests and SDK-level spawned
   stdio tests in CI
   ([MCP server tutorial](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server),
   [MCP conformance project](https://github.com/modelcontextprotocol/conformance)).
5. **Packaging:** the installed app can launch the CLI/control mode without UI,
   the plugin's relative MCP command resolves from an installed plugin, and the
   packaged build contains every launcher and bundled JavaScript dependency.

## Implementation order

1. Extract a runtime/preview application service from desktop `main.ts`; put
   result contracts in `@silvic/contracts` and add the required state matrix.
2. Add the shared versioned automation protocol, private Unix-socket server,
   and client; test framing, cancellation, security, and version skew.
3. Add the CLI as a pure adapter and lock its JSON/exit-code contract with
   subprocess tests.
4. Add the SDK v2 stdio MCP server over the same client and verify both protocol
   eras.
5. Package `.codex-plugin/plugin.json`, `.mcp.json`, the focused preview skill,
   and launchers; run the representative flow end to end from a packaged build.

This order establishes one authoritative automation surface first. CLI and MCP
then become small projections of an already-tested contract rather than two new
implementations of Silvic lifecycle behavior.
