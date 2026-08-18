# Silvic Gate

Silvic Gate is the local router that serves every plot's named URL —
`https://{command}-{plot}-{project}.localhost` — independently of the Silvic
app's lifecycle. It replaces the external `portless` dependency.

## Why a separate daemon

The previous design proxied preview traffic through a bridge inside the
Electron main process and pointed a portless alias at it. Quitting or updating
Silvic killed the bridge, so every URL died even while the dev servers kept
running. Portless itself had to be installed globally by hand, was invisible
to Silvic's PATH resolution on fresh machines, and its certificate trust was
never verified.

The gate inverts this: a small always-on daemon owns the URLs, and the Silvic
app is just one of its clients.

## Architecture

```
browser ──443──▶ pf rdr (lo0 only) ──▶ gate :42443 (HTTPS, SNI per host)
                                          │
                                          ├─ route table  ~/Library/Application Support/silvic-gate/routes.json
                                          ├─ proxy ──▶ 127.0.0.1:<upstream>   (dev server found by Silvic)
                                          ├─ holding page + wake when the upstream is down
                                          └─ control socket  gate.sock  ◀── Silvic app
```

### Components

- **Daemon process.** A user LaunchAgent (`dev.silvic.gate`), running the
  installed Silvic app as plain Node (`ELECTRON_RUN_AS_NODE=1 … gate.js`).
  `gate.js` is bundled self-contained (node builtins only) and unpacked from
  the asar so a bare Node runtime can read it. `KeepAlive` restarts it after
  crashes and after app updates replace the file; the LaunchAgent path never
  changes, so updates never touch launchd again.
- **Port 443.** A pf `rdr` rule redirects loopback TCP 443 → 127.0.0.1:42443
  (and ::1 for IPv6). The rule lives in an anchor under `com.apple/250.SilvicGate`,
  which macOS's default `rdr-anchor "com.apple/*"` evaluates without editing
  `/etc/pf.conf` — the same mechanism Pow and puma-dev used for a decade. A
  root LaunchDaemon (`dev.silvic.gate.pf`) reloads the anchor at boot. No
  Silvic code ever runs as root; the privileged pieces are declarative files.
- **TLS.** The gate maintains its own local CA in the state directory and
  issues per-hostname leaf certificates on demand in the SNI callback, using
  the system `/usr/bin/openssl` (LibreSSL). Leafs live 397 days and are
  reissued when < 30 days remain. The CA root is trusted in the user's trust
  settings during setup; Silvic verifies trust with `security verify-cert`
  instead of assuming it.
- **Route table.** `routes.json` maps route name → upstream port plus the plot
  path and command id that own it. It is persisted on every change, so routes
  survive reboots. The upstream port is ephemeral (dev servers move); the
  name, plot path, and command id are durable.
- **Control socket.** Newline-delimited JSON over a unix socket
  (`gate.sock`, mode 0600). Silvic registers, updates, and removes routes and
  receives wake events. The daemon answers `status` for health checks.
- **Proxy behaviour.** Identical to the old in-process bridge: upstream
  requests carry `Host`/`X-Forwarded-Host` = public host,
  `X-Forwarded-Proto: https`, `X-Forwarded-Port: 443`; `Location` headers
  pointing at the upstream loopback port are rewritten back to the public
  origin; WebSocket upgrades are piped through raw.

### Wake-on-URL

A request for a known route whose upstream is missing or refuses connections
gets an immediate `503` holding page that polls `/__silvic/route-status` and
reloads when the upstream answers. In parallel the gate wakes the owner:

1. If a Silvic app is connected to the control socket, it receives
   `{"type":"wake","route":…,"plotPath":…,"commandId":…}` and starts the
   plot's commands.
2. Otherwise the gate spawns `open -a Silvic --args --silvic-wake=<route>`;
   the app handles the argument on launch (or via second-instance) the same
   way.

Wakes are debounced per route (30 s) so a polling holding page cannot stampede
the app. Unknown hosts get a distinct page listing the registered routes.

### What stays in Silvic

Listener discovery is unchanged: the supervisor still watches the command's
process tree, probes candidates, and picks the browser-facing listener
(`packages/core/src/named-route.ts`). Publishing now means telling the gate
"route X → port N" over the control socket instead of running
`portless alias`. Health checks compare the direct upstream and the named URL
exactly as before.

## Setup

One-time, run automatically the first time a plot needs a named URL:

1. **Agent step** (no prompt): write and bootstrap the user LaunchAgent; if
   launchd refuses (managed Macs), the gate is spawned directly instead.
2. **Admin step** (native password prompt via osascript): write the pf anchor
   and its boot LaunchDaemon, then load the anchor.
3. **Trust step** (its own macOS dialog, as the user): add the gate CA to the
   user's trust settings. This is deliberately not part of the root script —
   admin-domain trust settings refuse non-interactive authorization (-60005)
   even for root, while the user domain may ask the person directly. Browsers
   honour user-domain roots the same way.

Every step is idempotent; `gate.js doctor` re-checks each piece (agent
running, 443 answering, cert trusted, control socket reachable) and reports
what is missing. Silvic's availability check consumes the same doctor.

## State directory

`~/Library/Application Support/silvic-gate/`

| File                     | Purpose                  |
| ------------------------ | ------------------------ |
| `routes.json`            | persistent route table   |
| `ca/ca.pem`, `ca/ca.key` | local CA (key `0600`)    |
| `certs/<host>.pem/.key`  | issued leaf certificates |
| `gate.sock`              | control socket           |
| `gate.log`               | daemon log               |

## Non-goals

- **Safari.** Safari does not resolve `*.localhost` names; Chrome, Edge,
  Firefox, and every CLI tool do. Synchronising `/etc/hosts` per route would
  need root on every route change, which this design deliberately avoids.
- **Other machines / phones.** The gate binds loopback only.
