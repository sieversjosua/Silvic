import { describe, expect, it, vi } from "vitest";

import type {
  Connector,
  ConnectorObservation,
  WorkspaceTarget,
} from "@silvic/contracts";

import { ConnectorRegistry } from "./connector-registry";

const target: WorkspaceTarget = {
  workspaceId: "workspace-1",
  projectId: "github.com/example/silvic",
  path: "/projects/silvic",
  repositoryName: "silvic",
  branch: "main",
};

describe("ConnectorRegistry", () => {
  it("isolates a failing connector while preserving successful observations", async () => {
    const githubObservation: ConnectorObservation = {
      connectorId: "github",
      workspaceId: target.workspaceId,
      kind: "review",
      state: "ready",
      label: "PR #42 is green",
      url: "https://github.com/example/silvic/pull/42",
    };
    const github: Connector = {
      manifest: {
        id: "github",
        name: "GitHub",
        kind: "service",
        capabilities: ["observe"],
      },
      observe: async () => [githubObservation],
    };
    const broken: Connector = {
      manifest: {
        id: "broken",
        name: "Broken",
        kind: "service",
        capabilities: ["observe"],
      },
      observe: async () => {
        throw new Error("not configured");
      },
    };

    const result = await new ConnectorRegistry([github, broken]).observe(
      target,
    );

    expect(result.observations).toEqual([githubObservation]);
    expect(result.failures).toEqual([
      {
        connectorId: "broken",
        message: "not configured",
      },
    ]);
  });

  it("invalidates only the requested connector's cached observations", () => {
    const localInvalidate = vi.fn();
    const remoteInvalidate = vi.fn();
    const connector = (id: string, invalidate: () => void): Connector => ({
      manifest: {
        id,
        name: id,
        kind: "service",
        capabilities: ["observe"],
      },
      observe: async () => [],
      invalidate,
    });
    const registry = new ConnectorRegistry([
      connector("local-context", localInvalidate),
      connector("github", remoteInvalidate),
    ]);

    registry.invalidate("local-context");

    expect(localInvalidate).toHaveBeenCalledOnce();
    expect(remoteInvalidate).not.toHaveBeenCalled();
  });
});
