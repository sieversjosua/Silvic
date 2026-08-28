import { describe, expect, it } from "vitest";

import type { WorkspaceSnapshot } from "@silvic/contracts";

import { plotResources } from "./plot-resources";

const workspace: WorkspaceSnapshot = {
  workspaceId: "plot-1",
  projectId: "github.com/example/app",
  path: "/projects/app-plot",
  repositoryName: "app",
  branch: "issue/184-heic",
  name: "HEIC uploads",
  locationKind: "worktree",
  isPrimary: false,
  git: {
    branch: "issue/184-heic",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
  },
  observations: [
    {
      connectorId: "convex",
      workspaceId: "plot-1",
      kind: "deployment",
      state: "ready",
      label: "calculating-heron-688",
      detail: "Convex development deployment",
      url: "https://dashboard.convex.dev/d/calculating-heron-688",
    },
  ],
};

describe("plotResources", () => {
  it("combines declared services, commands and provider observations", () => {
    expect(
      plotResources({
        workspace,
        commands: {
          web: { run: "bun run dev", url: true },
          agent: { run: "bun run livekit:dev" },
          stripe: { run: "stripe listen --forward-to $PLOT_URL/api/stripe" },
        },
        processes: [
          {
            plotPath: workspace.path,
            id: "web",
            status: "running",
            url: "https://web-heic-app.localhost",
            notice: "Silvic recovered the preview.",
          },
          {
            plotPath: workspace.path,
            id: "agent",
            status: "running",
          },
        ],
        declared: {
          payments: {
            provider: "stripe",
            kind: "payments",
            isolation: "namespaced",
            command: "stripe",
            dashboardUrl: "https://dashboard.stripe.com/test/events",
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "command:web",
          label: "Web",
          kind: "runtime",
          state: "active",
          url: "https://web-heic-app.localhost",
          detail: "Silvic recovered the preview.",
        }),
        expect.objectContaining({
          id: "command:agent",
          provider: "livekit",
          kind: "agent",
          state: "active",
        }),
        expect.objectContaining({
          id: "declared:payments",
          provider: "stripe",
          state: "quiet",
          isolation: "namespaced",
        }),
        expect.objectContaining({
          id: "observation:convex:deployment:calculating-heron-688",
          provider: "convex",
          kind: "backend",
          state: "ready",
        }),
      ]),
    );
  });

  it("does not show the local listener twice when Silvic supervises it", () => {
    const resources = plotResources({
      workspace: {
        ...workspace,
        observations: [
          ...workspace.observations,
          {
            connectorId: "local-context",
            workspaceId: workspace.workspaceId,
            kind: "runtime",
            state: "active",
            label: "node",
            url: "http://localhost:4687",
            metadata: {
              processId: 9281,
              processGroupId: 8134,
              processLineage: [9281, 8134, 7220],
            },
          },
        ],
      },
      commands: { web: { run: "bun run dev", url: true } },
      processes: [
        {
          plotPath: workspace.path,
          id: "web",
          processId: 7220,
          status: "running",
          url: "https://web-heic-app.localhost",
        },
      ],
      declared: {},
    });

    expect(resources).toHaveLength(2);
    expect(resources.map((resource) => resource.id)).not.toContain(
      "observation:local-context:runtime:node",
    );
  });

  it("withholds the preview URL until its named route is healthy", () => {
    const [web] = plotResources({
      workspace,
      commands: { web: { run: "bun run dev", url: true } },
      processes: [
        {
          plotPath: workspace.path,
          id: "web",
          status: "starting",
          url: "https://web-heic-app.localhost",
        },
      ],
      declared: {},
    });

    expect(web).toMatchObject({ state: "waiting" });
    expect(web).not.toHaveProperty("url");
  });

  it("preserves custom detail while appending the isolation warning", () => {
    const [resource] = plotResources({
      workspace,
      commands: {},
      processes: [],
      declared: {
        ingress: {
          provider: "cloudflare",
          kind: "ingress",
          isolation: "manual",
          detail: "Tunnel maintained by the platform team.",
        },
      },
    });

    expect(resource?.detail).toContain(
      "Tunnel maintained by the platform team.",
    );
    expect(resource?.detail).toContain("isolation is manual");
  });

  it("keeps coding sessions out of the provider resource list", () => {
    const resources = plotResources({
      workspace: {
        ...workspace,
        observations: [
          {
            connectorId: "local-context",
            workspaceId: workspace.workspaceId,
            kind: "session",
            state: "active",
            label: "Fix HEIC uploads",
            detail: "Codex task",
          },
        ],
      },
      commands: {},
      processes: [],
      declared: {},
    });

    expect(resources).toEqual([]);
  });
});
