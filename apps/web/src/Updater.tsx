import { useEffect, useState } from "react";
import { Download, FolderInput, RefreshCw } from "lucide-react";

import type { AppUpdateState } from "@silvic/contracts";

export interface UpdateActions {
  check(): Promise<unknown>;
  download(): Promise<unknown>;
  relocate(): Promise<unknown>;
  install(): Promise<unknown>;
}

export async function performUpdateAction(
  state: AppUpdateState,
  actions: UpdateActions,
): Promise<void> {
  if (state.phase === "relocation-required") {
    await actions.relocate();
  } else if (["idle", "current", "error"].includes(state.phase)) {
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
          relocate: () => window.silvic.moveToApplications(),
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
        <span className="app-update-version">
          Silvic {state.currentVersion}
        </span>
        <span className="app-update-label">Development build</span>
      </div>
    );
  }

  const label = updateLabel(state);
  const detail = updateDetail(state);
  const version =
    "availableVersion" in state ? state.availableVersion : state.currentVersion;
  const pending = ["checking", "downloading", "installing"].includes(
    state.phase,
  );
  const icon =
    state.phase === "relocation-required" ? (
      <FolderInput size={12} />
    ) : state.phase === "available" ? (
      <Download size={12} />
    ) : (
      <RefreshCw size={12} className={pending ? "spinning" : undefined} />
    );
  // aria-disabled instead of disabled so focus survives the pending phases;
  // performUpdateAction already ignores clicks while checking or downloading.
  return (
    <button
      type="button"
      className="app-update"
      data-tone={state.phase}
      aria-disabled={pending}
      aria-label={
        detail
          ? `Silvic ${version}. ${label}. ${detail}`
          : `Silvic ${version}. ${label}`
      }
      aria-live="polite"
      title={detail}
      onClick={onAction}
    >
      {icon}
      <span className="app-update-version">Silvic {version}</span>
      <span className="app-update-label">{label}</span>
    </button>
  );
}

function updateLabel(state: AppUpdateState): string {
  switch (state.phase) {
    case "idle":
    case "current":
      return "Check updates";
    case "relocation-required":
      return "Install";
    case "checking":
      return "Checking…";
    case "available":
      return "Update";
    case "downloading":
      return `${state.progressPercent}%`;
    case "ready":
      return "Restart";
    case "installing":
      return "Installing…";
    case "error":
      return "Retry";
    case "unsupported":
      return "Development build";
  }
}

function updateDetail(state: AppUpdateState): string | undefined {
  switch (state.phase) {
    case "relocation-required":
      return (
        state.message ??
        "Install once so future updates can apply automatically"
      );
    case "current":
      return "Up to date";
    case "installing":
      return "Silvic will reopen when the installation finishes";
    case "error":
      return state.message;
    default:
      return undefined;
  }
}
