import { useEffect, useState } from "react";
import { CircleDot, Search, X } from "lucide-react";

import type { IssueSummary } from "@silvic/contracts";

import { failureMessage } from "./errors";
import { useKeyLayer } from "./shortcuts";

export function IssuePicker({
  projectId,
  selected,
  disabled,
  onSelect,
}: {
  projectId: string;
  selected: IssueSummary | undefined;
  disabled: boolean;
  onSelect(issue: IssueSummary | undefined): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<readonly IssueSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string>();

  // Escape backs out of the search, not out of the dialog holding it.
  useKeyLayer({ dismiss: open ? () => setOpen(false) : undefined });

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setFailure(undefined);
    const timer = window.setTimeout(() => {
      void window.silvic
        .listIssues({ projectId, query })
        .then((next) => {
          if (current) setIssues(next);
        })
        .catch((error: unknown) => {
          if (current) {
            setIssues([]);
            setFailure(failureMessage(error));
          }
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [open, projectId, query]);

  if (selected && !open) {
    return (
      <div className="selected-issue">
        <CircleDot size={14} />
        <div>
          <span className="micro">GitHub issue #{selected.number}</span>
          <strong>{selected.title}</strong>
        </div>
        <button
          type="button"
          className="link-button"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          Change
        </button>
        <button
          type="button"
          aria-label="Create without the selected issue"
          onClick={() => onSelect(undefined)}
          disabled={disabled}
        >
          <X size={13} />
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="issue-trigger"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <CircleDot size={14} />
        <span>
          <strong>Choose a GitHub issue</strong>
          <small>Use its title and context for this Plot</small>
        </span>
      </button>
    );
  }

  return (
    <div className="issue-picker">
      <div className="issue-picker-head">
        <label className="search">
          <Search size={13} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search open GitHub issues"
            disabled={disabled}
          />
        </label>
        <button
          type="button"
          aria-label="Close issue picker"
          onClick={() => setOpen(false)}
        >
          <X size={13} />
        </button>
      </div>
      <div className="issue-results" aria-busy={loading}>
        {loading && <p className="section-empty">Loading issues…</p>}
        {!loading && failure && (
          <div className="issue-failure">
            <p className="dialog-error">{failure}</p>
            <button
              type="button"
              className="ghost-button"
              onClick={() => void window.silvic.connectGitHub()}
            >
              Connect GitHub
            </button>
          </div>
        )}
        {!loading && !failure && issues.length === 0 && (
          <p className="section-empty">No matching open issues</p>
        )}
        {!loading &&
          issues.map((issue) => (
            <button
              type="button"
              className="issue-result"
              key={issue.number}
              onClick={() => {
                onSelect(issue);
                setOpen(false);
              }}
              disabled={disabled}
            >
              <span className="mono">#{issue.number}</span>
              <span>
                <strong>{issue.title}</strong>
                {issue.labels.length > 0 && (
                  <small>{issue.labels.join(" · ")}</small>
                )}
              </span>
            </button>
          ))}
      </div>
    </div>
  );
}
