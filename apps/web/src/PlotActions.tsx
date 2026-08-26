import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Copy,
  FolderOpen,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  SlidersHorizontal,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import type {
  HarnessDefinition,
  HarnessId,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { failureMessage } from "./errors";
import { HarnessRows } from "./harnesses";
import { plotCardActions, type CardRuntimeState } from "./state";
import { useKeyLayer } from "./shortcuts";

export function PlotRenameForm({
  workspace,
  onRename,
  onDone,
}: {
  workspace: WorkspaceSnapshot;
  onRename(id: string, name: string): Promise<void>;
  onDone(): void;
}) {
  const [value, setValue] = useState(workspace.name);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string>();

  const submit = () => {
    const name = value.trim();
    if (!name || working) return;
    if (name === workspace.name) {
      onDone();
      return;
    }
    setWorking(true);
    setFailure(undefined);
    void onRename(workspace.workspaceId, name)
      .then(onDone)
      .catch((error: unknown) => setFailure(failureMessage(error)))
      .finally(() => setWorking(false));
  };

  return (
    <form
      className="plot-rename"
      title={failure}
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== "Escape") return;
        event.preventDefault();
        onDone();
      }}
    >
      <input
        aria-label="Plot name"
        value={value}
        maxLength={120}
        disabled={working}
        autoFocus
        data-invalid={failure ? true : undefined}
        aria-invalid={failure ? true : undefined}
        title={failure}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
      />
      <button
        type="submit"
        aria-label="Save plot name"
        disabled={!value.trim() || working}
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        aria-label="Cancel renaming"
        disabled={working}
        onClick={onDone}
      >
        <X size={12} />
      </button>
      {failure && (
        <span className="plot-rename-error" role="alert">
          <TriangleAlert size={10} />
          {failure}
        </span>
      )}
    </form>
  );
}

export function PlotRuntimeActions({
  workspace,
  runtime,
  conclusion,
  onTeardown,
}: {
  workspace: WorkspaceSnapshot;
  runtime: CardRuntimeState | undefined;
  conclusion: "merged" | "closed" | undefined;
  onTeardown(workspace: WorkspaceSnapshot): void;
}) {
  const [working, setWorking] = useState<"start" | "stop">();
  const [failure, setFailure] = useState<string>();
  const actions = plotCardActions({ conclusion, runtime });

  const run = (action: "start" | "stop", ids: readonly string[]) => {
    setWorking(action);
    setFailure(undefined);
    void Promise.all(
      ids.map((id) =>
        action === "stop"
          ? window.silvic.stopPlotCommand({ path: workspace.path, id })
          : window.silvic.startPlotCommand({ path: workspace.path, id }),
      ),
    )
      .catch((error: unknown) => setFailure(failureMessage(error)))
      .finally(() => setWorking(undefined));
  };

  return (
    <>
      {failure && (
        <span className="plot-action-error" role="alert" title={failure}>
          <TriangleAlert size={11} />
          <span className="plot-action-label">Runtime action failed</span>
        </span>
      )}
      {actions.teardown && (
        <button
          type="button"
          className="plot-teardown"
          aria-label={`Remove plot ${workspace.name}`}
          title={
            conclusion === "merged"
              ? "The pull request is merged — remove the worktree and branch"
              : "The pull request is closed — remove this plot"
          }
          onClick={(event) => {
            event.stopPropagation();
            onTeardown(workspace);
          }}
        >
          <Trash2 size={11} />
          <span className="plot-action-label">Remove…</span>
        </button>
      )}
      {actions.stop && runtime && (
        <button
          type="button"
          className="plot-runtime-toggle"
          data-action="stop"
          aria-label={`Stop runtimes for ${workspace.name}`}
          title={
            runtime.startIds.length > 0
              ? "Stop the running runtimes"
              : "Stop runtimes"
          }
          disabled={working !== undefined}
          onClick={(event) => {
            event.stopPropagation();
            run("stop", runtime.stopIds);
          }}
        >
          <Square size={10} />
          <span className="plot-action-label">
            {working === "stop" ? "Stopping…" : "Stop"}
          </span>
        </button>
      )}
      {actions.start && runtime && (
        <button
          type="button"
          className="plot-runtime-toggle"
          data-action="start"
          aria-label={`Start runtimes for ${workspace.name}`}
          title={
            runtime.stopIds.length > 0
              ? "Start the missing runtimes"
              : "Start runtimes"
          }
          disabled={working !== undefined}
          onClick={(event) => {
            event.stopPropagation();
            run("start", runtime.startIds);
          }}
        >
          <Play size={10} />
          <span className="plot-action-label">
            {working === "start" ? "Starting…" : "Start"}
          </span>
        </button>
      )}
      {runtime &&
        !actions.teardown &&
        !actions.start &&
        !actions.stop &&
        runtime.label === "Stopping…" && (
          <button
            type="button"
            className="plot-runtime-toggle"
            aria-label={`Runtimes for ${workspace.name} are stopping`}
            disabled
          >
            <Square size={10} />
            <span className="plot-action-label">Stopping…</span>
          </button>
        )}
    </>
  );
}

