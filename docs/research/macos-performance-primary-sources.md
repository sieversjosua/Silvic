# macOS performance and energy research for Silvic

Checked: 2026-08-09

## Scope and evidence standard

Silvic is an Electron 43 app with a React 19 renderer, not a native AppKit or
SwiftUI app. The analysis below therefore combines Apple platform guidance with
the official documentation of Electron, React, Zustand, Node.js, Git, and
`electron-store`. No secondary sources are used.

The macOS battery-menu label **“Significant Energy Usage” is a symptom, not a
diagnosis**. Apple's Energy Impact score includes CPU, networking, disk I/O, and
other factors. Apple recommends correlating Power Profiler with CPU Profiler /
Time Profiler to identify the responsible subsystem and code path ([Apple:
Monitor Usage Regularly](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/MonitoringEnergyUsage.html),
[WWDC25: Profile and optimize power usage](https://developer.apple.com/videos/play/wwdc2025/226/)).

Statements labelled **Verified guidance** are direct claims from primary
documentation. Statements labelled **Silvic inference** are conclusions drawn
from the current code and must be confirmed by measurement.

## Executive finding

The highest-probability energy bottleneck is Silvic's foreground 30-second full
snapshot poll. One poll recursively walks every configured discovery root, runs
multiple Git processes per repository and worktree, scans connector files,
periodically calls GitHub, queries Codex's SQLite database, and periodically
enumerates every listening TCP socket and its process metadata. The resulting
snapshot is then persisted, serialized through IPC twice, and causes several
global React-store updates.

This architecture conflicts directly with Apple's central recommendation: an
app should be absolutely idle when not responding to user input, should not poll
for state changes, and should batch and prioritize necessary work ([Apple:
Energy Best Practices](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/BestPractices.html)).

The first implementation goal should therefore be **idle means idle**: replace
the global periodic sweep with event-driven, targeted invalidation plus an
explicit or low-frequency reconciliation fallback. Do this before micro-
optimizing individual React components.

## Measured baseline on the affected machine

The reproducible harness in
`packages/core/src/performance.live.test.ts` exercises the real Git and connector
pipeline against the current Electron settings while redacting every path and
repository identity. These are local measurements, not universal performance
numbers; wall time varied with system load.

- Configuration: 3 roots, 69 discovered checkout/worktree paths, 47 unique
  projects, 114 unique workspaces, 3 active projects, 54 workspaces belonging to
  active projects, and 103 GitHub-backed workspaces.
- Repository discovery itself took only 19–71 ms. The broad directory walk is
  therefore not the current leading cost on this dataset.
- One Git-only unchanged refresh took 3.0–5.3 seconds and launched exactly 565
  Git processes: 358 `git status`, 69 `git worktree list`, 69
  `git for-each-ref`, and 69 `git remote get-url`.
- The unique snapshot contains only 114 workspaces, so 244 of the 358 status
  processes (68%) are redundant reads caused by discovering multiple worktrees
  from the same repository family.
- A cold connector-enriched refresh took 15.3 seconds and launched 715 child
  processes. The 114 `gh pr view` calls alone accumulated 52.1 seconds of child
  time under concurrency.
- The immediately repeated cached refresh still took 1.57 seconds and launched
  589 processes. It repeated all 565 Git calls, 23 failed GitHub calls, and one
  SQLite query. Convex observation still ran for all 114 workspaces.
- The Git-only snapshot serialized to 111,600 bytes. The current settings file
  is 74,350 bytes, of which the compact `workspaceRecords` value is 32,002 bytes.
  Each unchanged publish currently rewrites that file and sends the snapshot by
  push IPC as well as the invoke response.
- A 38-second `top` sample while the packaged window was visible but occluded
  showed the long-lived Electron processes near idle (0–0.7 Power). That is
  consistent with the existing Page Visibility gate. It does not include the
  transient child-process fan-out in the parent rows and therefore does not
  invalidate the sweep measurements or explain away the macOS historical energy
  label.

At a 30-second visible-window cadence, the unchanged Git path alone projects to
67,800 Git process starts per hour. With the observed cache behavior, successful
GitHub lookups run about every two minutes while 23 failures retry every sweep.
This projection explains why short idle samples can look quiet while macOS still
reports significant energy use over a longer window.

## Implemented remediation and post-fix measurement

The baseline above is intentionally retained as the before-state. The following
changes were implemented and tested against the same three-root settings file:

- The 30-second full poll was removed. Local changes now enter a debounced dirty
  set through recursive, non-persistent `fs.watch()` watchers. Only affected
  repository roots are re-read, and hidden renderers accumulate one catch-up
  instead of doing background work. Remote observations reconcile every five
  minutes only while visible.
- Linked worktrees are grouped by their real shared `.git` directory before any
  Git command runs. Repository snapshots are cached by roots and enrichment
  scope, and connector enrichment is restricted to the three active projects.
- GitHub PRs are fetched once per active project rather than once per workspace;
  non-GitHub origins are skipped and failures use exponential backoff. Convex
  and local-context reads are cached with scoped invalidation. Listener `lsof`
  and `ps` follow-ups are batched into one process each rather than one pair per
  listener.
- Startup now publishes the Git snapshot first, then enriches active projects
  without scanning Git again. Manual refresh remains a correctness escape hatch.
- Snapshot publication compares semantic content, writes workspace records only
  when changed, and uses push IPC as the single snapshot delivery path. Zustand
  updates and React subscriptions were narrowed so unchanged or unrelated state
  does not fan out across the whole interface.
- Main-process process inspection and login-shell PATH discovery are asynchronous.
  Captured command output is bounded while preserving its head and tail. The
  continuously running plot sweep animation was removed.

Post-fix live results (wall time still varies with machine load):

- An unchanged warm Git refresh: **0 ms, 0 child processes**, down from 3.0–5.3
  seconds and 565 Git processes. This is enforced by a regression budget of at
  most 2 seconds and 25 process starts.
- Initial Git paint: **397–960 ms and 276 Git processes**. It is now the only
  broad Git read at startup; the interface can paint from it without waiting for
  network observations.
- Cold enrichment of the 54 active workspaces: **3.05 seconds and 8 child
  processes**, including 3 batched GitHub calls and one each for the local
  SQLite/listener/process queries. The old all-project refresh took 15.3 seconds
  and 715 child processes.
- Cached active-project enrichment: **37 ms and 0 child processes**. The former
  immediate repeat took 1.57 seconds and 589 child processes.

These measurements prove removal of the measured periodic fan-out. A packaged
idle soak and Instruments Power Profiler trace remain the appropriate final
system-level check because macOS Energy Impact also includes Chromium/GPU work,
networking, and wakeups outside the refresh pipeline.

The bottleneck sections below intentionally document the pre-remediation code
paths and evidence that motivated each change. Their historical line numbers no
longer describe the post-fix files.

## P0 — 30-second full snapshot poll

### Exact code path

- `apps/web/src/App.tsx:127-154` starts `refresh()` every 30 seconds while the
  document is visible.
- `apps/desktop/src/main.ts:1390-1421` turns that into
  `ProjectService.snapshot()`.
- `packages/core/src/project-service.ts:28-119` performs repository discovery,
  Git reads, and connector enrichment for every workspace.
- `packages/core/src/project-service.ts:122-174` recursively traverses each
  configured root until it finds a `.git` entry.
- Default roots are broad (`~/01_Local_Workspace` and `~/Developer`) in
  `apps/desktop/src/main.ts:1582-1585`.
- `packages/core/src/git.ts:28-138` runs three Git commands per discovered
  repository (`worktree list`, `remote get-url`, `for-each-ref`) plus one
  `git status` per registered worktree. In formula form, the Git-only floor is
  **3R + W child processes per poll** for R repositories and W worktrees.
- `connectors/convex/src/index.ts:20-124` recursively scans every workspace to
  depth four for `.env.local` on every poll.
- `connectors/github/src/index.ts:113-180` runs one `gh pr view` network process
  per workspace when its two-minute cache expires.
- `connectors/local/src/index.ts:32-167` runs one SQLite CLI query every poll and,
  each minute, enumerates all TCP listeners with `lsof`, the process tree with
  `ps`, then another `lsof` and `ps` pair per listener seed.

### Verified guidance

- A timer wake takes the CPU and other hardware out of low-power idle; Apple
  explicitly calls polling for state changes an unnecessary timer pattern and
  recommends event notifications instead ([Apple: Minimize Timer
  Usage](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)).
- Apple's energy guide says CPU work should happen only when necessary through
  batching, scheduling, and prioritization. Disk writes and networking should
  also be reduced and batched ([Apple: Fundamental
  Concepts](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/FundamentalConcepts.html)).
- On macOS, Node's `fs.watch()` uses FSEvents for directories. It supports
  recursive watching and cancellation via `AbortSignal`; Node also states that
  `fs.watch()` is more efficient than stat polling ([Node: File system /
  `fs.watch`](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)).
- Electron maps macOS window occlusion into the Page Visibility API and
  recommends pausing expensive work when visibility is `hidden` to minimize
  power consumption. `backgroundThrottling` is enabled by default
  ([Electron: BrowserWindow, Page
  visibility](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility)).

### Silvic inference and recommended change

Replace the fixed global poll with a three-level model:

1. **Event-driven dirty set.** Install recursive, non-persistent `fs.watch()`
   watchers only for configured local roots and known Git metadata locations.
   Debounce bursts and mark only affected repositories/workspaces dirty. Do not
   run a full snapshot from the watcher callback.
2. **Targeted refresh.** Re-read Git and connector state only for dirty targets.
   Known user actions (create, teardown, delivery, start/stop) already identify
   the affected project and should invalidate that target directly.
3. **Correctness reconciliation.** Keep an explicit Refresh action and a much
   less frequent, tolerant reconciliation only while visible, because Node
   documents caveats for inode replacement, missing filenames, network file
   systems, and virtualized file systems. Resume with one coalesced catch-up,
   not N missed polls.

Do not silently modify users' repository settings. If filesystem events alone
cannot deliver the required Git semantics, offer or document Git's own
`core.fsmonitor` and `core.untrackedCache` options rather than enabling them
without consent. Git documents that `git status` can be very slow in large
worktrees and that these features avoid scanning unchanged files/directories
([Git: status, untracked files and
performance](https://git-scm.com/docs/git-status#_untracked_files_and_performance),
[Git: fsmonitor daemon](https://git-scm.com/docs/git-fsmonitor--daemon)).

For a cheap background tier, consider `git status --untracked-files=no` and run
the full untracked-file count only for the selected workspace or explicit
refresh. Git calls `--untracked-files=no` the fastest option, but this changes
the information returned, so it is a product tradeoff rather than a transparent
optimization.

### Existing good behavior to preserve

`App.tsx:140-153` already stops the interval when `document.hidden` and catches
up when visible. This follows Electron's official macOS occlusion guidance.
Preserve this lifecycle gate around any fallback reconciliation. Do not disable
Electron's default `backgroundThrottling`.

## P0 — duplicate worktree discovery creates quadratic Git status fan-out

### Exact code path and measurement

`discoverRepositories()` returns every checkout and linked worktree found under
the configured roots. `ProjectService.snapshot()` then calls `readRepository()`
for all 69 returned paths in parallel. Each call runs `git worktree list` and
then `git status` for every registration in that shared repository family. Only
after all this work does `ProjectService` group by `projectId` and deduplicate the
resulting workspace objects.

This produced 358 status calls for 114 unique workspaces. When all `n` worktrees
of one repository are discovered and each read enumerates the same `n`
registrations, that family performs `n²` status calls rather than `n`.

### Verified guidance

Git exposes the canonical shared administrative directory for a linked-worktree
family through `git rev-parse --path-format=absolute --git-common-dir`. It also
documents `--resolve-git-dir` for resolving a `.git` file to the real repository
directory ([Git: `rev-parse`](https://git-scm.com/docs/git-rev-parse#Documentation/git-rev-parse.txt---git-common-dir)).

### Silvic inference and recommended change

Coalesce candidates by their resolved Git common directory before the expensive
repository read. Read `worktree list`, remote metadata, and refs once per family;
then run at most one status per unique registered worktree. The initial fix
should make the measured count approach `3P + W` (three family-level commands
for P unique repository families plus one status for each of W unique
workspaces), reducing this dataset from 565 toward 255 Git processes even before
incremental refresh is implemented.

The complete solution is to cache family metadata and status results, mark only
affected families/worktrees dirty, and run zero Git commands for a semantically
unchanged warm refresh. Add a regression assertion that no workspace path is
statused more than once per refresh.

## P0 — connector work covers inactive suggestions and retries failures eagerly

### Exact code path and measurement

Connector enrichment runs for every discovered workspace, including projects
shown only as inactive suggestions. On this machine only 3 of 47 projects are
active, yet all 114 workspaces received GitHub, Convex, and local-context
observations.

The cold measurement launched 114 `gh pr view` processes. The immediately
repeated measurement launched another 23: `createGitHubConnector()` deletes a
rejected promise from its cache, so every persistent or unsupported failure is
retried on every 30-second sweep. Convex has no cache and recursively searches
all 114 workspaces to depth four each time. The local task shelf is only three
seconds long; during the 15-second cold snapshot it expired often enough to
launch four SQLite queries inside one logical refresh.

### Verified guidance

The GitHub CLI can list pull requests and return fields including head branch,
head OID, state, draft status, URL, and status-check rollup in one repository-
level command ([GitHub CLI: `gh pr list`](https://cli.github.com/manual/gh_pr_list)).
Apple's networking guidance favors reducing transactions and batching related
requests rather than issuing many small independent operations.

### Silvic inference and recommended change

- Enrich only active projects by default; enrich the selected project first.
  Suggestions need cheap repository identity, not live PR/deployment/runtime
  observations.
- Replace per-workspace `gh pr view` with one bounded `gh pr list --json ...`
  per active GitHub project and map results by `headRefName`. Skip the connector
  entirely for non-GitHub origins.
- Cache stable negative answers. Retry transient failures with capped exponential
  backoff and jitter rather than deleting them immediately; an explicit refresh
  may bypass the backoff for the selected project.
- Cache Convex observations by workspace and invalidate them only when relevant
  environment files change. Avoid walking the same workspace tree on every poll.
- Give every snapshot a shared observation context so global listener and Codex
  task reads are performed at most once per logical refresh, irrespective of how
  long that refresh takes.

## P0 — global invalidation turns local events into full network and I/O sweeps

### Exact code path

`refreshSnapshot(true)` first calls `connectors.invalidate()` without an ID at
`apps/desktop/src/main.ts:1390-1394`. It is invoked after many narrowly scoped
actions. Most importantly, every command-supervisor change schedules it after
750 ms at `apps/desktop/src/main.ts:152-166`. The callback first invalidates only
`local-context`, but the subsequent forced refresh clears **every** connector
cache, including all GitHub PR caches for all workspaces.

### Verified guidance

Apple recommends reducing and batching network transactions and avoiding
redundant transfers ([Apple: Minimize
Networking](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/MinimizeNetworking.html)).
Electron likewise recommends avoiding unnecessary network requests and measuring
them in the DevTools Network panel ([Electron: Performance](https://www.electronjs.org/docs/latest/tutorial/performance#6-unnecessary-or-blocking-network-requests)).

### Silvic inference and recommended change

Make invalidation addressable by connector plus project/workspace. A local
runtime start/stop should refresh local runtime observations for its one
workspace; it should not discard GitHub and Convex caches globally. Separate
`forceGit`, `forceLocalContext`, and `forceRemote` semantics, and preserve
unrelated cache entries across snapshot assembly.

## P0 — launch performs two broad scans and blocks the Electron main process

### Exact code path

- Startup calls `paintFromGit(settings.get("roots"))` and immediately afterwards
  `refreshSnapshot()` at `apps/desktop/src/main.ts:230-233`. Both perform the same
  recursive repository discovery and Git read; the second adds connectors.
- The first child command calls `resolvedCommandPath()` which runs synchronous
  `spawnSync("/bin/zsh", ["-ilc", ...])` with a five-second timeout in
  `packages/core/src/command-runner.ts:71-90`.

### Verified guidance

Electron says to defer work not required immediately, allocate resources just in
time, never block the main process, and prefer asynchronous Node I/O/process APIs
([Electron: Performance, sections 2 and
3](https://www.electronjs.org/docs/latest/tutorial/performance#2-loading-and-running-code-too-soon)).
Apple likewise recommends loading only what is needed for the first usable
screen and deferring unnecessary initialization ([Apple: Reducing app launch
time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time)).

### Silvic inference and recommended change

- Persist the last validated snapshot and paint it immediately, then perform one
  incremental reconciliation. If stale cached state is not acceptable, share a
  single discovery/Git result between fast paint and connector enrichment
  instead of re-running discovery and Git.
- Remove `spawnSync` from the main-process request path. Resolve the login PATH
  asynchronously once, cache it, or perform that work in a utility/worker process.
- Defer updater and remote connector work until after first interaction/idle;
  the existing 10-second updater delay is already reasonable.

## P0 — every snapshot causes an unconditional full settings-file rewrite

### Exact code path

`publishSnapshot()` calls `settings.set("workspaceRecords", ...)` on every
publish at `apps/desktop/src/main.ts:1424-1437`, without checking whether the
records changed. This includes the 30-second poll and both launch snapshots.

The official `electron-store` documentation says the entire JSON file is read
and written on every change; it is intended for small settings rather than a
database ([electron-store README](https://github.com/sindresorhus/electron-store#readme)).

### Verified guidance

Apple recommends writing only when content changes and aggregating writes rather
than frequently writing small state changes ([Apple: Minimize
I/O](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/MinimizingIO.html)).

### Silvic inference and recommended change

Compare reconciled records with the persisted value and skip `set` when they are
semantically identical. Batch related setting mutations into one `set(object)`
call. If workspace records grow beyond small settings, move that collection to a
storage format with incremental updates; do not migrate merely on speculation—
first measure write size and File Activity.

The Codex SQLite access is read-only and currently executed through an
asynchronous child process, so SQLite itself is not the primary persistence
bottleneck. The issue is its periodic process launch and query even when nothing
requested fresh task state.

## P1 — duplicate snapshot delivery and broad React invalidation

### Exact code path

- `publishSnapshot()` pushes the full graph over `snapshotChanged` at
  `apps/desktop/src/main.ts:1436` and also returns it as the result of
  `snapshotRefresh`.
- `apps/web/src/store.ts:67-70` handles the pushed snapshot, while
  `apps/web/src/store.ts:83-91` applies the same snapshot again when the invoke
  promise resolves. `setSelectionForSnapshot()` adds another state update each
  time. One poll therefore produces repeated commits for equivalent data.
- `apps/web/src/App.tsx:94-108` calls `useSilvic()` without a selector. Zustand's
  official docs warn that fetching the entire store updates the component on
  every state change ([Zustand README, “Fetching
  everything”](https://github.com/pmndrs/zustand#fetching-everything)).
- The root `App` owns a large component tree, including React Flow. Each snapshot
  is a new object graph, so memoized calculations depending on `project` are
  invalidated even when their semantic content did not change.
- Electron IPC serializes values with the Structured Clone Algorithm, so sending
  the graph twice also means duplicate serialization/deserialization work
  ([Electron: IPC object
  serialization](https://www.electronjs.org/docs/latest/tutorial/ipc#object-serialization)).

### Verified guidance

React recommends profiling before memoizing, selecting minimal props, keeping
state local, avoiding Effects that cause update chains, and using `memo`/
`useMemo` only where unchanged inputs make rendering skippable
([React: `memo`](https://react.dev/reference/react/memo),
[React: Profiler](https://react.dev/reference/react/Profiler)). Zustand recommends
selectors for computed state and `useShallow` when a multi-value selection is
shallow-equal ([Zustand: Prevent rerenders with
`useShallow`](https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow)).

### Silvic inference and recommended change

- Choose one snapshot transport. For periodic refresh, either return the value
  to the caller or publish it, not both. A useful contract is “commands return
  acknowledgement; snapshot changes arrive on one push channel.”
- Coalesce the Zustand update into one `set`, and do not replace `snapshot` if a
  stable revision/hash proves there is no semantic change.
- Split `App`'s whole-store subscription into atomic selectors. Keep React Flow
  subscribed only to the selected project's graph and process states it needs.
- Add stable snapshot/project/workspace revisions or structural sharing so an
  unchanged project retains object identity across refreshes.
- Use React DevTools Profiler / `<Profiler>` to compare `actualDuration` and
  render counts before and after; do not scatter `memo` blindly.

## P1 — synchronous 100 ms process-stop polling

### Exact code path

`CommandSupervisor.ensureStopped()` schedules up to 50 checks at 100 ms
intervals (`packages/core/src/command-supervisor.ts:250-275`). Every check calls
`stillRunning()`, which synchronously launches `ps` with `execFileSync()` and a
two-second timeout (`command-supervisor.ts:332-348`). This can create up to 50
subprocesses over five seconds per stopped command while repeatedly blocking the
Electron main process.

### Verified guidance

Apple says timers and repeated wakeups are costly and should be invalidated as
soon as no longer required ([Apple: Minimize Timer
Usage](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)).
Electron says never to block the main process and to prefer asynchronous process
and filesystem APIs ([Electron: Performance, “Blocking the main
process”](https://www.electronjs.org/docs/latest/tutorial/performance#3-blocking-the-main-process)).

### Silvic inference and recommended change

For processes spawned in the current session, rely on child `close`/`exit` events
and one grace-period deadline. For adopted processes, use asynchronous, batched
checks with exponential backoff (for example 250 ms, 500 ms, 1 s) and one final
SIGKILL deadline. Preserve the current PID-reuse protection, but do not implement
it with synchronous subprocess creation on the UI/main thread.

## P1 — continuous visible CSS animations

### Exact code path

Every running plot renders a forever-rotating 420 × 420 px conic-gradient pseudo
element (`apps/web/src/styles.css:1112-1151`). Provisioning adds another infinite
pulse (`styles.css:3047-3051`). `prefers-reduced-motion` disables them, but they
continue indefinitely for the default motion preference while visible.

### Verified guidance

Apple says every display update activates CPU/GPU/display resources; excessive
animations and updates are an energy cost, and invisible or obscured content
must not continue updating ([Apple: Avoid Extraneous Content
Updates](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/UsingEfficientGraphics.html)).
Electron/Chromium throttles background animations by default, and Silvic's
visibility handling preserves that behavior.

### Silvic inference and recommended change

Compositor transforms are preferable to per-frame gradient rasterization, as the
current comment notes, but compositor work is not free. Measure GPU power impact
with zero, one, and many running cards. If it scales materially, replace perpetual
motion with a static running-state treatment, animate only the selected/hovered
card, or run a short transition on state change and stop. The provisioning pulse
is short-lived and likely lower priority.

## P1 — development-only subscription leak can amplify every snapshot

### Exact code path

The root is wrapped in `StrictMode` (`apps/web/src/main.tsx:12-16`). In
`App.tsx:119-125`, the Effect starts asynchronous `initialize()`, initially stores
a no-op disposer, and replaces it only after the promise resolves. If Strict Mode
cleanup runs before resolution, cleanup has already consumed the no-op; the first
initialization can later install snapshot/process IPC listeners that are never
removed. A second Strict Mode setup installs another pair.

### Verified guidance

React states that Strict Mode performs an extra development-only setup/cleanup
cycle. Subscription cleanup must unsubscribe, and asynchronous effects must abort
or ignore late results ([React: `useEffect`](https://react.dev/reference/react/useEffect),
[React: Synchronizing with Effects](https://react.dev/learn/synchronizing-with-effects#subscribing-to-events)).

### Silvic inference and recommended change

Make initialization cancellation-safe: track cancellation, and if setup resolves
after cleanup, invoke its returned disposer immediately. Better, install the
singleton IPC subscriptions synchronously and keep initial data loading separate.
Keep Strict Mode; it is exposing a real lifecycle race. Confirm listener counts
in the development renderer. Production builds do not perform Strict Mode's
extra cycle, so this cannot by itself explain a packaged-build regression.

## P2 — unbounded command output is buffered before being sliced

### Exact code path

`LocalCommandRunner.run()` appends every stdout/stderr chunk to arrays and
`Buffer.concat`s all output (`packages/core/src/command-runner.ts:47-65`). The
provisioner slices the completed string to 20,000 characters only afterwards
(`packages/core/src/provisioner.ts:69-93`). Verbose installers can therefore
cause transient memory and copy costs far above the retained limit.

### Verified guidance

Electron recommends CPU and heap profiles and moving long-running work away from
the main process ([Electron: Performance](https://www.electronjs.org/docs/latest/tutorial/performance)).
Apple recommends Allocations/Memory Graph analysis for transient and persistent
memory growth ([WWDC24: Analyze heap memory and track reference
cycles](https://developer.apple.com/videos/play/wwdc2024/10173/)).

### Silvic inference and recommended change

Use a bounded head/tail or ring buffer during streaming, not after completion;
continue writing full runtime logs to disk where that is intentional. Decode
incrementally to avoid concatenating the entire output. This is a provisioning-
time performance issue, not the leading idle-energy explanation.

## Areas inspected but not currently implicated

- **SwiftUI/AppKit invalidation and event monitors:** none exist; Silvic's UI is
  React/Chromium. Native SwiftUI/AppKit optimization advice is therefore not
  actionable for this codebase.
- **WebSockets:** no WebSocket or EventSource client exists in the current repo.
  GitHub observations are short-lived `gh` subprocess/network calls.
- **App-owned SQLite:** Silvic owns no SQLite database. It launches `sqlite3` to
  read a bounded (`LIMIT 500`) query from Codex state. Optimize its refresh trigger
  and process reuse before considering database tuning.
- **Long-lived filesystem monitor:** none exists. The current problem is repeated
  traversal, not an overactive watcher.
- **Automatic update timer:** one check after 10 seconds and every four hours is
  too infrequent to explain sustained energy impact on its own.
- **Named-routing polling:** the 500/1,500 ms loop is bounded and only active
  during an explicit setup flow. It should still be cancelled correctly, but is
  not idle background work.
- **Progress IPC:** provisioning output is already coalesced to one send per 90 ms
  in `apps/desktop/src/plot-progress.ts`; preserve that batching.

## Measurement and verification plan

### 1. Establish a trustworthy baseline

Measure a **packaged production build**, not only `pnpm dev`. Development runs
`electron-vite dev --watch`, while React Strict Mode intentionally repeats
renders/effects only in development ([React:
StrictMode](https://react.dev/reference/react/StrictMode)). Compare four fixed,
repeatable five-minute scenarios after launch settles:

1. visible and idle, no running plots;
2. visible and idle, representative running plots;
3. fully occluded/minimized;
4. all windows closed while the macOS app process remains alive.

Record configured root count, repository count, worktree count, listener count,
AC/battery state, and whether the app is packaged. These determine current poll
cost and make comparisons meaningful.

### 2. Correlate system power with code

- In Instruments, record **Power Profiler + CPU Profiler/Time Profiler**. Inspect
  CPU, GPU, network and display power lanes; select the repeating 30-second spikes
  and follow the heaviest stacks/processes. Apple demonstrates exactly this
  workflow in [WWDC25: Profile and optimize power
  usage](https://developer.apple.com/videos/play/wwdc2025/226/).
- Add **System Trace / File Activity** when determining whether child-process
  launch, directory traversal, settings writes, or Git status dominates.
- Inspect each Electron process rather than only the browser process. Electron's
  `app.getAppMetrics()` returns CPU and memory metrics for its Browser, Tab, GPU,
  and Utility processes ([Electron:
  `app.getAppMetrics`](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics)).
  Diagnostic sampling itself should be sparse and disabled in normal builds.
- Use Chrome Performance/Memory tools for renderer work and Electron/Node CPU
  profiles for main-process work. Electron's official guide recommends profiling
  the running code and Chrome Tracing for multi-process analysis
  ([Electron: Measure, Measure,
  Measure](https://www.electronjs.org/docs/latest/tutorial/performance#measure-measure-measure)).

### 3. Instrument refresh phases

In a diagnostic build, time and count these phases independently:

- root discovery: directories visited;
- Git: processes and milliseconds per command/worktree;
- GitHub: request count/bytes/duration;
- Convex: directories and files visited;
- local context: listener seeds and subprocess count;
- reconcile/persistence: bytes written and whether records changed;
- IPC: snapshot byte size and delivery count;
- renderer: React commit count and `actualDuration`.

Do not log command environments, repository file contents, tokens, URLs containing
credentials, or `.env.local` values.

### 4. Fix and verify in this order

1. Remove the global 30-second sweep and global connector invalidation.
2. Eliminate unconditional settings writes and duplicate snapshot delivery.
3. Remove synchronous `spawnSync`/`execFileSync` from main-process paths.
4. Narrow React store subscriptions and preserve object identity.
5. Gate or stop perpetual animations.
6. Bound streamed command output.

After each change, repeat the same Power Profiler scenarios and compare traces.
Apple recommends a profile–fix–verify loop rather than assuming a locally
plausible optimization improved total energy use.

## Acceptance criteria to define from baseline

Apple's archived Mac guide suggests investigating an idle app at roughly more
than one wakeup per second ([Apple: Minimize Timer
Usage](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)).
Use that as an investigation threshold, not a universal release guarantee. The
team should set hardware- and scenario-specific budgets after obtaining a
packaged baseline, including:

- idle CPU and wakeups with no user activity;
- zero refresh/network/disk work while hidden or with all windows closed;
- maximum child-process count and duration per targeted refresh;
- no settings write and no React commit for a semantically unchanged snapshot;
- bounded memory during verbose provisioning;
- no worsening of Power Profiler CPU/GPU/network impact after each fix.
