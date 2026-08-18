import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DesktopUpdater } from "./updater";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => [] as string[]);
  quitAndInstall = vi.fn();
}

describe("DesktopUpdater", () => {
  it("carries an available release from check through download to restart", async () => {
    const source = new FakeUpdater();
    const states: string[] = [];
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      onState: (state) => states.push(state.phase),
    });

    expect(updater.getState()).toEqual({
      phase: "idle",
      currentVersion: "0.1.0",
    });
    expect(source.autoDownload).toBe(false);
    expect(source.autoInstallOnAppQuit).toBe(false);
    expect(source.autoRunAppAfterInstall).toBe(true);

    await updater.check();
    expect(source.checkForUpdates).toHaveBeenCalledOnce();

    source.emit("update-available", { version: "0.1.1" });
    expect(updater.getState()).toMatchObject({
      phase: "available",
      availableVersion: "0.1.1",
    });

    await updater.download();
    source.emit("download-progress", { percent: 48.6 });
    expect(updater.getState()).toMatchObject({
      phase: "downloading",
      progressPercent: 49,
    });

    source.emit("update-downloaded", { version: "0.1.1" });
    expect(updater.getState()).toMatchObject({
      phase: "ready",
      availableVersion: "0.1.1",
    });

    updater.install();
    expect(updater.getState()).toMatchObject({
      phase: "installing",
      availableVersion: "0.1.1",
    });
    expect(source.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(states).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "ready",
      "installing",
    ]);
  });

  it("fetches a found release without being asked", async () => {
    const source = new FakeUpdater();
    const states: string[] = [];
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      downloadAutomatically: true,
      onState: (state) => states.push(state.phase),
    });

    await updater.check();
    source.emit("update-available", { version: "0.1.1" });
    await vi.waitFor(() =>
      expect(source.downloadUpdate).toHaveBeenCalledOnce(),
    );

    source.emit("update-downloaded", { version: "0.1.1" });
    expect(updater.getState()).toMatchObject({
      phase: "ready",
      availableVersion: "0.1.1",
    });
    expect(states).toEqual(["checking", "available", "downloading", "ready"]);
    // Restarting into the new build stays the person's call.
    expect(source.quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps an automatic download retryable when it fails", async () => {
    const source = new FakeUpdater();
    source.downloadUpdate.mockRejectedValueOnce(new Error("Download lost"));
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      downloadAutomatically: true,
      onState: () => undefined,
    });

    source.emit("update-available", { version: "0.1.1" });
    await vi.waitFor(() =>
      expect(updater.getState()).toMatchObject({
        phase: "error",
        message: "Download lost",
      }),
    );
    await expect(updater.check()).resolves.toMatchObject({ phase: "checking" });
  });

  it("requires relocation before contacting the update feed", async () => {
    const source = new FakeUpdater();
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      relocationRequired: true,
      onState: () => undefined,
    });

    expect(updater.getState()).toEqual({
      phase: "relocation-required",
      currentVersion: "0.1.0",
    });
    await updater.check();
    await updater.download();
    updater.install();

    expect(source.checkForUpdates).not.toHaveBeenCalled();
    expect(source.downloadUpdate).not.toHaveBeenCalled();
    expect(source.quitAndInstall).not.toHaveBeenCalled();

    updater.reportError(new Error("Applications folder is unavailable"));
    expect(updater.getState()).toEqual({
      phase: "relocation-required",
      currentVersion: "0.1.0",
      message: "Applications folder is unavailable",
    });
    await updater.check();
    expect(source.checkForUpdates).not.toHaveBeenCalled();
  });

  it("turns update failures into a retryable state", async () => {
    const source = new FakeUpdater();
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      onState: () => undefined,
    });

    source.emit("error", new Error("GitHub could not be reached"));
    expect(updater.getState()).toEqual({
      phase: "error",
      currentVersion: "0.1.0",
      message: "GitHub could not be reached",
    });

    await updater.check();
    source.emit("update-not-available", { version: "0.1.0" });
    expect(updater.getState()).toEqual({
      phase: "current",
      currentVersion: "0.1.0",
    });
  });

  it("translates raw system errors into a sentence", () => {
    const source = new FakeUpdater();
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      onState: () => undefined,
    });

    source.emit(
      "error",
      new Error("ENOENT: no such file or directory, open 'app-update.yml'"),
    );
    expect(updater.getState()).toMatchObject({
      phase: "error",
      message: "This build has no update channel",
    });

    source.emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(updater.getState()).toMatchObject({
      phase: "error",
      message: "Couldn't reach the update server",
    });
  });

  it("keeps a rejected check inside the update UI", async () => {
    const source = new FakeUpdater();
    source.checkForUpdates.mockRejectedValueOnce(new Error("Release offline"));
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      onState: () => undefined,
    });

    await expect(updater.check()).resolves.toMatchObject({
      phase: "error",
      message: "Release offline",
    });
  });

  it("does not let a scheduled check overwrite an update in progress", async () => {
    const source = new FakeUpdater();
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      onState: () => undefined,
    });
    source.emit("update-available", { version: "0.1.1" });

    await updater.check();

    expect(source.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.getState().phase).toBe("available");
  });

  it("keeps a rejected download retryable", async () => {
    const source = new FakeUpdater();
    source.downloadUpdate.mockRejectedValueOnce(new Error("Download lost"));
    const updater = new DesktopUpdater({
      source,
      currentVersion: "0.1.0",
      enabled: true,
      onState: () => undefined,
    });
    source.emit("update-available", { version: "0.1.1" });

    await expect(updater.download()).resolves.toMatchObject({
      phase: "error",
      message: "Download lost",
    });
  });
});
