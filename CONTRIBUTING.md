# Contributing to Silvic

Thanks for helping make parallel development less awkward.

## Setup

1. Install Node.js 22+ and pnpm 11.
2. Run `pnpm install`.
3. Run `pnpm dev`.

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Keep filesystem and process access in the Electron main process. Renderer changes
must go through the typed preload API. State-changing Git, provider, or GitHub
operations need an explicit user confirmation and must validate their target
against a discovered Workspace.

Connector contributions are especially welcome. Read
[`docs/CONNECTORS.md`](docs/CONNECTORS.md) for the contract and safety rules.

Use a focused commit, include tests for behavior, and explain any new external CLI
dependency in the pull request.
