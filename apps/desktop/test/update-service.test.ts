import { describe, expect, it, vi } from "vitest";

import type { DesktopUpdateStatus } from "../src/channels.js";
import {
  compareDesktopUpdateVersions,
  createDesktopUpdateService,
  DesktopUpdateDownloadFailure,
  DesktopUpdateStagedRevocationFailure,
  resolveDesktopUpdateAvailability,
  type DesktopUpdateDriver,
  type DesktopUpdateDriverCheckResult,
  type DesktopUpdateDriverProgressInfo
} from "../src/update-service.js";

interface FakeDriver extends DesktopUpdateDriver {
  readonly dispose: NonNullable<DesktopUpdateDriver["dispose"]>;
  readonly emitProgress: (progress: DesktopUpdateDriverProgressInfo) => void;
  readonly emitError: () => void;
}

describe("desktop update service", () => {
  it("compares strict SemVer precedence without treating build metadata as newer", () => {
    expect(compareDesktopUpdateVersions("3.0.0", "2.0.0")).toBe(1);
    expect(compareDesktopUpdateVersions("2.0.0-beta.10", "2.0.0-beta.2")).toBe(1);
    expect(compareDesktopUpdateVersions("2.0.0+build.2", "2.0.0+build.1")).toBe(0);
    expect(compareDesktopUpdateVersions("2.0.0-01", "2.0.0")).toBeUndefined();
  });

  it("fails closed on an invalid installed version and never downloads a feed downgrade", async () => {
    const invalidDriver = fakeDriver({ available: true, version: "2.0.0" });
    const invalidService = createDesktopUpdateService({
      driver: invalidDriver,
      isPackaged: true,
      platform: "win32",
      currentVersion: "not-semver",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(async () => undefined)
    });
    expect(invalidService.getStatus()).toEqual({ status: "error", errorKind: "configuration" });
    await expect(invalidService.check()).resolves.toEqual({ status: "failed", errorKind: "configuration" });
    expect(invalidDriver.configure).not.toHaveBeenCalled();
    expect(invalidDriver.checkForUpdates).not.toHaveBeenCalled();

    const downgradeDriver = fakeDriver({ available: true, version: "0.9.0" });
    const downgradeService = createAvailableService(downgradeDriver);
    await expect(downgradeService.check()).resolves.toEqual({ status: "up-to-date" });
    expect(downgradeDriver.downloadUpdate).not.toHaveBeenCalled();
    expect(downgradeService.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it.each(["0.0.0", "0.0.0-dev", "0.0.0-nightly.1"])(
    "disables hydration, checks, and polling for versionless packaged build %s",
    async (currentVersion) => {
      const driver = fakeDriver({ available: true, version: "2.0.0" });
      vi.mocked(driver.hydrateStagedUpdate).mockResolvedValue({ version: "2.0.0" });
      const service = createDesktopUpdateService({
        driver,
        isPackaged: true,
        platform: "win32",
        currentVersion,
        feedUrl: "https://updates.example.com/joko",
        prepareToApply: vi.fn(async () => undefined)
      });
      await service.initialize();
      expect(service.getStatus()).toEqual({
        status: "idle",
        availability: "unavailable",
        reason: "versionless-build"
      });
      await expect(service.check()).resolves.toEqual({ status: "unavailable", reason: "versionless-build" });
      expect(driver.configure).not.toHaveBeenCalled();
      expect(driver.hydrateStagedUpdate).not.toHaveBeenCalled();
      expect(driver.checkForUpdates).not.toHaveBeenCalled();
    }
  );

  it("prioritizes the packaged versionless guard over Linux/manual and absent-feed paths", async () => {
    for (const feedUrl of [undefined, "https://updates.example.com/joko"] as const) {
      const driver = fakeDriver();
      vi.mocked(driver.hydrateStagedUpdate).mockResolvedValue({ version: "2.0.0" });
      const service = createDesktopUpdateService({
        driver,
        isPackaged: true,
        platform: "linux",
        currentVersion: "0.0.0-dev",
        appImagePath: "/opt/Joko.AppImage",
        ...(feedUrl === undefined ? {} : { feedUrl }),
        prepareToApply: vi.fn(async () => undefined)
      });
      await service.initialize();
      expect(service.getStatus()).toEqual({
        status: "idle",
        availability: "unavailable",
        reason: "versionless-build"
      });
      expect(driver.configure).not.toHaveBeenCalled();
      expect(driver.hydrateStagedUpdate).not.toHaveBeenCalled();
    }
  });

  it("reports development, absent-feed, and every Linux mode truthfully", async () => {
    expect(resolveDesktopUpdateAvailability({
      isPackaged: false,
      platform: "win32",
      feedUrl: "https://updates.example.com/joko"
    })).toEqual({ kind: "unavailable", reason: "development" });
    expect(resolveDesktopUpdateAvailability({
      isPackaged: true,
      platform: "darwin"
    })).toEqual({ kind: "unavailable", reason: "feed-unconfigured" });
    expect(resolveDesktopUpdateAvailability({
      isPackaged: true,
      platform: "linux",
      feedUrl: "https://updates.example.com/joko"
    })).toEqual({ kind: "manual-download", reason: "linux-manual-only" });
    expect(resolveDesktopUpdateAvailability({
      isPackaged: true,
      platform: "linux",
      appImagePath: "/opt/Joko.AppImage",
      feedUrl: "https://updates.example.com/joko"
    })).toEqual({ kind: "manual-download", reason: "linux-manual-only" });

    const driver = fakeDriver();
    const service = createDesktopUpdateService({
      driver,
      isPackaged: false,
      platform: "win32",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn()
    });
    await expect(service.check()).resolves.toEqual({ status: "unavailable", reason: "development" });
    expect(service.getStatus()).toEqual({ status: "idle", availability: "unavailable", reason: "development" });
    expect(driver.configure).not.toHaveBeenCalled();
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
  });

  it("configures the generic feed and emits monotonic progress at most every 200ms with immediate 100%", async () => {
    vi.useFakeTimers();
    const driver = fakeDriver({ available: true, version: "2.4.0-beta.1" });
    const download = deferred<void>();
    vi.mocked(driver.downloadUpdate).mockReturnValue(download.promise);
    const service = createAvailableService(driver);
    const statuses: DesktopUpdateStatus[] = [];
    service.onStatus((status) => statuses.push(status));

    try {
      const check = service.check();
      await vi.advanceTimersByTimeAsync(0);
      driver.emitProgress(progressInfo(18, {
        transferred: 1_024,
        total: 8_192,
        bytesPerSecond: 512
      }));
      driver.emitProgress(progressInfo(7, {
        transferred: 2_048,
        total: 8_192,
        bytesPerSecond: 768
      }));
      driver.emitProgress(progressInfo(Number.NaN, {
        transferred: 3_072,
        total: 8_192,
        bytesPerSecond: 1_024
      }));
      await vi.advanceTimersByTimeAsync(199);
      expect(statuses.at(-1)).toEqual({
        status: "downloading",
        version: "2.4.0-beta.1",
        progress: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(statuses.at(-1)).toEqual({
        status: "downloading",
        version: "2.4.0-beta.1",
        progress: 18,
        transferred: 3_072,
        total: 8_192,
        bytesPerSecond: 1_024
      });
      driver.emitProgress(progressInfo(36, {
        transferred: 4_096,
        total: 8_192,
        bytesPerSecond: 2_048
      }));
      driver.emitProgress(progressInfo(101, {
        transferred: -1,
        total: Number.MAX_SAFE_INTEGER + 42,
        bytesPerSecond: 2_048.9
      }));
      expect(statuses.at(-1)).toEqual({
        status: "downloading",
        version: "2.4.0-beta.1",
        progress: 100,
        transferred: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
        bytesPerSecond: 2_048
      });
      driver.emitProgress(progressInfo(88, {
        transferred: 7_168,
        total: 8_192,
        bytesPerSecond: 512
      }));
      download.resolve();
      await expect(check).resolves.toEqual({ status: "available", version: "2.4.0-beta.1" });
      expect(driver.configure).toHaveBeenCalledWith("https://updates.example.com/joko");
      expect(statuses).toEqual([
        { status: "checking" },
        {
          status: "downloading",
          version: "2.4.0-beta.1",
          progress: 0,
          transferred: 0,
          total: 0,
          bytesPerSecond: 0
        },
        {
          status: "downloading",
          version: "2.4.0-beta.1",
          progress: 18,
          transferred: 3_072,
          total: 8_192,
          bytesPerSecond: 1_024
        },
        {
          status: "downloading",
          version: "2.4.0-beta.1",
          progress: 100,
          transferred: Number.MAX_SAFE_INTEGER,
          total: Number.MAX_SAFE_INTEGER,
          bytesPerSecond: 2_048
        },
        { status: "ready", version: "2.4.0-beta.1" }
      ]);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps byte counters monotonic across retry-shaped events without publishing unchanged percent", async () => {
    vi.useFakeTimers();
    const driver = fakeDriver({ available: true, version: "2.5.0" });
    const download = deferred<void>();
    vi.mocked(driver.downloadUpdate).mockReturnValue(download.promise);
    const service = createAvailableService(driver);
    const statuses: DesktopUpdateStatus[] = [];
    service.onStatus((status) => statuses.push(status));

    try {
      const check = service.check();
      await vi.advanceTimersByTimeAsync(0);
      driver.emitProgress(progressInfo(20, {
        transferred: 4_000,
        total: 10_000,
        bytesPerSecond: 1_000
      }));
      driver.emitProgress(progressInfo(10, {
        transferred: 500,
        total: 9_000,
        bytesPerSecond: 2_000
      }));
      await vi.advanceTimersByTimeAsync(200);
      expect(statuses.at(-1)).toEqual({
        status: "downloading",
        version: "2.5.0",
        progress: 20,
        transferred: 4_000,
        total: 10_000,
        bytesPerSecond: 2_000
      });

      const countAtTwenty = statuses.length;
      driver.emitProgress(progressInfo(20, {
        transferred: 6_000,
        total: 12_000,
        bytesPerSecond: 3_000
      }));
      await vi.advanceTimersByTimeAsync(200);
      expect(statuses).toHaveLength(countAtTwenty);

      driver.emitProgress(progressInfo(21, {
        transferred: 5_500,
        total: 11_000,
        bytesPerSecond: 1_500
      }));
      expect(statuses.at(-1)).toEqual({
        status: "downloading",
        version: "2.5.0",
        progress: 21,
        transferred: 6_000,
        total: 12_000,
        bytesPerSecond: 1_500
      });
      driver.emitProgress(progressInfo(22, {
        transferred: 20_000,
        total: 10_000,
        bytesPerSecond: 750
      }));
      driver.emitProgress(progressInfo(21, {
        transferred: 100,
        total: 8_000,
        bytesPerSecond: 333
      }));
      await vi.advanceTimersByTimeAsync(200);
      expect(statuses.at(-1)).toEqual({
        status: "downloading",
        version: "2.5.0",
        progress: 22,
        transferred: 12_000,
        total: 12_000,
        bytesPerSecond: 333
      });

      download.resolve();
      await expect(check).resolves.toEqual({ status: "available", version: "2.5.0" });
      expect(statuses.at(-2)).toEqual({
        status: "downloading",
        version: "2.5.0",
        progress: 100,
        transferred: 12_000,
        total: 12_000,
        bytesPerSecond: 333
      });
      expect(statuses.at(-1)).toEqual({ status: "ready", version: "2.5.0" });
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("isolates throwing status observers from the updater transaction and later observers", async () => {
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const service = createAvailableService(driver);
    const observed: DesktopUpdateStatus[] = [];
    service.onStatus(() => { throw new Error("renderer reloaded"); });
    service.onStatus((status) => observed.push(status));

    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });
    expect(observed.at(-1)).toEqual({ status: "ready", version: "2.0.0" });
  });

  it("reuses the exact in-flight check and download operation", async () => {
    const pending = deferred<DesktopUpdateDriverCheckResult | null>();
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates).mockReturnValue(pending.promise);
    const service = createAvailableService(driver);

    const first = service.check();
    const second = service.check();
    expect(second).toBe(first);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    pending.resolve({ available: false, version: "1.0.0" });
    await expect(first).resolves.toEqual({ status: "up-to-date" });
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it("supersedes an older staged build and rolls back to it when replacement download fails", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "2.0.0" })
      .mockResolvedValueOnce({ available: true, version: "3.0.0" })
      .mockResolvedValueOnce({ available: true, version: "3.0.0" });
    vi.mocked(driver.downloadUpdate)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("replacement failed"))
      .mockResolvedValueOnce(undefined);
    const service = createAvailableService(driver);
    const statuses: DesktopUpdateStatus[] = [];
    service.onStatus((status) => statuses.push(status));

    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });
    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });
    expect(statuses).toContainEqual({
      status: "superseding",
      version: "2.0.0",
      nextVersion: "3.0.0",
      progress: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0
    });
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });

    await expect(service.check()).resolves.toEqual({ status: "available", version: "3.0.0" });
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(service.getStatus()).toEqual({ status: "ready", version: "3.0.0" });
  });

  it("does not apply the old staged build while its replacement is downloading", async () => {
    const replacement = deferred<void>();
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "2.0.0" })
      .mockResolvedValueOnce({ available: true, version: "3.0.0" });
    vi.mocked(driver.downloadUpdate)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(replacement.promise);
    const service = createAvailableService(driver);
    await service.check();

    const superseding = service.check();
    await vi.waitFor(() => {
      expect(service.getStatus()).toMatchObject({ status: "superseding", version: "2.0.0", nextVersion: "3.0.0" });
    });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
    expect(driver.relaunchToInstall).not.toHaveBeenCalled();
    replacement.resolve();
    await superseding;
  });

  it("quarantines a feed-withdrawn ready build but retains it for a disabled updater verdict", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "2.0.0" })
      .mockResolvedValueOnce(null);
    const service = createAvailableService(driver);
    await service.check();

    await expect(service.check()).resolves.toEqual({ status: "unavailable", reason: "updater-disabled" });
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });
    expect(driver.downloadUpdate).toHaveBeenCalledOnce();

    vi.mocked(driver.checkForUpdates).mockResolvedValueOnce({ available: false, version: "1.0.0" });
    await expect(service.check()).resolves.toEqual({ status: "up-to-date" });
    expect(driver.quarantineStagedUpdate).toHaveBeenCalledWith("2.0.0");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
  });

  it("hydrates a cross-process staged installer and keeps it ready when the network check fails", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.hydrateStagedUpdate).mockResolvedValue({ version: "2.0.0" });
    vi.mocked(driver.checkForUpdates).mockRejectedValue(new Error("offline"));
    const service = createAvailableService(driver);

    await expect(service.check()).resolves.toEqual({ status: "failed", errorKind: "check" });
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    await expect(service.relaunch()).resolves.toEqual({ accepted: true });
  });

  it("hydrates a durable quarantine as rollback-only and lets the current feed replace a higher stale build", async () => {
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(driver.hydrateStagedUpdate).mockResolvedValue({ version: "3.0.0", quarantined: true });
    const service = createAvailableService(driver);

    await service.initialize();
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });
    expect(driver.downloadUpdate).toHaveBeenCalledWith("2.0.0");
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });
  });

  it("rejects a startup candidate that differs from the pinned manifest before downloading anything", async () => {
    const driver = fakeDriver({ available: true, version: "4.0.0" });
    const service = createAvailableService(driver);

    await expect(service.checkForExpectedVersion("3.0.0")).resolves.toEqual({
      status: "failed",
      errorKind: "check"
    });
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ status: "error", errorKind: "check", version: "4.0.0" });
  });

  it("durably quarantines a ready installer before hiding it and fences relaunch during the write", async () => {
    const quarantine = deferred<boolean>();
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(driver.quarantineStagedUpdate).mockReturnValue(quarantine.promise);
    const service = createAvailableService(driver);
    await service.check();

    const operation = service.quarantineReady("2.0.0");
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });
    quarantine.resolve(true);
    await expect(operation).resolves.toBe(true);
    expect(driver.quarantineStagedUpdate).toHaveBeenCalledWith("2.0.0");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
  });

  it("rolls a hydrated ready installer back into place when a newer download fails", async () => {
    const driver = fakeDriver({ available: true, version: "3.0.0" });
    vi.mocked(driver.hydrateStagedUpdate).mockResolvedValue({ version: "2.0.0" });
    vi.mocked(driver.downloadUpdate).mockRejectedValue(new DesktopUpdateDownloadFailure(true));
    const service = createAvailableService(driver);

    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });
    expect(driver.downloadUpdate).toHaveBeenCalledWith("3.0.0");
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0" });
  });

  it("replaces staged ready with the exact current feed identity, including rollback and build metadata changes", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "3.0.0+verified.1" })
      .mockResolvedValueOnce({ available: true, version: "2.0.0" })
      .mockResolvedValueOnce({ available: true, version: "3.0.0+feed.2" });
    const service = createAvailableService(driver);
    await expect(service.check()).resolves.toEqual({ status: "available", version: "3.0.0+verified.1" });

    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });
    await expect(service.check()).resolves.toEqual({ status: "available", version: "3.0.0+feed.2" });
    expect(driver.downloadUpdate).toHaveBeenCalledTimes(3);
    expect(driver.quarantineStagedUpdate).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toEqual({ status: "ready", version: "3.0.0+feed.2" });
  });

  it("restores and re-promotes the same-channel old ready when a lower feed replacement fails", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "3.0.0" })
      .mockResolvedValueOnce({ available: true, version: "2.0.0" });
    vi.mocked(driver.downloadUpdate)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DesktopUpdateDownloadFailure(true));
    const service = createAvailableService(driver);
    await service.check();

    await expect(service.check()).resolves.toEqual({ status: "available", version: "3.0.0" });
    expect(driver.quarantineStagedUpdate).toHaveBeenCalledWith("3.0.0");
    expect(driver.promoteStagedUpdate).toHaveBeenLastCalledWith("3.0.0");
    expect(service.getStatus()).toEqual({ status: "ready", version: "3.0.0" });
  });

  it("never publishes provisional ready when promotion fails", async () => {
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(driver.promoteStagedUpdate).mockResolvedValueOnce({
      promoted: false,
      previousReadyPreserved: false
    });
    const service = createAvailableService(driver);

    await expect(service.check()).resolves.toEqual({ status: "failed", errorKind: "download" });
    expect(service.getStatus()).toEqual({ status: "error", errorKind: "download", version: "2.0.0" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
  });

  it("supersedes a ready prerelease only when SemVer precedence increases", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "2.0.0-beta.2" })
      .mockResolvedValueOnce({ available: true, version: "2.0.0-beta.10" });
    const service = createAvailableService(driver);

    await service.check();
    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0-beta.10" });
    expect(driver.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toEqual({ status: "ready", version: "2.0.0-beta.10" });
  });

  it("never advertises the old build as ready when the driver cannot restore its installer", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.checkForUpdates)
      .mockResolvedValueOnce({ available: true, version: "2.0.0" })
      .mockResolvedValueOnce({ available: true, version: "3.0.0" });
    vi.mocked(driver.downloadUpdate)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new DesktopUpdateDownloadFailure(false));
    const service = createAvailableService(driver);
    await service.check();

    await expect(service.check()).resolves.toEqual({ status: "failed", errorKind: "download" });
    expect(service.getStatus()).toEqual({ status: "error", errorKind: "download", version: "3.0.0" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
    expect(driver.relaunchToInstall).not.toHaveBeenCalled();
  });

  it("runs the first packaged check after 10s, polls every 30min, and disposes both timers", async () => {
    vi.useFakeTimers();
    const driver = fakeDriver({ available: false });
    const service = createAvailableService(driver);
    try {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(driver.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(driver.checkForUpdates).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(driver.checkForUpdates).toHaveBeenCalledTimes(2);
      service.dispose();
      expect(driver.dispose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
      expect(driver.checkForUpdates).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps polling paused until the startup gate explicitly releases it", async () => {
    vi.useFakeTimers();
    const driver = fakeDriver({ available: false });
    const service = createDesktopUpdateService({
      driver,
      isPackaged: true,
      platform: "win32",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(async () => undefined),
      enableBackgroundPolling: false
    });
    try {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
      expect(driver.checkForUpdates).not.toHaveBeenCalled();
      service.startBackgroundPolling();
      service.startBackgroundPolling();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(driver.checkForUpdates).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("classifies check, download, and configuration failures without exposing raw errors", async () => {
    const checkDriver = fakeDriver();
    vi.mocked(checkDriver.checkForUpdates).mockRejectedValue(new Error("https://user:secret@example.invalid"));
    const checkService = createAvailableService(checkDriver);
    await expect(checkService.check()).resolves.toEqual({ status: "failed", errorKind: "check" });
    expect(checkService.getStatus()).toEqual({ status: "error", errorKind: "check" });

    const downloadDriver = fakeDriver({ available: true, version: "3.0.0" });
    vi.mocked(downloadDriver.downloadUpdate).mockImplementation(async () => {
      downloadDriver.emitError();
      throw new Error("private release path");
    });
    const downloadService = createAvailableService(downloadDriver);
    await expect(downloadService.check()).resolves.toEqual({ status: "failed", errorKind: "download" });
    expect(downloadService.getStatus()).toEqual({ status: "error", errorKind: "download", version: "3.0.0" });

    const configurationDriver = fakeDriver();
    vi.mocked(configurationDriver.configure).mockImplementation(() => { throw new Error("bad feed"); });
    const configurationService = createAvailableService(configurationDriver);
    await expect(configurationService.check()).resolves.toEqual({ status: "failed", errorKind: "configuration" });
    expect(configurationService.getStatus()).toEqual({ status: "error", errorKind: "configuration" });
  });

  it("never invokes the installer before safe shutdown and keeps the app alive on failure", async () => {
    const order: string[] = [];
    const driver = fakeDriver({ available: true, version: "4.0.0" });
    vi.mocked(driver.relaunchToInstall).mockImplementation(async () => { order.push("install"); });
    const prepareToApply = vi.fn(async () => { order.push("shutdown"); });
    const service = createAvailableService(driver, prepareToApply);
    await service.check();

    const first = service.relaunch();
    const second = service.relaunch();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ accepted: true });
    expect(order).toEqual(["shutdown", "install"]);

    const failedDriver = fakeDriver({ available: true, version: "5.0.0" });
    const failedShutdown = vi.fn()
      .mockRejectedValueOnce(new Error("Orchestrator still running"))
      .mockResolvedValue(undefined);
    const failedService = createAvailableService(failedDriver, failedShutdown);
    await failedService.check();
    await expect(failedService.relaunch()).resolves.toEqual({ accepted: false, reason: "orchestrator-shutdown-failed" });
    expect(failedDriver.relaunchToInstall).not.toHaveBeenCalled();
    expect(failedService.getStatus()).toEqual({ status: "ready", version: "5.0.0" });
    await expect(failedService.relaunch()).resolves.toEqual({ accepted: true });
    expect(failedDriver.relaunchToInstall).toHaveBeenCalledOnce();
  });

  it("recovers bundled Orchestrator when electron-updater synchronously rejects an install handoff", async () => {
    const driver = fakeDriver({ available: true, version: "6.0.0" });
    vi.mocked(driver.relaunchToInstall).mockImplementationOnce(async () => {
      driver.emitError();
      throw new Error("redacted install failure");
    });
    const recover = vi.fn(async () => undefined);
    const service = createDesktopUpdateService({
      driver,
      isPackaged: true,
      platform: "win32",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(async () => undefined),
      recoverAfterApplyFailure: recover
    });
    await service.check();

    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "apply-failed" });
    expect(recover).toHaveBeenCalledOnce();
    expect(service.getStatus()).toEqual({ status: "ready", version: "6.0.0" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: true });
    expect(driver.relaunchToInstall).toHaveBeenCalledTimes(2);
  });

  it("durably revokes a ready release candidate before selecting the beta feed", async () => {
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const service = createAvailableService(driver);
    await expect(service.check()).resolves.toEqual({ status: "available", version: "2.0.0" });

    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    expect(driver.quarantineStagedUpdate).toHaveBeenCalledWith("2.0.0");
    expect(driver.configure).toHaveBeenNthCalledWith(1, "https://updates.example.com/joko");
    expect(driver.configure).toHaveBeenNthCalledWith(2, "https://updates.example.com/joko/beta");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });

    vi.mocked(driver.checkForUpdates).mockResolvedValue({ available: true, version: "3.0.0" });
    await expect(service.check()).resolves.toEqual({ status: "available", version: "3.0.0" });
    expect(service.getStatus()).toEqual({ status: "ready", version: "3.0.0" });
  });

  it("invalidates an in-flight old-channel download before promotion and serializes feed reconfiguration", async () => {
    const download = deferred<void>();
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(driver.downloadUpdate).mockReturnValue(download.promise);
    const service = createAvailableService(driver);

    const check = service.check();
    await vi.waitFor(() => expect(driver.downloadUpdate).toHaveBeenCalledOnce());
    const feedChange = service.changeFeed("https://updates.example.com/joko/beta");
    await expect(feedChange).resolves.toBe(true);
    expect(service.isFeedChangePending()).toBe(true);
    await expect(service.changeFeed("https://updates.example.com/joko")).resolves.toBe(false);
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    expect(driver.configure).toHaveBeenCalledTimes(1);
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
    download.resolve();

    await expect(check).resolves.toEqual({ status: "failed", errorKind: "download" });
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
    expect(driver.promoteStagedUpdate).not.toHaveBeenCalled();
    expect(driver.configure).toHaveBeenLastCalledWith("https://updates.example.com/joko/beta");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    expect(service.isFeedChangePending()).toBe(false);
  });

  it("does not resume an old check after replacement quarantine crosses a feed generation", async () => {
    const quarantine = deferred<boolean>();
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const service = createAvailableService(driver);
    await service.check();
    vi.mocked(driver.checkForUpdates).mockResolvedValue({ available: true, version: "3.0.0" });
    vi.mocked(driver.quarantineStagedUpdate)
      .mockReturnValueOnce(quarantine.promise)
      .mockResolvedValue(true);
    const statuses: DesktopUpdateStatus[] = [];
    service.onStatus((status) => statuses.push(status));

    const oldCheck = service.check();
    await vi.waitFor(() => expect(driver.quarantineStagedUpdate).toHaveBeenCalledOnce());
    const statusCountBeforeChange = statuses.length;
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    quarantine.resolve(true);

    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "check" });
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
    expect(driver.downloadUpdate).toHaveBeenCalledOnce();
    expect(statuses.slice(statusCountBeforeChange).some((status) =>
      status.status === "downloading" || status.status === "superseding" || status.status === "ready"
    )).toBe(false);
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it("does not republish a restored old ready package when feed changes during rollback", async () => {
    const restoration = deferred<{ readonly promoted: boolean; readonly previousReadyPreserved: boolean }>();
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const service = createAvailableService(driver);
    await service.check();
    vi.mocked(driver.checkForUpdates).mockResolvedValue({ available: true, version: "3.0.0" });
    vi.mocked(driver.downloadUpdate).mockRejectedValueOnce(new DesktopUpdateDownloadFailure(true));
    vi.mocked(driver.promoteStagedUpdate).mockReturnValueOnce(restoration.promise);
    const statuses: DesktopUpdateStatus[] = [];
    service.onStatus((status) => statuses.push(status));

    const oldCheck = service.check();
    await vi.waitFor(() => expect(driver.promoteStagedUpdate).toHaveBeenCalledTimes(2));
    const statusCountBeforeChange = statuses.length;
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    restoration.resolve({ promoted: true, previousReadyPreserved: false });

    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "download" });
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
    expect(statuses.slice(statusCountBeforeChange).some((status) => status.status === "ready")).toBe(false);
    expect(driver.quarantineStagedUpdate).toHaveBeenCalledWith("2.0.0");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it("fails closed when a channel transition cannot durably revoke the ready installer", async () => {
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const service = createAvailableService(driver);
    await service.check();
    vi.mocked(driver.quarantineStagedUpdate).mockResolvedValueOnce(false);

    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    await expect(service.check()).resolves.toEqual({ status: "failed", errorKind: "configuration" });
    expect(service.getStatus()).toEqual({ status: "error", errorKind: "configuration" });
    expect(service.isFeedChangePending()).toBe(true);
    expect(driver.configure).toHaveBeenCalledTimes(1);
    await expect(service.changeFeed("https://updates.example.com/joko")).resolves.toBe(false);
    await expect(service.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
  });

  it("holds later checks behind background feed reconfiguration without holding the channel acknowledgement", async () => {
    const download = deferred<void>();
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(driver.downloadUpdate).mockReturnValue(download.promise);
    const service = createAvailableService(driver);

    const oldCheck = service.check();
    await vi.waitFor(() => expect(driver.downloadUpdate).toHaveBeenCalledOnce());
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    const newCheck = service.check();
    await Promise.resolve();
    expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    expect(driver.configure).toHaveBeenCalledOnce();

    download.resolve();
    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "download" });
    await expect(newCheck).resolves.toEqual({ status: "available", version: "2.0.0" });
    expect(driver.configure).toHaveBeenCalledTimes(2);
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(vi.mocked(driver.configure).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(driver.checkForUpdates).mock.invocationCallOrder[1] as number
    );
  });

  it("never restores an old ready package from a stale superseding check", async () => {
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const service = createAvailableService(driver);
    await service.check();
    expect(driver.promoteStagedUpdate).toHaveBeenCalledOnce();

    const replacement = deferred<void>();
    vi.mocked(driver.checkForUpdates).mockResolvedValue({ available: true, version: "3.0.0" });
    vi.mocked(driver.downloadUpdate).mockReturnValueOnce(replacement.promise);
    const oldCheck = service.check();
    await vi.waitFor(() => expect(driver.downloadUpdate).toHaveBeenCalledTimes(2));
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    replacement.reject(new Error("old feed closed"));

    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "download" });
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
    expect(driver.promoteStagedUpdate).toHaveBeenCalledOnce();
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it("does not publish a promotion or hydration result from an invalidated feed generation", async () => {
    const promotion = deferred<{ readonly promoted: boolean; readonly previousReadyPreserved: boolean }>();
    const promotionDriver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(promotionDriver.promoteStagedUpdate).mockReturnValueOnce(promotion.promise);
    const promotionService = createAvailableService(promotionDriver);
    const statuses: DesktopUpdateStatus[] = [];
    promotionService.onStatus((status) => statuses.push(status));
    const oldCheck = promotionService.check();
    await vi.waitFor(() => expect(promotionDriver.promoteStagedUpdate).toHaveBeenCalledOnce());
    await expect(promotionService.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    const readyCountAtChange = statuses.filter((status) => status.status === "ready").length;
    promotion.resolve({ promoted: true, previousReadyPreserved: false });
    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "download" });
    await vi.waitFor(() => expect(promotionDriver.configure).toHaveBeenCalledTimes(2));
    expect(statuses.filter((status) => status.status === "ready")).toHaveLength(readyCountAtChange);
    expect(promotionService.getStatus()).toEqual({ status: "idle", availability: "available" });

    const hydration = deferred<{ readonly version: string } | null>();
    const hydrationDriver = fakeDriver();
    vi.mocked(hydrationDriver.hydrateStagedUpdate).mockReturnValue(hydration.promise);
    const hydrationService = createAvailableService(hydrationDriver);
    const hydratedStatuses: DesktopUpdateStatus[] = [];
    hydrationService.onStatus((status) => hydratedStatuses.push(status));
    await expect(hydrationService.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    hydration.resolve({ version: "2.0.0" });
    await vi.waitFor(() => expect(hydrationDriver.configure).toHaveBeenCalledTimes(2));
    expect(hydratedStatuses.some((status) => status.status === "ready")).toBe(false);
    expect(hydrationService.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it("drains a check invalidated while awaiting startup hydration before configuring the new feed", async () => {
    const hydration = deferred<{ readonly version: string } | null>();
    const driver = fakeDriver();
    vi.mocked(driver.hydrateStagedUpdate).mockReturnValue(hydration.promise);
    const service = createAvailableService(driver);
    expect(service.isFeedChangePending()).toBe(true);

    const oldCheck = service.check();
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    hydration.resolve({ version: "2.0.0" });

    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "check" });
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
    expect(driver.checkForUpdates).not.toHaveBeenCalled();
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    expect(service.isFeedChangePending()).toBe(false);
  });

  it("keeps channel changes fail-closed after verified cross-feed hydration revocation fails", async () => {
    const driver = fakeDriver();
    vi.mocked(driver.hydrateStagedUpdate).mockRejectedValue(new DesktopUpdateStagedRevocationFailure());
    const service = createAvailableService(driver);

    await service.initialize();

    expect(service.getStatus()).toEqual({ status: "error", errorKind: "configuration" });
    expect(service.isFeedChangePending()).toBe(true);
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(false);
    expect(driver.configure).toHaveBeenCalledOnce();
  });

  it("durably revokes a stale promoted candidate across beta, stable, and restart hydration", async () => {
    const stableFeed = "https://updates.example.com/joko";
    const betaFeed = "https://updates.example.com/joko/beta";
    const promotion = deferred<void>();
    let configuredFeed = stableFeed;
    let staged: { feed: string; version: string; eligible: boolean } | undefined;
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    vi.mocked(driver.configure).mockImplementation((feed) => { configuredFeed = feed; });
    vi.mocked(driver.downloadUpdate).mockImplementation(async (version) => {
      staged = { feed: configuredFeed, version, eligible: false };
    });
    vi.mocked(driver.promoteStagedUpdate).mockImplementation(async (version) => {
      await promotion.promise;
      if (staged?.version === version && staged.feed === configuredFeed) staged.eligible = true;
      return { promoted: true, previousReadyPreserved: false };
    });
    vi.mocked(driver.quarantineStagedUpdate).mockImplementation(async (version) => {
      if (staged?.version !== version || staged.feed !== configuredFeed) return false;
      staged.eligible = false;
      return true;
    });
    const service = createAvailableService(driver);

    const oldCheck = service.check();
    await vi.waitFor(() => expect(driver.promoteStagedUpdate).toHaveBeenCalledOnce());
    await expect(service.changeFeed(betaFeed)).resolves.toBe(true);
    promotion.resolve();
    await expect(oldCheck).resolves.toEqual({ status: "failed", errorKind: "download" });
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
    expect(staged).toEqual({ feed: stableFeed, version: "2.0.0", eligible: false });

    await expect(service.changeFeed(stableFeed)).resolves.toBe(true);
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(3));
    service.dispose();

    let restartFeed = stableFeed;
    const restartDriver = fakeDriver();
    vi.mocked(restartDriver.configure).mockImplementation((feed) => { restartFeed = feed; });
    vi.mocked(restartDriver.hydrateStagedUpdate).mockImplementation(async () => {
      if (staged === undefined || staged.feed !== restartFeed) return null;
      return { version: staged.version, ...(staged.eligible ? {} : { quarantined: true as const }) };
    });
    const restarted = createAvailableService(restartDriver);
    await restarted.initialize();

    expect(restarted.getStatus()).toEqual({ status: "idle", availability: "available" });
    await expect(restarted.relaunch()).resolves.toEqual({ accepted: false, reason: "not-ready" });
  });

  it("rechecks feed and ready eligibility after asynchronous apply preparation", async () => {
    const preparation = deferred<void>();
    const driver = fakeDriver({ available: true, version: "2.0.0" });
    const recover = vi.fn(async () => undefined);
    const service = createDesktopUpdateService({
      driver,
      isPackaged: true,
      platform: "win32",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(() => preparation.promise),
      recoverAfterApplyFailure: recover
    });
    await service.check();

    const apply = service.relaunch();
    await Promise.resolve();
    await expect(service.changeFeed("https://updates.example.com/joko/beta")).resolves.toBe(true);
    preparation.resolve();

    await expect(apply).resolves.toEqual({ accepted: false, reason: "not-ready" });
    expect(driver.relaunchToInstall).not.toHaveBeenCalled();
    expect(recover).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(driver.configure).toHaveBeenCalledTimes(2));
  });

  it("holds apply/check dedupe through a deferred macOS install error and then recovers", async () => {
    const handoff = deferred<void>();
    const driver = fakeDriver({ available: true, version: "7.0.0" });
    vi.mocked(driver.relaunchToInstall).mockReturnValue(handoff.promise);
    const recover = vi.fn(async () => undefined);
    const service = createDesktopUpdateService({
      driver,
      isPackaged: true,
      platform: "darwin",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(async () => undefined),
      recoverAfterApplyFailure: recover
    });
    await service.check();
    const checksBeforeApply = vi.mocked(driver.checkForUpdates).mock.calls.length;

    const first = service.relaunch();
    await Promise.resolve();
    const second = service.relaunch();
    expect(second).toBe(first);
    await expect(service.check()).resolves.toEqual({ status: "available", version: "7.0.0" });
    expect(driver.checkForUpdates).toHaveBeenCalledTimes(checksBeforeApply);
    expect(driver.relaunchToInstall).toHaveBeenCalledOnce();

    driver.emitError();
    handoff.reject(new Error("deferred native updater failure"));
    await expect(first).resolves.toEqual({ accepted: false, reason: "apply-failed" });
    expect(recover).toHaveBeenCalledOnce();
    expect(service.getStatus()).toEqual({ status: "ready", version: "7.0.0" });
  });

  it("recovers Orchestrator and reports apply-failed after a bounded silent handoff rejection", async () => {
    vi.useFakeTimers();
    const driver = fakeDriver({ available: true, version: "8.0.0" });
    vi.mocked(driver.relaunchToInstall).mockImplementation(() => new Promise((_, rejectPromise) => {
      setTimeout(() => rejectPromise(new Error("install handoff timed out")), 500);
    }));
    const recover = vi.fn(async () => undefined);
    const service = createDesktopUpdateService({
      driver,
      isPackaged: true,
      platform: "darwin",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(async () => undefined),
      recoverAfterApplyFailure: recover
    });
    try {
      await service.check();
      const apply = service.relaunch();
      await vi.advanceTimersByTimeAsync(500);
      await expect(apply).resolves.toEqual({ accepted: false, reason: "apply-failed" });
      expect(recover).toHaveBeenCalledOnce();
      expect(service.getStatus()).toEqual({ status: "ready", version: "8.0.0" });
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("settles a pending relaunch on dispose without recovering Orchestrator during app shutdown", async () => {
    const handoff = deferred<void>();
    const driver = fakeDriver({ available: true, version: "9.0.0" });
    vi.mocked(driver.relaunchToInstall).mockReturnValue(handoff.promise);
    vi.mocked(driver.dispose).mockImplementation(() => handoff.reject(new Error("driver disposed")));
    const recover = vi.fn(async () => undefined);
    const service = createDesktopUpdateService({
      driver,
      isPackaged: true,
      platform: "win32",
      currentVersion: "1.0.0",
      feedUrl: "https://updates.example.com/joko",
      prepareToApply: vi.fn(async () => undefined),
      recoverAfterApplyFailure: recover
    });
    await service.check();
    const relaunch = service.relaunch();
    await Promise.resolve();
    service.dispose();

    await expect(relaunch).resolves.toEqual({ accepted: false, reason: "apply-failed" });
    expect(recover).not.toHaveBeenCalled();
  });
});

function createAvailableService(
  driver: FakeDriver,
  prepareToApply: () => Promise<void> = vi.fn(async () => undefined)
) {
  return createDesktopUpdateService({
    driver,
    isPackaged: true,
    platform: "win32",
    currentVersion: "1.0.0",
    feedUrl: "https://updates.example.com/joko",
    prepareToApply
  });
}

function fakeDriver(result: DesktopUpdateDriverCheckResult | null = { available: false }): FakeDriver {
  let progressListener: (progress: DesktopUpdateDriverProgressInfo) => void = () => undefined;
  let errorListener: () => void = () => undefined;
  return {
    configure: vi.fn(),
    hydrateStagedUpdate: vi.fn(async () => null),
    quarantineStagedUpdate: vi.fn(async () => true),
    promoteStagedUpdate: vi.fn(async () => ({ promoted: true, previousReadyPreserved: false })),
    checkForUpdates: vi.fn(async () => result),
    downloadUpdate: vi.fn(async () => undefined),
    relaunchToInstall: vi.fn(async () => undefined),
    onProgress: vi.fn((listener) => {
      progressListener = listener;
      return () => { progressListener = () => undefined; };
    }),
    onError: vi.fn((listener) => {
      errorListener = listener;
      return () => { errorListener = () => undefined; };
    }),
    dispose: vi.fn(),
    emitProgress: (progress) => progressListener(progress),
    emitError: () => errorListener()
  };
}

function progressInfo(
  percent: number,
  overrides: Partial<Omit<DesktopUpdateDriverProgressInfo, "percent">> = {}
): DesktopUpdateDriverProgressInfo {
  return {
    percent,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    ...overrides
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
