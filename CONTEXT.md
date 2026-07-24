# Silvic Workspace Context

Silvic gives parallel software-development work a stable identity that outlives any
single coding-agent session or application.

## Language

**Workspace**:
A durable development environment anchored at one canonical local directory. It owns
the work's context and lifecycle. Its location may be an ordinary Git checkout
(including a full clone), a linked Git worktree, or eventually a remote environment.
_Avoid_: Worktree, project folder, environment

**Task**:
The intended development outcome that one or more Workspaces may attempt to produce.
_Avoid_: Thread, session, branch

**Attempt**:
One isolated approach to a Task, represented by its own Workspace.
_Avoid_: Thread, branch

**Harness**:
An external application or CLI that performs development work inside a Workspace,
such as Codex, Claude Code, T3 Code, or OpenCode.
_Avoid_: Workspace, agent

**Session**:
A bounded interaction in a Harness that is attached to a Workspace. A Session never
owns the Workspace and multiple Sessions may use the same Workspace over time.
_Avoid_: Workspace, worktree

**Service Attachment**:
A local or remote service environment associated with a Workspace, such as a Convex
deployment, development server, or CI run.
_Avoid_: Workspace, plugin

**Runtime**:
A running local process associated with a Workspace, optionally exposing a local URL
or port.
_Avoid_: Deployment, Session

**Worktree**:
A Git checkout mechanism that can provide the directory and isolation for a Workspace.
It is infrastructure, not the Workspace's identity.
_Avoid_: Workspace

**Workspace Location**:
The mechanism that provides a Workspace's canonical files and isolation, such as an
ordinary Git checkout, linked Git worktree, or remote environment.
_Avoid_: Workspace, Worktree
