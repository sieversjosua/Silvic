import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Hand } from "lucide-react";

import type {
  TeardownPlanPayload,
  TeardownRunResult,
  WorkspaceSnapshot,
} from "@silvic/contracts";

import { failureMessage } from "./errors";
import { useKeyLayer } from "./shortcuts";
import { plotConclusion } from "./state";

type Scope = TeardownPlanPayload["scope"];

const scopes: ReadonlyArray<[Scope, string, string]> = [
  ["stop", "Stop", "End running processes. Nothing else changes."],
  [
    "archive",
    "Archive",
    "Release what this plot holds, keeping its files and branch.",
  ],
  ["remove", "Remove", "Delete the worktree. The branch is a separate choice."],
];

/**
 * Nothing here runs without showing the exact ordered plan first, including the
 * steps Silvic cannot perform itself.
 */
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
  // A merged plot arrives here to disappear completely: worktree and branch.
  // The defaults say so, the plan still spells out every step, and `-d`'s
  // refusal to delete unmerged work keeps guarding the closed-not-merged case.
  const merged = plotConclusion(workspace) === "merged";
  const [scope, setScope] = useState<Scope>(merged ? "remove" : "archive");
  const [deleteBranch, setDeleteBranch] = useState(merged);
  const [discardChanges, setDiscardChanges] = useState(false);
  const [plan, setPlan] = useState<TeardownPlanPayload>();
  const [result, setResult] = useState<TeardownRunResult>();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    void window.silvic
      .planTeardown({
        path: workspace.path,
        scope,
        deleteBranch,
        discardChanges,
      })
      .then(setPlan)
      .catch((error: unknown) => setFailure(failureMessage(error)));
  }, [workspace.path, scope, deleteBranch, discardChanges]);

  // The plan is confirmed and the work belongs to Silvic now. Closing the
  // dialog does not call any of it back, so the run reports where it can be
  // read: here while this is open, and to the window once it is not.
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
    setWorking(true);
    setFailure(undefined);
    try {
      const outcome = await window.silvic.runTeardown({
        path: workspace.path,
        scope,
        deleteBranch,
        discardChanges,
      });
      setResult(outcome);
      const broke = outcome.results.find((step) => step.status === "failed");
      if (broke) report(`${broke.label}: ${broke.output}`);
    } catch (error) {
      report(failureMessage(error));
    } finally {
      setWorking(false);
    }
  };

  const uncommitted =
    workspace.git.staged +
    workspace.git.unstaged +
    workspace.git.untracked +
    workspace.git.conflicted;
  const blocked = (plan?.blockers.length ?? 0) > 0;
  const actionable = plan?.steps.filter((step) => !step.manual) ?? [];

  // Dismissing mid-run is closing a report, not calling off the work, so the
  // key stays live throughout. ⌘↵ still runs a destructive plan, but only one
  // this dialog has already spelled out in full, and never twice.
  useKeyLayer({
    dismiss: onClose,
    confirm: result
      ? onClose
      : blocked || working || actionable.length === 0
        ? undefined
        : () => void run(),
  });

  return (
    <div className="scrim" onMouseDown={onClose}>
      <section
        className="dialog teardown"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="micro">Tear down</p>
        <h2>{workspace.name}</h2>

        {result ? (
          <>
            <ol className="provision-steps">
              {result.results.map((step) => (
                <li
                  key={step.id}
                  data-failed={step.status === "failed" || undefined}
                >
                  <div className="provision-head">
                    <strong>{step.label}</strong>
                    <span className="mono">{step.status}</span>
                  </div>
                  {step.output && <code className="mono">{step.output}</code>}
                </li>
              ))}
            </ol>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <fieldset className="choices teardown-scopes">
              <legend className="micro">How far</legend>
              {scopes.map(([id, label, detail]) => (
                <label key={id} data-selected={scope === id || undefined}>
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === id}
                    onChange={() => setScope(id)}
                  />
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </label>
              ))}
            </fieldset>

            {scope === "remove" && (
              <label className="teardown-branch">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  onChange={(event) => setDeleteBranch(event.target.checked)}
                />
                Also delete the branch <code>{workspace.branch}</code>
              </label>
            )}

            {scope === "remove" && uncommitted > 0 && (
              <label className="teardown-branch">
                <input
                  type="checkbox"
                  checked={discardChanges}
                  onChange={(event) => setDiscardChanges(event.target.checked)}
                />
                Discard {uncommitted} uncommitted change
                {uncommitted === 1 ? "" : "s"}, including untracked files
              </label>
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

            {plan && plan.steps.length > 0 && (
              <ol className="teardown-plan">
                {plan.steps.map((step) => (
                  <li
                    key={step.id}
                    data-manual={step.manual ? true : undefined}
                  >
                    <div className="provision-head">
                      <strong>{step.label}</strong>
                      {step.manual && (
                        <span className="teardown-manual">
                          <Hand size={11} /> you
                        </span>
                      )}
                    </div>
                    <code className="mono">{step.detail}</code>
                    {step.manual && (
                      <p className="recipe-hint">{step.manual}</p>
                    )}
                    {step.url && (
                      <button
                        type="button"
                        className="ghost-button teardown-link"
                        onClick={() =>
                          void window.silvic.openLink({
                            url: step.url as string,
                          })
                        }
                      >
                        <ExternalLink size={12} /> Open
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}

            {plan && plan.keeps.length > 0 && (
              <p className="teardown-keeps">
                <strong>Kept:</strong> {plan.keeps.join(" · ")}
              </p>
            )}

            {plan && plan.steps.length === 0 && (
              <p className="section-empty">Nothing to do at this level.</p>
            )}
            {failure && <p className="dialog-error">{failure}</p>}

            <div className="dialog-actions">
              <button type="button" className="ghost-button" onClick={onClose}>
                {working ? "Close" : "Cancel"}
              </button>
              <button
                type="button"
                className="primary-button danger"
                disabled={blocked || working || actionable.length === 0}
                onClick={() => void run()}
              >
                {working
                  ? "Working…"
                  : blocked
                    ? "Blocked"
                    : `Run ${actionable.length} step${actionable.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
