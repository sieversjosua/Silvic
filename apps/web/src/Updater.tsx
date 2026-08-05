import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";

import type { AppUpdateState } from "@silvic/contracts";

export interface UpdateActions {
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  install(): Promise<unknown>;
}

export async function performUpdateAction(
  state: AppUpdateState,
  actions: UpdateActions,
): Promise<void> {
  if (["idle", "current", "error"].includes(state.phase)) {
    await actions.check();
  } else if (state.phase === "available") {
    await actions.download();
  } else if (state.phase === "ready") {
    await actions.install();
  }
}

export function AppUpdater() {
  const [state, setState] = useState<AppUpdateState>();

  useEffect(() => {
    let current = true;
    const stop = window.silvic.onUpdateState((next) => {
      if (current) setState(next);
    });
    void window.silvic.getUpdateState().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
      stop();
    };
  }, []);

  if (!state) return null;
  return (
    <UpdateButton
      state={state}
      onAction={() =>
        void performUpdateAction(state, {
          check: () => window.silvic.checkForUpdates(),
          download: () => window.silvic.downloadUpdate(),
          install: () => window.silvic.installUpdate(),
        })
      }
    />
  );
}

export function UpdateButton({
  state,
  onAction,
}: {
  state: AppUpdateState;
  onAction(): void;
}) {
  if (state.phase === "unsupported") {
    return (
      <div className="app-update" data-tone={state.phase}>
        <span className="micro">Silvic {state.currentVersion}</span>
        <span>Development build</span>
      </div>
    );
  }

  const label = updateLabel(state);
  const pending = ["checking", "downloading"].includes(state.phase);
  const icon =
    state.phase === "available" ? (
      <Download size={12} />
    ) : (
      <RefreshCw size={12} className={pending ? "spinning" : undefined} />
    );
  return (
    <div className="app-update" data-tone={state.phase}>
      <span className="micro">Silvic {state.currentVersion}</span>
      <button
        type="button"
        disabled={pending}
        title={state.phase === "error" ? state.message : undefined}
        onClick={onAction}
      >
        {icon}
        {label}
      </button>
    </div>
  );
}

function updateLabel(state: AppUpdateState): string {
  switch (state.phase) {
    case "idle":
      return "Check for updates";
    case "checking":
      return "Checking…";
    case "current":
      return "Check again";
    case "available":
      return `Update to ${state.availableVersion}`;
    case "downloading":
      return `Downloading ${state.progressPercent}%`;
    case "ready":
      return "Restart to update";
    case "error":
      return "Retry update";
    case "unsupported":
      return "Development build";
  }
}
