import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DesktopUpdater } from "./updater";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
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
    expect(source.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(states).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "ready",
    ]);
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
