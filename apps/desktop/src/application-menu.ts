import type { AppUpdateState } from "@silvic/contracts";

export type UpdateMenuAction = "relocate" | "check" | "download" | "install";

export interface UpdateMenuPresentation {
  label: string;
  enabled: boolean;
  action?: UpdateMenuAction;
}

export function updateMenuPresentation(
  state: AppUpdateState,
): UpdateMenuPresentation {
  switch (state.phase) {
    case "relocation-required":
      return {
        label: "Move Silvic to Applications…",
        enabled: true,
        action: "relocate",
      };
    case "idle":
    case "current":
      return {
        label: "Check for Updates…",
        enabled: true,
        action: "check",
      };
    case "error":
      return {
        label: "Retry Update Check…",
        enabled: true,
        action: "check",
      };
    case "available":
      return {
        label: `Download Update ${state.availableVersion}…`,
        enabled: true,
        action: "download",
      };
    case "ready":
      return {
        label: "Restart to Install Update",
        enabled: true,
        action: "install",
      };
    case "checking":
      return { label: "Checking for Updates…", enabled: false };
    case "downloading":
      return {
        label: `Downloading Update… ${state.progressPercent}%`,
        enabled: false,
      };
    case "installing":
      return { label: "Installing Update…", enabled: false };
    case "unsupported":
      return { label: "Check for Updates…", enabled: false };
  }
}