export function PlotMenuTrigger({
  workspaceId,
  workspaceName,
  expanded,
  buttonRef,
  onToggle,
}: {
  workspaceId: string;
  workspaceName: string;
  expanded: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="plot-menu-trigger"
      aria-label={`Actions for ${workspaceName}`}
      aria-haspopup="menu"
      aria-expanded={expanded}
      data-plot-menu-anchor={workspaceId}
      ref={buttonRef}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <MoreHorizontal size={14} />
    </button>
  );
}

/** Shared by canvas cards and list rows so every Plot exposes one action set. */
export function PlotMenu({
  anchor,
  workspace,
  runtimeUrl,
  defaultHarness,
  onClose,
  onOpen,
  onSetDefaultHarness,
  onEditRecipe,
  onRename,
  onTeardown,
}: {
  anchor: HTMLElement | null;
  workspace: WorkspaceSnapshot;
  runtimeUrl: string | undefined;
  defaultHarness: HarnessId;
  onClose(): void;
  onOpen(path: string, target: HarnessDefinition["id"]): void;
  onSetDefaultHarness(id: HarnessId): void;
  onEditRecipe(): void;
  onRename(): void;
  onTeardown(workspace: WorkspaceSnapshot): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => {
    onClose();
    window.setTimeout(() => {
      const trigger = [
        ...document.querySelectorAll<HTMLButtonElement>(
          "[data-plot-menu-anchor]",
        ),
      ].find(
        (candidate) =>
          candidate.dataset.plotMenuAnchor === workspace.workspaceId,
      );
      trigger?.focus();
    }, 0);
  };
  useKeyLayer({ dismiss: close });

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [anchor]);

  const rect = anchor?.getBoundingClientRect();
  if (!rect) return null;
  const run = (action: () => void) => () => {
    close();
    action();
  };
  const left = Math.max(8, Math.min(window.innerWidth - 208, rect.right - 200));

  return createPortal(
    <>
      <div className="menu-scrim" onClick={close} />
      <div
        className="menu plot-menu"
        role="menu"
        aria-label={`Actions for ${workspace.name}`}
        style={{ top: rect.bottom + 6, left }}
        ref={menuRef}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            return;
          }
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              '[role="menuitem"]',
            ),
          ];
          if (items.length === 0) return;
          event.preventDefault();
          const current = items.indexOf(document.activeElement as HTMLElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : event.key === "ArrowDown"
                  ? (current + 1) % items.length
                  : (current - 1 + items.length) % items.length;
          items[next]?.focus();
        }}
      >
        <HarnessRows
          defaultHarness={defaultHarness}
          onOpen={(id) => run(() => onOpen(workspace.path, id))()}
          onSetDefault={onSetDefaultHarness}
        />
        <div className="menu-rule" />
        <button
          type="button"
          role="menuitem"
          onClick={run(() => onOpen(workspace.path, "finder"))}
        >
          <FolderOpen size={14} />
          Reveal in Finder
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={run(() => void window.silvic.copyText(workspace.path))}
        >
          <Copy size={14} />
          Copy path
        </button>
        {runtimeUrl && (
          <button
            type="button"
            role="menuitem"
            onClick={run(() => void window.silvic.copyText(runtimeUrl))}
          >
            <Link2 size={14} />
            Copy address
          </button>
        )}
        <div className="menu-rule" />
        {workspace.isPrimary ? (
          <button type="button" role="menuitem" onClick={run(onEditRecipe)}>
            <SlidersHorizontal size={14} />
            Recipe…
          </button>
        ) : (
          <>
            <button type="button" role="menuitem" onClick={run(onRename)}>
              <Pencil size={14} />
              Rename…
            </button>
            <div className="menu-rule" />
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={run(() => onTeardown(workspace))}
            >
              <Trash2 size={14} />
              Remove plot…
            </button>
          </>
        )}
      </div>
    </>,
    window.document.body,
  );
}
