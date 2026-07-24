# Silvic MVP specification

## Goal

Build a fast native macOS application for managing local Git/GitHub Workspaces,
with local runtime and AI context attached to each Workspace. A Workspace may use
an ordinary Git checkout, independent clone, or linked worktree; linked
worktrees are optional. Workspaces are grouped into a Project before they are
shown to the user.

## Required capabilities

1. Show which repositories and Workspaces exist under configured local roots,
   whether their location is an ordinary Git checkout or linked worktree.
2. Show the Git status of each Workspace, including changes and ahead/behind state.
3. Show which localhost process or `work` command belongs to which Workspace.
4. Associate Convex deployments and Codex tasks with their Workspace when local evidence permits it.
5. Show GitHub pull requests and CI/check state.
6. Inspect changes, create commits, push branches, and create pull requests.
7. Generate commit messages and pull-request descriptions with AI.
8. Never run state-changing Git/GitHub actions without explicit user confirmation.
9. Keep the functional core independent from the initial, deliberately minimal UI.
10. Allow browser-based GitHub sign-in without storing credentials in Silvic.
11. Present one selected Project as a deterministic tree canvas rooted in its
    primary checkout, with recorded and imported lineage distinguished.
12. Create confirmed task environments as either linked worktrees or independent
    clones and record their parent Workspace.

## Out of scope for this first implementation

- Polished visual design
- Autonomous merge, reset, rebase, discard, or worktree deletion
- Storing GitHub or AI credentials
- A cloud backend
