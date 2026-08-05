import type { AppUpdateState } from "@silvic/contracts";
import type {
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";

export interface UpdateSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(
    event: "update-available",
    listener: (information: UpdateInfo) => void,
  ): unknown;
  on(
    event: "update-not-available",
    listener: (information: UpdateInfo) => void,
  ): unknown;
  on(
    event: "download-progress",
    listener: (information: ProgressInfo) => void,
  ): unknown;
  on(
    event: "update-downloaded",
    listener: (information: UpdateDownloadedEvent) => void,
  ): unknown;
  on(
    event: "error",
    listener: (error: Error, message?: string) => void,
  ): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export class DesktopUpdater {
  private state: AppUpdateState;

  constructor(
    private readonly options: {
      source: UpdateSource;
      currentVersion: string;
      enabled: boolean;
      onState(state: AppUpdateState): void;
    },
  ) {
    this.state = {
      phase: options.enabled ? "idle" : "unsupported",
      currentVersion: options.currentVersion,
    };
    if (!options.enabled) return;

    options.source.autoDownload = false;
    options.source.autoInstallOnAppQuit = false;
    options.source.on("update-available", (information) => {
      this.publish({
        phase: "available",
        currentVersion: options.currentVersion,
        availableVersion: information.version,
      });
    });
    options.source.on("update-not-available", () => {
      this.publish({
        phase: "current",
        currentVersion: options.currentVersion,
      });
    });
    options.source.on("download-progress", (progress) => {
      if (this.state.phase !== "downloading") return;
      this.publish({
        ...this.state,
        phase: "downloading",
        progressPercent: Math.round(progress.percent),
      });
    });
    options.source.on("update-downloaded", (information) => {
      this.publish({
        phase: "ready",
        currentVersion: options.currentVersion,
        availableVersion: information.version,
      });
    });
    options.source.on("error", (error) => {
      this.fail(error);
    });
  }

  getState(): AppUpdateState {
    return this.state;
  }

  async check(): Promise<AppUpdateState> {
    if (
      !this.options.enabled ||
      !["idle", "current", "error"].includes(this.state.phase)
    ) {
      return this.state;
    }
    this.publish({
      phase: "checking",
      currentVersion: this.options.currentVersion,
    });
    try {
      await this.options.source.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  async download(): Promise<AppUpdateState> {
    if (this.state.phase !== "available") return this.state;
    this.publish({
      ...this.state,
      phase: "downloading",
      progressPercent: 0,
    });
    try {
      await this.options.source.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  install(): void {
    if (this.state.phase !== "ready") return;
    this.options.source.quitAndInstall(false, true);
  }

  private publish(state: AppUpdateState): void {
    this.state = state;
    this.options.onState(state);
  }

  private fail(error: unknown): void {
    this.publish({
      phase: "error",
      currentVersion: this.options.currentVersion,
      message: error instanceof Error ? error.message : "Update failed",
    });
  }
}
