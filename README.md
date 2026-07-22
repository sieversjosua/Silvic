# Branchdeck

Branchdeck is a local-first, native macOS workbench that treats a Git worktree as the central unit connecting code, local processes, Codex tasks, Convex deployments, GitHub pull requests, and CI checks.

The current UI is intentionally plain. The core functionality lives in the independent `WorkbenchCore` Swift target.

## Implemented

- Recursive repository discovery for user-selected roots
- Registered worktrees via `git worktree list --porcelain`
- Git branch, upstream, revision, ahead/behind, and change categories
- Listening localhost processes mapped to worktrees through process CWD
- `work status -a` processes and URLs mapped by project/workspace
- Convex deployment metadata from `.env.local` without reading or exposing deploy keys
- Non-archived Codex tasks mapped to worktrees by CWD
- GitHub PR metadata and check rollups via the authenticated `gh` CLI
- Browser-based GitHub OAuth through `gh auth login --web`, with account status in the app
- Diff/status inspection
- AI commit messages and PR bodies through the authenticated local `codex` CLI
- Confirm-before-execute plans for stage, commit, push, and PR creation
- A minimal native SwiftUI shell for all of the above

## Run during development

```bash
swift run Branchdeck
```

## Build the app bundle

```bash
./Scripts/build-app.sh
open outputs/Branchdeck.app
```

The app intentionally is not sandboxed: it needs read access to selected repositories, process information, and local CLI configuration. It uses the existing authentication of `git`, `gh`, and `codex`; no credentials are stored by Branchdeck.

## Safety model

Discovery and AI generation are read-only. Before diff context is sent to Codex, likely credential assignments and private-key blocks are redacted; untracked AI content is restricted to a source/text allowlist and common secret files are excluded. The app then shows the exact sanitized payload and requires explicit confirmation before sending it. Local change inspection remains independent and shows any bounded UTF-8 file. Commit, push, and pull-request creation are represented as visible command plans and only run after explicit confirmation. Arguments are passed directly to `Process`, not interpolated through a shell.
