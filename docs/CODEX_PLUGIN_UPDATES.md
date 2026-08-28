# Codex plugin updates

## Acceptance contract

The Silvic companion plugin has one permanent marketplace identity, `silvic`,
and one permanent selector, `silvic@silvic`. A release may change the plugin
version, but it must not change either identity.

A packaged `Silvic.app` contains the complete marketplace below
`Contents/Resources/codex-marketplace`. The app, CLI, marketplace manifest,
plugin manifest, bundled MCP program, and release artifact all carry the same
strict SemVer version. Packaging fails when that equality or the required MCP
tool catalog differs.

The following behavior is required:

- Installing `silvic@silvic` once is sufficient. A later app release refreshes
  that selector from the stable local source without removing it first.
- App replacement exposes either the complete previous signed marketplace or
  the complete next signed marketplace. No supported update writes individual
  files into an installed app bundle or into Codex's cache.
- The app registers that source only from an unrenamed `Silvic.app` in
  `/Applications` or `~/Applications`; transient DMG and Downloads paths never
  become configured marketplace roots.
- Reconciliation uses the documented `codex plugin marketplace` and
  `codex plugin` commands. `codex plugin list --json` is the authority for the
  enabled selector and version; the presence of cache files is never accepted
  as proof that a plugin is active.
- A successful check proves Desktop version = CLI version = enabled plugin
  version, then performs a real MCP `initialize` and `tools/list` exchange with
  the installed plugin copy. It verifies the complete release tool catalog with
  no dependency on `node` in `PATH`.
- Migration installs and verifies `silvic@silvic` before removing a recognized
  old selector. It may remove only `silvic@personal` or a generated
  `silvic@silvic-0-1-*` selector when its source manifest identifies this
  repository.
  It never edits Codex configuration or cache files directly and never removes
  an unrelated plugin or marketplace.
- A marketplace named `silvic` that resolves anywhere except the packaged app
  source is a collision. Reconciliation stops without replacing or removing it.
- Any source mismatch, version mismatch, command failure, MCP failure, or tool
  catalog difference is visible and fail-closed. Existing Codex tasks must be
  restarted before they can use the refreshed plugin; Silvic does not kill
  Codex or an existing MCP process.
- The restart-required version remains stored across Silvic launches until the
  user confirms that Codex was fully quit and a new task was opened.
- An error after a refresh attempt also stores that restart requirement because
  the Codex cache may already have changed before verification failed.
- The versioned `.tar.gz` and SHA-256 remain independently verifiable manual
  distribution and rollback artifacts. They use the same stable marketplace
  identity, but they are not the normal Desktop companion update path.

## Source placement decision

The marketplace lives inside the signed app rather than in a mutable directory
next to it. This makes the plugin part of the notarized release, gives Desktop,
CLI, and plugin one replacement and rollback unit, and avoids a second updater
with separate staging state. Electron's macOS updater replaces the app bundle;
it does not patch this marketplace in place. A failed replacement therefore
leaves the previous app and marketplace available, while installing an older
signed app restores the matching older source for rollback.

Codex still runs its installed cache copy. Replacing or rolling back the app
does not prove that a running task has reloaded that copy, so reconciliation and
the MCP check are followed by a full Codex restart and a new task. Uninstalling
Silvic removes the source with the app but intentionally does not edit Codex's
settings. `silvic@silvic` then fails closed because its launcher cannot find the
packaged runtime; the user can remove that exact selector with the documented
Codex command.
