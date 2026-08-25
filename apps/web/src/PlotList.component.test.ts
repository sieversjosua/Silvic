import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  PlotCommand,
  PlotProcess,
  ProjectSnapshot,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { PlotList } from "./PlotList";

const project: ProjectSnapshot = {
  id: "project-1",
  name: "App",
  rootPath: "/plots/app",
  branches: ["main", "feature/list-actions"],
  remoteBranches: [],
  workspaces: [
    {
      workspaceId: "list-actions",
      projectId: "project-1",
      path: "/plots/list-actions",
      repositoryName: "app",
      branch: "feature/list-actions",
      name: "list-actions",
      locationKind: "worktree",
      isPrimary: false,
      git: {
        branch: "feature/list-actions",
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
      },
      observations: [],
    },
  ],
};

describe("PlotList actions", () => {
  it("exposes the managed runtime and overflow actions for each row", () => {
    const markup = renderList();

    expect(markup).toContain('aria-label="Start runtimes for list-actions"');
    expect(markup).toContain('aria-label="Actions for list-actions"');
    expect(markup).toContain('aria-label="Open list-actions in Codex"');
  });

  it("keeps running, loading, failed and disabled lifecycle states explicit", () => {
    expect(
      renderList({
        processes: [process("running")],
      }),
    ).toContain('aria-label="Stop runtimes for list-actions"');

    const starting = renderList({ processes: [process("starting")] });
    expect(starting).toContain("Starting…");
    expect(starting).toContain('aria-label="Stop runtimes for list-actions"');

    const failed = renderList({
      processes: [
        process("failed", { advice: "The preview exited before listening." }),
      ],
    });
    expect(failed).toContain("Failed");
    expect(failed).toContain("The preview exited before listening.");
    expect(failed).toContain('aria-label="Start runtimes for list-actions"');

    const stopping = renderList({ processes: [process("stopping")] });
    expect(stopping).toContain(
      'aria-label="Runtimes for list-actions are stopping"',
    );
    expect(stopping).toContain("disabled");
  });

  it("labels externally owned runtimes without offering Silvic controls", () => {
    const externalWorkspace: WorkspaceSnapshot = {
      ...project.workspaces[0]!,
      observations: [
        {
          connectorId: "local-context",
          workspaceId: "list-actions",
          kind: "runtime",
          state: "active",
          label: "node",
          url: "http://localhost:3000",
        },
      ],
    };
    const markup = renderList({ commands: [], workspace: externalWorkspace });

    expect(markup).toContain("External");
    expect(markup).toContain("managed outside Silvic");
    expect(markup).not.toContain("Start runtimes");
    expect(markup).not.toContain("Stop runtimes");

    const mixed = renderList({ workspace: externalWorkspace });
    expect(mixed).toContain("Stopped · External");
    expect(mixed).toContain('aria-label="Start runtimes for list-actions"');
  });
});

function process(
  status: PlotProcess["status"],
  overrides: Partial<PlotProcess> = {},
): PlotProcess {
  return {
    plotPath: "/plots/list-actions",
    id: "web",
    status,
    ...overrides,
  };
}

function renderList({
  processes = [],
  commands = [["web", { run: "pnpm dev", url: true }]],
  workspace = project.workspaces[0]!,
}: {
  processes?: readonly PlotProcess[];
  commands?: readonly (readonly [string, PlotCommand])[];
  workspace?: WorkspaceSnapshot;
} = {}): string {
  return renderToStaticMarkup(
    createElement(PlotList, {
      project: { ...project, workspaces: [workspace] },
      commands,
      declaredResources: {},
      processes,
      query: "",
      selectedWorkspaceId: undefined,
      onSelect: vi.fn(),
      onOpen: vi.fn(),
      onEditRecipe: vi.fn(),
      onNewPlot: vi.fn(),
      defaultHarness: "codex",
      onSetDefaultHarness: vi.fn(),
      onRename: vi.fn(async () => undefined),
      onTeardown: vi.fn(),
    }),
  );
}
