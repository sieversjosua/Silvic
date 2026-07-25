import { memo, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  Bot,
  CircleDot,
  Cloud,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Play,
  Terminal,
} from "lucide-react";

import type { ProjectSnapshot, WorkspaceSnapshot } from "@silvic/contracts";

interface GroveProps {
  project: ProjectSnapshot;
  query: string;
  selectedWorkspaceId: string | undefined;
  onSelect(id: string): void;
  onOpen(path: string, target: "codex" | "terminal"): void;
}

interface WorkspaceNodeData extends Record<string, unknown> {
  workspace: WorkspaceSnapshot;
  selected: boolean;
  dimmed: boolean;
  onSelect(id: string): void;
  onOpen(path: string, target: "codex" | "terminal"): void;
}

type WorkspaceFlowNode = Node<WorkspaceNodeData, "workspace">;

const nodeTypes = {
  workspace: memo(WorkspaceNode),
};

export function Grove({
  project,
  query,
  selectedWorkspaceId,
  onSelect,
  onOpen,
}: GroveProps) {
  const { nodes, edges } = useMemo(
    () => layoutProject(project, query, selectedWorkspaceId, onSelect, onOpen),
    [project, query, selectedWorkspaceId, onSelect, onOpen],
  );

  return (
    <div className="grove">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.35}
        maxZoom={1.35}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={28}
          size={1}
          color="rgba(224, 229, 216, 0.08)"
        />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function WorkspaceNode({ data }: NodeProps<WorkspaceFlowNode>) {
  const { workspace } = data;
  const state = workspaceState(workspace);
  return (
    <article
      className={`workspace-node ${data.selected ? "selected" : ""} ${data.dimmed ? "dimmed" : ""}`}
      onClick={() => data.onSelect(workspace.workspaceId)}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") data.onSelect(workspace.workspaceId);
      }}
    >
      <Handle type="target" position={Position.Left} />
      <header>
        <span className={`state-dot ${state.tone}`} />
        <span className="node-kind">
          {workspace.isPrimary ? "Primary" : "Workspace"}
        </span>
        <span className="node-state">{state.label}</span>
      </header>
      <h3>{workspace.name}</h3>
      <p className="branch-line">
        <GitBranch size={13} />
        {workspace.branch}
      </p>
      <div className="node-signals">
        <Signal icon={<CircleDot />} label={gitLabel(workspace)} />
        {workspace.observations.map((observation) => (
          <Signal
            key={`${observation.connectorId}:${observation.kind}`}
            icon={iconForObservation(observation.kind)}
            label={observation.label}
            tone={observation.state}
          />
        ))}
      </div>
      <footer>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen(workspace.path, "codex");
          }}
        >
          <Bot size={13} /> Open
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Open in Terminal"
          onClick={(event) => {
            event.stopPropagation();
            data.onOpen(workspace.path, "terminal");
          }}
        >
          <Terminal size={13} />
        </button>
      </footer>
      <Handle type="source" position={Position.Right} />
    </article>
  );
}

function Signal({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone?: string;
}) {
  return (
    <span className={`signal ${tone ?? ""}`}>
      {icon}
      <span>{label}</span>
    </span>
  );
}

function layoutProject(
  project: ProjectSnapshot,
  query: string,
  selectedWorkspaceId: string | undefined,
  onSelect: (id: string) => void,
  onOpen: (path: string, target: "codex" | "terminal") => void,
): { nodes: WorkspaceFlowNode[]; edges: Edge[] } {
  const primary = project.workspaces.find((workspace) => workspace.isPrimary);
  const ordered = [
    ...(primary ? [primary] : []),
    ...project.workspaces.filter(
      (workspace) => workspace.workspaceId !== primary?.workspaceId,
    ),
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const nodes = ordered.map((workspace, index) => {
    const isPrimary = workspace.workspaceId === primary?.workspaceId;
    const secondaryIndex = isPrimary ? 0 : index - (primary ? 1 : 0);
    const column = isPrimary ? 0 : Math.floor(secondaryIndex / 5) + 1;
    const row = isPrimary
      ? Math.floor(Math.max(0, ordered.length - 2) / 2)
      : secondaryIndex % 5;
    return {
      id: workspace.workspaceId,
      type: "workspace",
      position: {
        x: column * 360,
        y: row * 188,
      },
      data: {
        workspace,
        selected: workspace.workspaceId === selectedWorkspaceId,
        dimmed:
          normalizedQuery.length > 0 &&
          !workspaceMatches(workspace, normalizedQuery),
        onSelect,
        onOpen,
      },
    } satisfies WorkspaceFlowNode;
  });
  const edges: Edge[] = primary
    ? ordered
        .filter((workspace) => workspace.workspaceId !== primary.workspaceId)
        .map((workspace) => ({
          id: `${primary.workspaceId}:${workspace.workspaceId}`,
          source:
            workspace.lineage?.parentWorkspaceId &&
            ordered.some(
              (candidate) =>
                candidate.workspaceId === workspace.lineage?.parentWorkspaceId,
            )
              ? workspace.lineage.parentWorkspaceId
              : primary.workspaceId,
          target: workspace.workspaceId,
          type: "smoothstep",
          style: {
            stroke: "rgba(215, 113, 58, 0.62)",
            strokeWidth: 1.5,
            ...(workspace.lineage?.evidence === "inferred"
              ? { strokeDasharray: "5 5" }
              : {}),
          },
        }))
    : [];
  return { nodes, edges };
}

function workspaceMatches(
  workspace: WorkspaceSnapshot,
  query: string,
): boolean {
  return [
    workspace.name,
    workspace.branch,
    workspace.path,
    ...workspace.observations.flatMap((observation) => [
      observation.label,
      observation.detail ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function gitLabel(workspace: WorkspaceSnapshot): string {
  const count =
    workspace.git.staged +
    workspace.git.unstaged +
    workspace.git.untracked +
    workspace.git.conflicted;
  if (workspace.git.conflicted > 0)
    return `${workspace.git.conflicted} conflicts`;
  if (count > 0) return `${count} changes`;
  if (workspace.git.ahead > 0) return `${workspace.git.ahead} ahead`;
  return "Clean";
}

function workspaceState(workspace: WorkspaceSnapshot): {
  label: string;
  tone: string;
} {
  if (workspace.git.conflicted > 0)
    return { label: "Needs attention", tone: "danger" };
  if (workspace.observations.some((item) => item.state === "attention")) {
    return { label: "Needs attention", tone: "danger" };
  }
  if (workspace.observations.some((item) => item.state === "active")) {
    return { label: "Active", tone: "active" };
  }
  if (
    workspace.git.staged + workspace.git.unstaged + workspace.git.untracked >
      0 ||
    workspace.git.ahead > 0
  ) {
    return { label: "Changed", tone: "changed" };
  }
  if (workspace.observations.some((item) => item.state === "waiting")) {
    return { label: "Waiting", tone: "waiting" };
  }
  if (workspace.observations.some((item) => item.state === "unknown")) {
    return { label: "Unknown", tone: "unknown" };
  }
  if (workspace.observations.some((item) => item.state === "ready")) {
    return { label: "Ready", tone: "ready" };
  }
  return { label: "Quiet", tone: "quiet" };
}

function iconForObservation(kind: string): React.ReactNode {
  if (kind === "runtime") return <Play />;
  if (kind === "deployment") return <Cloud />;
  if (kind === "review") return <GitPullRequest />;
  if (kind === "session") return <Bot />;
  return <ExternalLink />;
}
