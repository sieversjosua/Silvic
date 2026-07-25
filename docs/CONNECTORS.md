# Connector guide

Silvic connectors enrich a discovered Workspace without owning it. A connector
should be small, capability-based, and safe to omit.

## Observation connector

Create a package below `connectors/` with a manifest and `observe` implementation:

```ts
import type { Connector } from "@silvic/contracts";

export const exampleConnector: Connector = {
  manifest: {
    id: "example",
    name: "Example",
    kind: "service",
    capabilities: ["observe"],
  },
  async observe(target) {
    return [
      {
        connectorId: "example",
        workspaceId: target.workspaceId,
        kind: "deployment",
        state: "ready",
        label: "Preview ready",
      },
    ];
  },
};
```

Register the connector in `apps/desktop/src/main.ts`. The registry validates its
manifest, runs it independently, and reports failures without dropping other data.

## Rules

- Derive attachments from explicit local evidence such as a canonical path,
  repository identity, or provider metadata.
- Return `unknown` when evidence is ambiguous.
- Never return secrets in a label, detail, URL, or metadata field.
- Prefer existing CLI authentication over storing credentials.
- Observation must be read-only.
- Put state-changing provisioning behind a separate, confirmed IPC command.
- Add a focused test using real local files or commands when practical.

## Harness connector

Add an entry to `connectors/harnesses/src/index.ts`. A Harness can be:

- `application`: a macOS application opened with the Workspace path;
- `command`: a CLI opened in Terminal with the Workspace as its directory; or
- `system`: a built-in target such as Finder.

The renderer refers to Harnesses by stable ID. Path validation and launch behavior
remain in the desktop process.
