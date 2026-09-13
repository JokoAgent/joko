import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoOpLogger, type AppUpdater } from "electron-updater";
import { describe, expect, it, vi } from "vitest";

import { createElectronUpdateDriver } from "../src/electron-update-driver.js";
import { atomicWritePrivateFile } from "../src/secure-files.js";
import { mkdtemp } from "./test-paths.js";

describe("electron-updater driver", () => {
  it("uses explicit generic-feed, manual-download, and safe explicit-install settings", async () => {
    const updater = new FakeAppUpdater();
    const installSignal = new EventEmitter();
    const quitHandoff = createQuitHandoff();
    const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, installSignal, {
      quitHandoff: quitHandoff.adapter
    });

    expect(updater.logger).toBeNull();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.autoRunAppAfterInstall).toBe(true);
    driver.configure("https://updates.example.com/joko");
    expect(updater.setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "https://updates.example.com/joko"
    });
    await expect(driver.checkForUpdates()).resolves.toEqual({ available: true, version: "2.0.0" });

    const progress = vi.fn();
    const error = vi.fn();
    const stopProgress = driver.onProgress(progress);
    const stopError = driver.onError(error);
    updater.emit("download-progress", {
      percent: 42,
      transferred: 4_194_304,
      total: 10_485_760,
      bytesPerSecond: 524_288
    });
    updater.emit("error", new Error("masked by service"));
    expect(progress).toHaveBeenCalledWith({
      percent: 42,
      transferred: 4_194_304,
      total: 10_485_760,
      bytesPerSecond: 524_288
    });
    expect(error).toHaveBeenCalledOnce();
    stopProgress();
    stopError();
    updater.emit("download-progress", {
      percent: 84,
      transferred: 8_388_608,
      total: 10_485_760,
      bytesPerSecond: 1_048_576
    });
    expect(progress).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(updater.listenerCount("download-progress")).toBe(0);
    expect(updater.listenerCount("error")).toBe(0);

    const install = driver.relaunchToInstall();
    expect(quitHandoff.quit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    const quitEvent = quitHandoff.emitWillQuit();
    expect(quitEvent.preventDefault).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    installSignal.emit("before-quit-for-update");
    await expect(install).resolves.toBeUndefined();
    expect(installSignal.listenerCount("before-quit-for-update")).toBe(0);
  });

  it("keeps install handoff pending until the native quit signal and rejects a deferred macOS-style error", async () => {
    const updater = new FakeAppUpdater();
    const installSignal = new EventEmitter();
    const quitHandoff = createQuitHandoff();
    const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, installSignal, {
      quitHandoff: quitHandoff.adapter
    });

    const install = driver.relaunchToInstall();
    quitHandoff.emitWillQuit();
    let settled = false;
    void install.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(updater.listenerCount("error")).toBe(1);
    updater.emit("error", new Error("deferred native Squirrel failure"));
    await expect(install).rejects.toThrow("Desktop update install handoff failed.");
    expect(installSignal.listenerCount("before-quit-for-update")).toBe(0);
    expect(updater.listenerCount("error")).toBe(0);
  });

  it("bounds a silent native install handoff and cleans its timer and listeners", async () => {
    vi.useFakeTimers();
    try {
      const updater = new FakeAppUpdater();
      const installSignal = new EventEmitter();
      const quitHandoff = createQuitHandoff();
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, installSignalAdapter(installSignal), {
        installHandoffTimeoutMs: 500,
        quitHandoff: quitHandoff.adapter
      });

      const install = driver.relaunchToInstall();
      const rejected = expect(install).rejects.toThrow("Desktop update install handoff failed.");
      await vi.advanceTimersByTimeAsync(499);
      expect(quitHandoff.listenerCount()).toBe(1);
      expect(installSignal.listenerCount("before-quit-for-update")).toBe(0);
      expect(updater.listenerCount("error")).toBe(0);
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(installSignal.listenerCount("before-quit-for-update")).toBe(0);
      expect(updater.listenerCount("error")).toBe(0);
      expect(quitHandoff.listenerCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a pending install handoff on dispose and revokes every native listener", async () => {
    vi.useFakeTimers();
    try {
      const updater = new FakeAppUpdater();
      const native = new EventEmitter();
      const quitHandoff = createQuitHandoff();
      updater.quitAndInstall.mockImplementationOnce(() => {
        native.on("update-downloaded", updater.quitAndInstall);
      });
      const driver = createElectronUpdateDriver(
        updater as unknown as AppUpdater,
        installSignalAdapter(native),
        { platform: "darwin", installHandoffTimeoutMs: 500, quitHandoff: quitHandoff.adapter }
      );

      const install = driver.relaunchToInstall();
      const rejected = expect(install).rejects.toThrow("Desktop update install handoff failed.");
      quitHandoff.emitWillQuit();
      expect(native.listenerCount("before-quit-for-update")).toBe(1);
      expect(native.listenerCount("update-downloaded")).toBe(1);
      expect(updater.listenerCount("error")).toBe(1);
      driver.dispose?.();
      await rejected;
      expect(native.listenerCount("before-quit-for-update")).toBe(0);
      expect(native.listenerCount("update-downloaded")).toBe(0);
      expect(updater.listenerCount("error")).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes the macOS native late-install listener when handoff times out", async () => {
    vi.useFakeTimers();
    try {
      const updater = new FakeAppUpdater();
      const installSignal = new EventEmitter();
      const quitHandoff = createQuitHandoff();
      const permanentNativeListener = vi.fn();
      const lateQuit = vi.fn();
      installSignal.on("update-downloaded", permanentNativeListener);
      updater.quitAndInstall.mockImplementation(() => {
        // electron-updater 6.8.9 MacUpdater.quitAndInstall installs this exact
        // kind of long-lived anonymous handler before the native fetch starts.
        installSignal.on("update-downloaded", lateQuit);
      });
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, installSignalAdapter(installSignal), {
        platform: "darwin",
        installHandoffTimeoutMs: 500,
        quitHandoff: quitHandoff.adapter
      });

      const install = driver.relaunchToInstall();
      const rejected = expect(install).rejects.toThrow("Desktop update install handoff failed.");
      quitHandoff.emitWillQuit();
      expect(installSignal.listeners("update-downloaded")).toEqual([
        permanentNativeListener,
        lateQuit
      ]);
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
      expect(installSignal.listeners("update-downloaded")).toEqual([permanentNativeListener]);

      installSignal.emit("update-downloaded");
      expect(permanentNativeListener).toHaveBeenCalledOnce();
      expect(lateQuit).not.toHaveBeenCalled();

      const retry = driver.relaunchToInstall();
      quitHandoff.emitWillQuit();
      installSignal.emit("before-quit-for-update");
      await expect(retry).resolves.toBeUndefined();
      expect(updater.quitAndInstall).toHaveBeenCalledTimes(2);
      installSignal.emit("update-downloaded");
      expect(lateQuit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["throw", "emit-error"] as const)(
    "revokes a macOS native late-install listener after a synchronous %s",
    async (failure) => {
      const updater = new FakeAppUpdater();
      const installSignal = new EventEmitter();
      const quitHandoff = createQuitHandoff();
      const permanentNativeListener = vi.fn();
      const lateQuit = vi.fn();
      installSignal.on("update-downloaded", permanentNativeListener);
      updater.quitAndInstall.mockImplementation(() => {
        installSignal.on("update-downloaded", lateQuit);
        if (failure === "throw") throw new Error("native check failed synchronously");
        updater.emit("error", new Error("native check emitted synchronously"));
      });
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, installSignalAdapter(installSignal), {
        platform: "darwin",
        quitHandoff: quitHandoff.adapter
      });

      const install = driver.relaunchToInstall();
      const rejected = expect(install).rejects.toThrow("Desktop update install handoff failed.");
      quitHandoff.emitWillQuit();
      await rejected;
      expect(installSignal.listeners("update-downloaded")).toEqual([permanentNativeListener]);
      installSignal.emit("update-downloaded");
      expect(permanentNativeListener).toHaveBeenCalledOnce();
      expect(lateQuit).not.toHaveBeenCalled();
    }
  );

  it("rejects an ordinary quit blocked by renderer beforeunload without spawning an installer", async () => {
    const updater = new FakeAppUpdater();
    const installSignal = new EventEmitter();
    const quitHandoff = createQuitHandoff();
    const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, installSignal, {
      quitHandoff: quitHandoff.adapter
    });

    const install = driver.relaunchToInstall();
    quitHandoff.block();

    await expect(install).rejects.toThrow("Desktop update install handoff failed.");
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(quitHandoff.listenerCount()).toBe(0);
    expect(installSignal.listenerCount("before-quit-for-update")).toBe(0);
  });

  it("uses electron-updater's no-op logger so raw feeds, paths, and errors cannot reach console", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const logger = new NoOpLogger();
      const raw = "https://user:secret@updates.example.invalid/private/Joko.exe";
      logger.error(raw);
      logger.warn(raw);
      logger.info(raw);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
      info.mockRestore();
    }
  });

  it("atomically restores the previous pending installer when a superseding download fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-"));
    const pending = join(root, "pending");
    const oldInstaller = join(pending, "Joko-2.0.0.exe");
    const oldContents = "verified-old-installer";
    const oldSha512 = createHash("sha512").update(oldContents).digest("base64");
    const oldMetadata = `${JSON.stringify({
      fileName: "Joko-2.0.0.exe",
      sha512: oldSha512,
      isAdminRightsRequired: false
    })}\n`;
    try {
      await mkdir(pending);
      await writeFile(oldInstaller, oldContents);
      await writeFile(join(pending, "update-info.json"), oldMetadata);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = {
        cacheDirForPendingUpdate: pending,
        _file: oldInstaller,
        _packageFile: null,
        versionInfo: { version: "2.0.0" },
        fileInfo: { info: { sha512: oldSha512 } },
        _downloadedFileInfo: { fileName: "Joko-2.0.0.exe", sha512: oldSha512, isAdminRightsRequired: false }
      };
      updater.downloadUpdate
        .mockResolvedValueOnce([oldInstaller])
        .mockImplementationOnce(async () => {
          await mkdir(pending, { recursive: true });
          await writeFile(join(pending, "Joko-3.0.0.exe"), "partial-new-installer");
          const rollbackName = (await readdir(root)).find((entry) => entry.startsWith(".joko-update-rollback-"));
          if (rollbackName === undefined) throw new Error("rollback fixture was not created");
          const markerPath = join(root, rollbackName, ".joko-update-rollback-v1");
          await rm(markerPath, { force: true });
          await mkdir(markerPath);
          updater.downloadedUpdateHelper!._file = null;
          updater.downloadedUpdateHelper!.versionInfo = null;
          updater.downloadedUpdateHelper!.fileInfo = null;
          throw new Error("https://user:secret@updates.example.invalid/private/Joko-3.0.0.exe");
        });
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter(), {
        platform: "win32"
      });
      driver.configure("https://updates.example.com/joko");

      await driver.downloadUpdate("2.0.0");
      await expect(driver.promoteStagedUpdate("2.0.0")).resolves.toEqual({
        promoted: true,
        previousReadyPreserved: false
      });
      await expect(driver.downloadUpdate("3.0.0")).rejects.toMatchObject({
        name: "DesktopUpdateDownloadFailure",
        message: "Desktop update download failed.",
        previousReadyPreserved: true
      });
      await expect(readFile(oldInstaller, "utf8")).resolves.toBe("verified-old-installer");
      await expect(readFile(join(pending, "update-info.json"), "utf8")).resolves.toBe(oldMetadata);
      expect(updater.downloadedUpdateHelper._file).toBe(oldInstaller);
      expect(updater.downloadedUpdateHelper.versionInfo).toEqual({ version: "2.0.0" });
      await expect(readdir(root).then((entries) =>
        entries.filter((entry) => entry.startsWith(".joko-update-rollback-"))
      )).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hydrates a verified staged installer across processes and preserves it when a newer download fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-hydrate-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-2.0.0.exe");
    const contents = "cross-process-verified-installer";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    const electronInfo = `${JSON.stringify({
      fileName: "Joko-2.0.0.exe",
      sha512,
      isAdminRightsRequired: false
    })}\n`;
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), electronInfo);
      const firstUpdater = new FakeAppUpdater();
      firstUpdater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "2.0.0");
      const firstDriver = createElectronUpdateDriver(firstUpdater as unknown as AppUpdater, new EventEmitter());
      firstDriver.configure("https://updates.example.com/joko/stable");
      await firstDriver.downloadUpdate("2.0.0");
      await expect(firstDriver.promoteStagedUpdate("2.0.0")).resolves.toMatchObject({ promoted: true });

      const sidecar = await readFile(join(pending, "joko-staged-update-v1.json"), "utf8");
      expect(sidecar).toContain('"version":"2.0.0"');
      expect(sidecar).not.toContain("updates.example.com");

      const incompleteSidecar = JSON.parse(sidecar) as Record<string, unknown>;
      delete incompleteSidecar["eligible"];
      await writeFile(join(pending, "joko-staged-update-v1.json"), `${JSON.stringify(incompleteSidecar)}\n`);
      const incompleteUpdater = new FakeAppUpdater();
      incompleteUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const incompleteDriver = createElectronUpdateDriver(incompleteUpdater as unknown as AppUpdater, new EventEmitter());
      incompleteDriver.configure("https://updates.example.com/joko/stable");
      await expect(incompleteDriver.hydrateStagedUpdate()).resolves.toBeNull();
      await writeFile(join(pending, "joko-staged-update-v1.json"), sidecar);

      const restartedUpdater = new FakeAppUpdater();
      restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const restartedDriver = createElectronUpdateDriver(restartedUpdater as unknown as AppUpdater, new EventEmitter());
      restartedDriver.configure("https://updates.example.com/joko/stable");
      await expect(restartedDriver.hydrateStagedUpdate()).resolves.toEqual({ version: "2.0.0" });
      expect(restartedUpdater.downloadedUpdateHelper._file).toBe(installer);
      expect(restartedUpdater.downloadedUpdateHelper._downloadedFileInfo).toMatchObject({
        fileName: "Joko-2.0.0.exe",
        sha512
      });

      restartedUpdater.downloadUpdate.mockImplementationOnce(async () => {
        await mkdir(pending, { recursive: true });
        await writeFile(join(pending, "partial-3.0.0.exe"), "partial-new");
        restartedUpdater.downloadedUpdateHelper!._file = null;
        throw new Error("new download failed");
      });
      await expect(restartedDriver.downloadUpdate("3.0.0")).rejects.toMatchObject({
        name: "DesktopUpdateDownloadFailure",
        previousReadyPreserved: true
      });
      await expect(readFile(installer, "utf8")).resolves.toBe(contents);
      await expect(readFile(join(pending, "joko-staged-update-v1.json"), "utf8")).resolves.toBe(sidecar);

      const changedFeedUpdater = new FakeAppUpdater();
      changedFeedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const changedFeedDriver = createElectronUpdateDriver(changedFeedUpdater as unknown as AppUpdater, new EventEmitter());
      changedFeedDriver.configure("https://updates.example.com/joko/beta");
      await expect(changedFeedDriver.hydrateStagedUpdate()).resolves.toBeNull();
      expect(JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8")))
        .toMatchObject({ version: "2.0.0", eligible: false });

      const returnedFeedUpdater = new FakeAppUpdater();
      returnedFeedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const returnedFeedDriver = createElectronUpdateDriver(
        returnedFeedUpdater as unknown as AppUpdater,
        new EventEmitter()
      );
      returnedFeedDriver.configure("https://updates.example.com/joko/stable");
      await expect(returnedFeedDriver.hydrateStagedUpdate()).resolves.toEqual({
        version: "2.0.0",
        quarantined: true
      });

      await writeFile(installer, "tampered-installer");
      const tamperedUpdater = new FakeAppUpdater();
      tamperedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const tamperedDriver = createElectronUpdateDriver(tamperedUpdater as unknown as AppUpdater, new EventEmitter());
      tamperedDriver.configure("https://updates.example.com/joko/stable");
      await expect(tamperedDriver.hydrateStagedUpdate()).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a verified cross-feed installer cannot be durably revoked during hydration", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-cross-feed-revoke-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-2.0.0.exe");
    const contents = "verified-cross-feed-installer";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-2.0.0.exe",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const firstUpdater = new FakeAppUpdater();
      firstUpdater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "2.0.0");
      const first = createElectronUpdateDriver(firstUpdater as unknown as AppUpdater, new EventEmitter());
      first.configure("https://updates.example.com/joko/stable");
      await first.downloadUpdate("2.0.0");
      await first.promoteStagedUpdate("2.0.0");

      const restartedUpdater = new FakeAppUpdater();
      restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const restarted = createElectronUpdateDriver(restartedUpdater as unknown as AppUpdater, new EventEmitter(), {
        writePrivateFile: async () => { throw new Error("disk write failed"); },
        deletePrivateFile: async () => { throw new Error("directory sync failed"); }
      });
      restarted.configure("https://updates.example.com/joko/beta");

      await expect(restarted.hydrateStagedUpdate()).rejects.toMatchObject({
        name: "DesktopUpdateStagedRevocationFailure"
      });
      expect(JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8")))
        .toMatchObject({ version: "2.0.0", eligible: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists rollback-only quarantine so an offline restart cannot hydrate it as eligible ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-quarantine-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-2.0.0.exe");
    const contents = "verified-but-online-stale-installer";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-2.0.0.exe",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "2.0.0");
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter());
      driver.configure("https://updates.example.com/joko/stable");
      await driver.downloadUpdate("2.0.0");
      await expect(driver.promoteStagedUpdate("2.0.0")).resolves.toMatchObject({ promoted: true });
      await expect(driver.quarantineStagedUpdate("2.0.0")).resolves.toBe(true);

      const sidecar = JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8"));
      expect(sidecar).toMatchObject({ version: "2.0.0", eligible: false });
      await expect(readFile(installer, "utf8")).resolves.toBe(contents);

      const restartedUpdater = new FakeAppUpdater();
      restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const restartedDriver = createElectronUpdateDriver(
        restartedUpdater as unknown as AppUpdater,
        new EventEmitter()
      );
      restartedDriver.configure("https://updates.example.com/joko/stable");
      await expect(restartedDriver.hydrateStagedUpdate()).resolves.toEqual({
        version: "2.0.0",
        quarantined: true
      });
      expect(restartedUpdater.downloadedUpdateHelper._file).toBe(installer);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps durable revocation when the eligible sidecar rewrite fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-quarantine-failure-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-3.0.0.exe");
    const contents = "verified-revoked-installer";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    let failSidecarRewrite = false;
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-3.0.0.exe",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "3.0.0");
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter(), {
        writePrivateFile: async (path, bytes) => {
          if (failSidecarRewrite && path.endsWith("joko-staged-update-v1.json")) {
            throw new Error("simulated sidecar replacement failure");
          }
          await atomicWritePrivateFile(path, bytes);
        }
      });
      driver.configure("https://updates.example.com/joko/stable");
      await driver.downloadUpdate("3.0.0");
      await expect(driver.promoteStagedUpdate("3.0.0")).resolves.toMatchObject({ promoted: true });
      failSidecarRewrite = true;
      await expect(driver.quarantineStagedUpdate("3.0.0")).resolves.toBe(true);
      expect(JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8")))
        .toMatchObject({ eligible: true });

      const restartedUpdater = new FakeAppUpdater();
      restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const restarted = createElectronUpdateDriver(restartedUpdater as unknown as AppUpdater, new EventEmitter());
      restarted.configure("https://updates.example.com/joko/stable");
      await expect(restarted.hydrateStagedUpdate()).resolves.toEqual({
        version: "3.0.0",
        quarantined: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to report quarantine when the last-resort durable sidecar delete cannot sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-quarantine-delete-failure-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-3.1.0.exe");
    const contents = "verified-revocation-delete-fallback";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    let failRevocationWrites = false;
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-3.1.0.exe",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "3.1.0");
      const deleteFallback = vi.fn(async () => {
        throw new Error("simulated parent-directory sync failure");
      });
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter(), {
        writePrivateFile: async (path, bytes) => {
          if (failRevocationWrites) throw new Error("simulated revocation write failure");
          await atomicWritePrivateFile(path, bytes);
        },
        deletePrivateFile: deleteFallback
      });
      driver.configure("https://updates.example.com/joko/stable");
      await driver.downloadUpdate("3.1.0");
      await expect(driver.promoteStagedUpdate("3.1.0")).resolves.toMatchObject({ promoted: true });

      failRevocationWrites = true;
      await expect(driver.quarantineStagedUpdate("3.1.0")).resolves.toBe(false);
      expect(deleteFallback).toHaveBeenCalledWith(join(pending, "joko-staged-update-v1.json"));
      expect(JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8")))
        .toMatchObject({ eligible: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a completed download provisional across a crash until policy promotion commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-provisional-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-4.0.0.exe");
    const contents = "verified-provisional-installer";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-4.0.0.exe",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "4.0.0");
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter());
      driver.configure("https://updates.example.com/joko/stable");
      await driver.downloadUpdate("4.0.0");
      expect(JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8")))
        .toMatchObject({ version: "4.0.0", eligible: false });

      const restartedUpdater = new FakeAppUpdater();
      restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const restarted = createElectronUpdateDriver(restartedUpdater as unknown as AppUpdater, new EventEmitter());
      restarted.configure("https://updates.example.com/joko/stable");
      await expect(restarted.hydrateStagedUpdate()).resolves.toEqual({
        version: "4.0.0",
        quarantined: true
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to persist a sidecar whose requested version differs from updater metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-version-bind-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-2.0.0.exe");
    const contents = "verified-version-bound-installer";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-2.0.0.exe",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "2.0.0");
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter());
      driver.configure("https://updates.example.com/joko");

      await expect(driver.downloadUpdate("3.0.0")).rejects.toMatchObject({
        name: "DesktopUpdateDownloadFailure",
        previousReadyPreserved: false
      });
      await expect(readFile(join(pending, "joko-staged-update-v1.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds the audited macOS local Squirrel proxy before hydrating ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-mac-hydrate-"));
    const pending = join(root, "pending");
    const installer = join(pending, "Joko-2.0.0-mac.zip");
    const contents = "verified-mac-zip";
    const sha512 = createHash("sha512").update(contents).digest("base64");
    try {
      await mkdir(pending);
      await writeFile(installer, contents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-2.0.0-mac.zip",
        sha512,
        isAdminRightsRequired: false
      })}\n`);
      const firstUpdater = new FakeAppUpdater();
      firstUpdater.downloadedUpdateHelper = downloadedHelper(pending, installer, sha512, "2.0.0");
      const firstDriver = createElectronUpdateDriver(firstUpdater as unknown as AppUpdater, new EventEmitter(), {
        platform: "darwin"
      });
      firstDriver.configure("https://updates.example.com/joko/mac");
      await firstDriver.downloadUpdate("2.0.0");
      await expect(firstDriver.promoteStagedUpdate("2.0.0")).resolves.toMatchObject({ promoted: true });

      const restartedUpdater = new FakeAppUpdater();
      restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, null, null, null);
      const restartedDriver = createElectronUpdateDriver(restartedUpdater as unknown as AppUpdater, new EventEmitter(), {
        platform: "darwin"
      });
      restartedDriver.configure("https://updates.example.com/joko/mac");
      await expect(restartedDriver.hydrateStagedUpdate()).resolves.toEqual({ version: "2.0.0" });
      expect(restartedUpdater.updateDownloaded).toHaveBeenCalledOnce();
      expect(restartedUpdater.updateDownloaded.mock.calls[0]?.[0]).toMatchObject({
        url: expect.objectContaining({ hostname: "updates.invalid" })
      });
      expect(JSON.stringify(restartedUpdater.updateDownloaded.mock.calls[0])).not.toContain("updates.example.com");

      const nextInstaller = join(pending, "Joko-3.0.0-mac.zip");
      const nextContents = "verified-new-mac-zip";
      const nextSha512 = createHash("sha512").update(nextContents).digest("base64");
      restartedUpdater.downloadUpdate.mockImplementationOnce(async () => {
        await mkdir(pending, { recursive: true });
        await writeFile(nextInstaller, nextContents);
        await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
          fileName: "Joko-3.0.0-mac.zip",
          sha512: nextSha512,
          isAdminRightsRequired: false
        })}\n`);
        restartedUpdater.downloadedUpdateHelper = downloadedHelper(pending, nextInstaller, nextSha512, "3.0.0");
        await restartedUpdater.updateDownloaded({ version: "3.0.0" }, {
          version: "3.0.0",
          downloadedFile: nextInstaller
        });
        // Model a post-download sidecar persistence failure after MacUpdater
        // has already replaced its local proxy with the new zip.
        await mkdir(join(pending, "joko-staged-update-v1.json"));
        return [nextInstaller];
      });

      await expect(restartedDriver.downloadUpdate("3.0.0")).rejects.toMatchObject({
        name: "DesktopUpdateDownloadFailure",
        previousReadyPreserved: true
      });
      expect(restartedUpdater.updateDownloaded).toHaveBeenCalledTimes(3);
      expect(restartedUpdater.updateDownloaded.mock.calls.at(-1)?.[1]).toMatchObject({
        version: "2.0.0",
        downloadedFile: installer
      });
      await expect(readFile(installer, "utf8")).resolves.toBe(contents);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("physically restores and re-proxies the old macOS package when promotion cannot commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-mac-promote-rollback-"));
    const pending = join(root, "pending");
    const oldInstaller = join(pending, "Joko-2.0.0-mac.zip");
    const oldContents = "verified-old-mac-zip";
    const oldSha512 = createHash("sha512").update(oldContents).digest("base64");
    try {
      await mkdir(pending);
      await writeFile(oldInstaller, oldContents);
      await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
        fileName: "Joko-2.0.0-mac.zip",
        sha512: oldSha512,
        isAdminRightsRequired: false
      })}\n`);
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = downloadedHelper(pending, oldInstaller, oldSha512, "2.0.0");
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter(), {
        platform: "darwin"
      });
      driver.configure("https://updates.example.com/joko/mac");
      await driver.downloadUpdate("2.0.0");
      await expect(driver.promoteStagedUpdate("2.0.0")).resolves.toMatchObject({ promoted: true });
      await expect(driver.quarantineStagedUpdate("2.0.0")).resolves.toBe(true);

      const nextInstaller = join(pending, "Joko-3.0.0-mac.zip");
      const nextContents = "verified-next-mac-zip";
      const nextSha512 = createHash("sha512").update(nextContents).digest("base64");
      updater.downloadUpdate.mockImplementationOnce(async () => {
        await mkdir(pending, { recursive: true });
        await writeFile(nextInstaller, nextContents);
        await writeFile(join(pending, "update-info.json"), `${JSON.stringify({
          fileName: "Joko-3.0.0-mac.zip",
          sha512: nextSha512,
          isAdminRightsRequired: false
        })}\n`);
        updater.downloadedUpdateHelper = downloadedHelper(pending, nextInstaller, nextSha512, "3.0.0");
        await updater.updateDownloaded({ version: "3.0.0" }, {
          version: "3.0.0",
          downloadedFile: nextInstaller
        });
        return [nextInstaller];
      });
      await driver.downloadUpdate("3.0.0");
      // A directory at the revocation marker path forces the promotion commit
      // removal to fail after the provisional sidecar has been written.
      await mkdir(join(pending, "joko-staged-update-quarantine-v1"));

      await expect(driver.promoteStagedUpdate("3.0.0")).resolves.toEqual({
        promoted: false,
        previousReadyPreserved: true
      });
      expect(updater.downloadedUpdateHelper._file).toBe(oldInstaller);
      expect(updater.updateDownloaded.mock.calls.at(-1)?.[1]).toMatchObject({
        version: "2.0.0",
        downloadedFile: oldInstaller
      });
      await expect(readFile(oldInstaller, "utf8")).resolves.toBe(oldContents);
      await expect(driver.promoteStagedUpdate("2.0.0")).resolves.toMatchObject({ promoted: true });
      expect(JSON.parse(await readFile(join(pending, "joko-staged-update-v1.json"), "utf8")))
        .toMatchObject({ version: "2.0.0", eligible: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a durable rollback left by a crash before the next network check", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-crash-"));
    const pending = join(root, "pending");
    const rollback = join(root, ".joko-update-rollback-70a12233-206b-41f9-a782-0b5c6c440f3a");
    try {
      await mkdir(pending);
      await writeFile(join(pending, "partial-new.exe"), "partial-new");
      await mkdir(rollback);
      await writeFile(join(rollback, ".joko-update-rollback-v1"), "joko-electron-updater-pending-v1\n");
      await writeFile(join(rollback, "verified-old.exe"), "verified-old");
      await writeFile(join(rollback, "update-info.json"), "old-metadata");
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = {
        cacheDirForPendingUpdate: pending,
        _file: join(pending, "verified-old.exe"),
        _packageFile: null,
        versionInfo: { version: "2.0.0" },
        fileInfo: { sha512: "old" },
        _downloadedFileInfo: { fileName: "verified-old.exe", sha512: "old" }
      };
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter());

      await driver.checkForUpdates();

      await expect(readFile(join(pending, "verified-old.exe"), "utf8")).resolves.toBe("verified-old");
      await expect(readFile(join(pending, "update-info.json"), "utf8")).resolves.toBe("old-metadata");
      await expect(readFile(join(pending, ".joko-update-rollback-v1"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(root).then((entries) => entries.filter((entry) =>
        entry.startsWith(".joko-update-rollback-")
      ))).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the verified new pending directory when a crash interrupts committed rollback cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-update-driver-tombstone-"));
    const pending = join(root, "pending");
    const rollback = join(root, ".joko-update-rollback-2a07ed79-ea75-4a85-a77e-61283d318213");
    try {
      await mkdir(pending);
      await writeFile(join(pending, "verified-new.exe"), "verified-new");
      await writeFile(join(pending, "update-info.json"), "new-metadata");
      await mkdir(rollback);
      // No marker means the new download crossed the atomic commit point;
      // this directory models partially deleted old-installer debris.
      await writeFile(join(rollback, "partial-old.exe"), "partial-old");
      const updater = new FakeAppUpdater();
      updater.downloadedUpdateHelper = {
        cacheDirForPendingUpdate: pending,
        _file: join(pending, "verified-new.exe"),
        _packageFile: null,
        versionInfo: { version: "3.0.0" },
        fileInfo: { sha512: "new" },
        _downloadedFileInfo: { fileName: "verified-new.exe", sha512: "new" }
      };
      const driver = createElectronUpdateDriver(updater as unknown as AppUpdater, new EventEmitter());

      await driver.checkForUpdates();

      await expect(readFile(join(pending, "verified-new.exe"), "utf8")).resolves.toBe("verified-new");
      await expect(readFile(join(pending, "update-info.json"), "utf8")).resolves.toBe("new-metadata");
      await expect(readdir(root).then((entries) => entries.filter((entry) =>
        entry.startsWith(".joko-update-rollback-")
      ))).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class FakeAppUpdater extends EventEmitter {
  logger: unknown = console;
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  readonly setFeedURL = vi.fn();
  readonly checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "2.0.0" }
  }));
  readonly downloadUpdate = vi.fn(async () => ["Joko-Setup.exe"]);
  readonly quitAndInstall = vi.fn();
  readonly updateDownloaded = vi.fn(async (_fileInfo: unknown, _event: unknown) => undefined);
  downloadedUpdateHelper?: {
    readonly cacheDirForPendingUpdate: string;
    _file: string | null;
    _packageFile: string | null;
    versionInfo: unknown;
    fileInfo: unknown;
    _downloadedFileInfo: unknown;
  };
}

function installSignalAdapter(emitter: EventEmitter) {
  return {
    once: (_event: "before-quit-for-update", listener: () => void) =>
      emitter.once("before-quit-for-update", listener),
    removeListener: (_event: "before-quit-for-update", listener: () => void) =>
      emitter.removeListener("before-quit-for-update", listener),
    getUpdateDownloadedListeners: () => emitter.listeners("update-downloaded"),
    removeUpdateDownloadedListener: (listener: Function) =>
      emitter.removeListener("update-downloaded", listener as (...parameters: unknown[]) => void)
  };
}

function createQuitHandoff() {
  const events = new EventEmitter();
  const blockers = new Set<() => void>();
  const quit = vi.fn();
  return {
    quit,
    adapter: {
      once: (_event: "will-quit", listener: (event: { readonly preventDefault: () => void }) => void) =>
        events.once("will-quit", listener),
      removeListener: (
        _event: "will-quit",
        listener: (event: { readonly preventDefault: () => void }) => void
      ) => events.removeListener("will-quit", listener),
      quit,
      onQuitBlocked: (listener: () => void) => {
        blockers.add(listener);
        return () => blockers.delete(listener);
      }
    },
    emitWillQuit: () => {
      const event = { preventDefault: vi.fn() };
      events.emit("will-quit", event);
      return event;
    },
    block: () => {
      for (const listener of [...blockers]) listener();
    },
    listenerCount: () => events.listenerCount("will-quit")
  };
}

function downloadedHelper(
  pending: string,
  installer: string | null,
  sha512: string | null,
  version: string | null
): NonNullable<FakeAppUpdater["downloadedUpdateHelper"]> {
  return {
    cacheDirForPendingUpdate: pending,
    _file: installer,
    _packageFile: null,
    versionInfo: version === null ? null : { version },
    fileInfo: sha512 === null ? null : { info: { sha512 } },
    _downloadedFileInfo: installer === null || sha512 === null
      ? null
      : { fileName: installer.split(/[\\/]/u).at(-1), sha512, isAdminRightsRequired: false }
  };
}
