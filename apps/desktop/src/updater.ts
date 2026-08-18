import type { AppUpdateState } from "@silvic/contracts";
import type {
  ProgressInfo,
  UpdateDownloadedEvent,
  UpdateInfo,
} from "electron-updater";

export interface UpdateSource {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
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
      relocationRequired?: boolean;
      /** Fetch a found release right away instead of waiting for a click. */
      downloadAutomatically?: boolean;
      onState(state: AppUpdateState): void;
    },
  ) {
    this.state = {
      phase: !options.enabled
        ? "unsupported"
        : options.relocationRequired
          ? "relocation-required"
          : "idle",
      currentVersion: options.currentVersion,
    };
    if (!options.enabled || options.relocationRequired) return;

    options.source.autoDownload = false;
    options.source.autoInstallOnAppQuit = false;
    options.source.autoRunAppAfterInstall = true;
    options.source.on("update-available", (information) => {
      this.publish({
        phase: "available",
        currentVersion: options.currentVersion,
        availableVersion: information.version,
      });
      // Nobody wants to babysit a download. Installing stays a click, because
      // it quits Silvic; having the bytes ready by then costs the person
      // nothing. A failed download lands in "error" and stays retryable.
      if (options.downloadAutomatically) void this.download();
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
      this.options.relocationRequired ||
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
    this.publish({ ...this.state, phase: "installing" });
    try {
      this.options.source.quitAndInstall(false, true);
    } catch (error) {
      this.fail(error);
    }
  }

  reportError(error: unknown): void {
    if (this.options.relocationRequired) {
      this.publish({
        phase: "relocation-required",
        currentVersion: this.options.currentVersion,
        message: failureMessage(error),
      });
      return;
    }
    this.fail(error);
  }

  private publish(state: AppUpdateState): void {
    this.state = state;
    this.options.onState(state);
  }

  private fail(error: unknown): void {
    this.publish({
      phase: "error",
      currentVersion: this.options.currentVersion,
      message: failureMessage(error),
    });
  }
}

/**
 * electron-updater surfaces raw Node and Chromium errors ("ENOENT: no such
 * file…", "net::ERR_INTERNET_DISCONNECTED"). The rail shows this text to
 * people, so known noise becomes a sentence; anything already readable passes
 * through untouched.
 */
function failureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Update failed";
  if (/ENOENT|ENOTDIR/.test(raw)) return "This build has no update channel";
  if (
    /net::|ENOTFOUND|ETIMEDOUT|ECONN|EAI_AGAIN|ERR_INTERNET|ERR_NAME|ERR_CONNECTION/.test(
      raw,
    )
  ) {
    return "Couldn't reach the update server";
  }
  if (/HttpError|status [45]\d\d/i.test(raw)) {
    return "The update server returned an error";
  }
  return raw;
}
