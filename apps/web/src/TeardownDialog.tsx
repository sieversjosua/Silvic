import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Hand } from "lucide-react";

import type {
  TeardownPlanPayload,
  TeardownRequestPayload,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { failureMessage } from "./errors";
import { useKeyLayer } from "./shortcuts";

/**
 * Teardown is an intent, not a configuration screen. Start with the complete,
 * safe cleanup. If the branch owns work that would be lost, silently keep the
 * branch and remove the disposable worktree anyway.
 */
async function prepareTeardown(path: string): Promise<{
  request: TeardownRequestPayload;
  plan: TeardownPlanPayload;
}> {
  const removeEverything: TeardownRequestPayload = {
    path,
    scope: "remove",
    deleteBranch: true,
    discardChanges: true,
  };
  const completePlan = await window.silvic.planTeardown(removeEverything);
  if (completePlan.blockers.length === 0) {
    return { request: removeEverything, plan: completePlan };
  }

  const keepBranch = { ...removeEverything, deleteBranch: false };
  const safePlan = await window.silvic.planTeardown(keepBranch);
  return safePlan.blockers.length === 0
    ? { request: keepBranch, plan: safePlan }
    : { request: removeEverything, plan: completePlan };
}

export function TeardownDialog({
  workspace,
  onClose,
  onFailed,
}: {
  workspace: WorkspaceSnapshot;
  onClose(): void;
  /** Says out loud what went wrong to whoever has already walked away. */
  onFailed(message: string): void;
}) {
  const titleId = useId();
  const [request, setRequest] = useState<TeardownRequestPayload>();
  const [plan, setPlan] = useState<TeardownPlanPayload>();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let current = true;
    setRequest(undefined);
    setPlan(undefined);
    setFailure(undefined);
    void prepareTeardown(workspace.path)
      .then((prepared) => {
        if (!current) return;
        setRequest(prepared.request);
        setPlan(prepared.plan);
      })
      .catch((error: unknown) => {
        if (current) setFailure(failureMessage(error));
      });
    return () => {
      current = false;
    };
  }, [workspace.path]);

  // Once confirmed, teardown belongs to Silvic. Closing the dialog merely
  // closes the report; a later failure still reaches the app-level toast.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  const report = (message: string) => {
    setFailure(message);
    if (!open.current) onFailed(message);
  };

  const run = async () => {
    if (!request) return;
    setWorking(true);
    setFailure(undefined);
    try {
      const outcome = await window.silvic.runTeardown(request);
      const broke = outcome.results.find((step) => step.status === "failed");
      if (broke) {
        report(`${broke.label}: ${broke.output}`);
      } else if (open.current) {
        onClose();
      }
    } catch (error) {
      report(failureMessage(error));
    } finally {
      if (open.current) setWorking(false);
    }
  };

  const uncommitted =
    workspace.git.staged +
    workspace.git.unstaged +
    workspace.git.untracked +
    workspace.git.conflicted;
  const blocked = (plan?.blockers.length ?? 0) > 0;
  const automatic = plan?.steps.filter((step) => !step.manual) ?? [];
  const manual = plan?.steps.filter((step) => step.manual) ?? [];
  const removesBranch =
    plan?.steps.some((step) => step.id.startsWith("branch")) ?? false;
  const ready = request !== undefined && plan !== undefined;

  useKeyLayer({
    dismiss: onClose,
    confirm:
      ready && !blocked && !working && automatic.length > 0
        ? () => void run()
        : undefined,
  });

  return (
    <div className="scrim" onMouseDown={onClose}>
      <section
        className="dialog teardown"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="micro">Remove plot</p>
        <h2 id={titleId}>{workspace.name}</h2>
        <p className="teardown-summary">
          Remove the worktree
          {removesBranch ? " and its branch" : ""}. This cannot be undone.
        </p>

        {uncommitted > 0 && (
          <div className="teardown-warning">
            <AlertTriangle size={14} />
            <p>
              <strong>
                {uncommitted} uncommitted change
                {uncommitted === 1 ? "" : "s"} will be discarded.
              </strong>{" "}
              This includes untracked files.
            </p>
          </div>
        )}

        {!ready && !failure && (
          <p className="section-empty">Checking what can be removed…</p>
        )}

        {plan && plan.blockers.length > 0 && (
          <div className="teardown-blockers">
            {plan.blockers.map((blocker) => (
              <p key={blocker}>
                <AlertTriangle size={13} />
                {blocker}
              </p>
            ))}
          </div>
        )}

        {ready && !blocked && (
          <div className="teardown-outcome">
            <strong>
              {removesBranch ? "Fully cleaned up" : "Branch kept"}
            </strong>
            <span>
              {removesBranch
                ? `The worktree and ${workspace.branch} will be removed.`
                : `The worktree will be removed; ${workspace.branch} stays available.`}
            </span>
          </div>
        )}

        {manual.length > 0 && (
          <div className="teardown-manual-list">
            <p className="micro">
              <Hand size={11} /> Still needs you
            </p>
            {manual.map((step) => (
              <div className="teardown-manual-item" key={step.id}>
                <span>
                  <strong>{step.label}</strong>
                  <small>{step.manual}</small>
                </span>
                {step.url && (
                  <button
                    type="button"
                    className="ghost-button teardown-link"
                    onClick={() =>
                      void window.silvic.openLink({ url: step.url as string })
                    }
                  >
                    <ExternalLink size={12} /> Open
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {failure && <p className="dialog-error">{failure}</p>}

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            {working ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            className="primary-button danger"
            disabled={!ready || blocked || working || automatic.length === 0}
            onClick={() => void run()}
          >
            {working ? "Removing…" : blocked ? "Blocked" : "Remove plot"}
          </button>
        </div>
      </section>
    </div>
  );
}
