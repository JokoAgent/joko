import { describe, expect, it, vi } from "vitest";
import { MobileUpdateController } from "./mobile-update-controller";
import { MobileUpdateDeviceStore } from "./mobile-update-device-store";
import type {
  MobileUpdateConfiguration,
  MobileUpdateRelease,
  MobileUpdateRuntime
} from "./mobile-update";

const otaId = "11111111-1111-4111-8111-111111111111";
const nextOtaId = "22222222-2222-4222-8222-222222222222";
const installUrl = "https://download.joko.app/mobile";
const disabledConfiguration: MobileUpdateConfiguration = {
  releaseFeedUrl: null,
  otaEnabled: false,
  betaEnabled: false
};
const otaConfiguration: MobileUpdateConfiguration = {
  releaseFeedUrl: null,
  otaEnabled: true,
  betaEnabled: true
};
const fullConfiguration: MobileUpdateConfiguration = {
  releaseFeedUrl: "https://updates.joko.app/latest",
  otaEnabled: true,
  betaEnabled: true
};

describe("MobileUpdateController", () => {
  it("makes an unconfigured build explicitly unavailable without touching the network", async () => {
    const harness = createHarness({ configuration: disabledConfiguration });
    await harness.controller.start(true);
    await harness.controller.manualCheck();
    expect(harness.controller.snapshot).toMatchObject({
      status: "ready",
      startup: "ready",
      authorityAvailable: false,
      manualOutcome: "unavailable"
    });
    expect(harness.runtime.checkOta).not.toHaveBeenCalled();
    expect(harness.runtime.fetchRelease).not.toHaveBeenCalled();
  });

  it("downloads and reloads a verified startup OTA while recording its durable loop guard first", async () => {
    const harness = createHarness({
      configuration: otaConfiguration,
      runtimePatch: {
        checkOta: vi.fn(async () => ({ isAvailable: true, manifestId: nextOtaId })),
        fetchOta: vi.fn(async () => ({ isNew: true, manifestId: nextOtaId }))
      }
    });
    await harness.controller.start(true);
    expect(harness.runtime.configureChannel).toHaveBeenCalledWith("stable");
    expect(harness.runtime.reload).toHaveBeenCalledOnce();
    expect(JSON.parse(harness.storage.value()!)).toEqual({
      version: 1,
      channel: "stable",
      reloadTargetId: nextOtaId,
      reloadCount: 1
    });
    expect(harness.controller.snapshot.startup).toBe("ready");
  });

  it("clears a reload guard only when its target is the update now running", async () => {
    const harness = createHarness({
      configuration: otaConfiguration,
      initialRecord: JSON.stringify({
        version: 1, channel: "stable", reloadTargetId: otaId, reloadCount: 2
      }),
      runtimePatch: {
        info: runtimeInfo({ updateId: otaId }),
        checkOta: vi.fn(async () => ({ isAvailable: false }))
      }
    });
    await harness.controller.start(true);
    expect(JSON.parse(harness.storage.value()!)).toEqual({
      version: 1, channel: "stable", reloadTargetId: null, reloadCount: 0
    });
  });

  it("fails startup open when a native check rejects", async () => {
    const harness = createHarness({
      configuration: otaConfiguration,
      runtimePatch: { checkOta: vi.fn(async () => { throw new Error("offline"); }) }
    });
    await expect(harness.controller.start(true)).resolves.toBeUndefined();
    expect(harness.controller.snapshot).toMatchObject({ status: "ready", startup: "ready" });
    expect(harness.runtime.reload).not.toHaveBeenCalled();
  });

  it("reports a still-draining timed-out native request instead of queuing a duplicate forever", async () => {
    vi.useFakeTimers();
    const check = deferred<{ isAvailable: boolean }>();
    const harness = createHarness({
      configuration: otaConfiguration,
      runtimePatch: { checkOta: vi.fn(() => check.promise) }
    });
    const starting = harness.controller.start(true);
    await vi.waitFor(() => expect(harness.runtime.checkOta).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(100);
    await starting;
    await harness.controller.manualCheck();
    expect(harness.controller.snapshot.manualOutcome).toBe("busy");
    expect(harness.runtime.checkOta).toHaveBeenCalledOnce();
    check.resolve({ isAvailable: false });
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();
  });

  it("fails startup open when native channel configuration is unavailable", async () => {
    const harness = createHarness({
      configuration: otaConfiguration,
      runtimePatch: { configureChannel: vi.fn(() => { throw new Error("native unavailable"); }) }
    });
    await expect(harness.controller.start(true)).resolves.toBeUndefined();
    expect(harness.controller.snapshot).toMatchObject({
      status: "ready",
      startup: "ready",
      actionError: "configuration"
    });
    expect(harness.runtime.checkOta).not.toHaveBeenCalled();
  });

  it("does not reload after startup moves to the background while download is in flight", async () => {
    const fetched = deferred<{ isNew: boolean; manifestId: string }>();
    const harness = createHarness({
      configuration: otaConfiguration,
      runtimePatch: {
        checkOta: vi.fn(async () => ({ isAvailable: true, manifestId: nextOtaId })),
        fetchOta: vi.fn(() => fetched.promise)
      }
    });
    const starting = harness.controller.start(true);
    await vi.waitFor(() => expect(harness.runtime.fetchOta).toHaveBeenCalledOnce());
    harness.controller.handleAppStateChange("background");
    fetched.resolve({ isNew: true, manifestId: nextOtaId });
    await starting;
    expect(harness.runtime.reload).not.toHaveBeenCalled();
    expect(harness.controller.snapshot.pendingRestart).toBe(true);
  });

  it("recovers an emergency launch in the background without attempting an impossible reload", async () => {
    const harness = createHarness({
      configuration: otaConfiguration,
      runtimePatch: {
        info: runtimeInfo({ isEmbeddedLaunch: false, isEmergencyLaunch: true }),
        checkOta: vi.fn(async () => ({ isAvailable: true, manifestId: nextOtaId })),
        fetchOta: vi.fn(async () => ({ isNew: true, manifestId: nextOtaId }))
      }
    });
    await harness.controller.start(true);
    await vi.waitFor(() => expect(harness.controller.snapshot.pendingRestart).toBe(true));
    expect(harness.runtime.reload).not.toHaveBeenCalled();
  });

  it("checks the whole-bundle authority before OTA and surfaces an optional install target", async () => {
    const release = releaseRecord();
    const harness = createHarness({
      configuration: fullConfiguration,
      runtimePatch: { fetchRelease: vi.fn(async () => release) }
    });
    await harness.controller.start(true);
    await vi.waitFor(() => expect(harness.controller.snapshot.prompt?.version).toBe("2.0.0"));
    harness.controller.dismissPrompt();
    harness.runtime.checkOta.mockClear();
    await harness.controller.manualCheck();
    expect(harness.controller.snapshot.manualOutcome).toBe("update-available");
    expect(harness.controller.snapshot.prompt).toEqual(release);
    expect(harness.runtime.checkOta).not.toHaveBeenCalled();
  });

  it("does not report up to date or enter OTA when the release authority is malformed", async () => {
    const harness = createHarness({
      configuration: fullConfiguration,
      runtimePatch: { fetchRelease: vi.fn(async () => ({ version: "bad" })) }
    });
    await harness.controller.start(true);
    harness.runtime.checkOta.mockClear();
    await harness.controller.manualCheck();
    expect(harness.controller.snapshot.manualOutcome).toBe("error");
    expect(harness.runtime.checkOta).not.toHaveBeenCalled();
  });

  it("coalesces automatic and manual reads of the same release authority observation", async () => {
    const pending = deferred<MobileUpdateRelease>();
    const harness = createHarness({
      configuration: fullConfiguration,
      runtimePatch: {
        info: runtimeInfo({ isEnabled: false }),
        fetchRelease: vi.fn(() => pending.promise)
      }
    });
    await harness.controller.start(true);
    await vi.waitFor(() => expect(harness.runtime.fetchRelease).toHaveBeenCalledOnce());
    const manual = harness.controller.manualCheck();
    await Promise.resolve();
    expect(harness.runtime.fetchRelease).toHaveBeenCalledOnce();
    pending.resolve(releaseRecord());
    await manual;
    expect(harness.controller.snapshot.manualOutcome).toBe("update-available");
    expect(harness.runtime.fetchRelease).toHaveBeenCalledOnce();
  });

  it("distinguishes up-to-date, downloaded-for-restart, and reload-loop-blocked OTA outcomes", async () => {
    const current = createHarness({ configuration: otaConfiguration });
    await current.controller.start(true);
    await current.controller.manualCheck();
    expect(current.controller.snapshot.manualOutcome).toBe("up-to-date");

    const background = createHarness({
      configuration: otaConfiguration,
      runtimePatch: {
        checkOta: vi.fn()
          .mockResolvedValueOnce({ isAvailable: false })
          .mockResolvedValueOnce({ isAvailable: true, manifestId: nextOtaId }),
        fetchOta: vi.fn(async () => ({ isNew: true, manifestId: nextOtaId }))
      }
    });
    await background.controller.start(true);
    background.controller.handleAppStateChange("background");
    await background.controller.manualCheck();
    expect(background.controller.snapshot.manualOutcome).toBe("restart-required");
    expect(background.runtime.reload).not.toHaveBeenCalled();

    const blocked = createHarness({
      configuration: otaConfiguration,
      initialRecord: JSON.stringify({
        version: 1, channel: "stable", reloadTargetId: nextOtaId, reloadCount: 2
      }),
      runtimePatch: {
        checkOta: vi.fn()
          .mockResolvedValueOnce({ isAvailable: false })
          .mockResolvedValueOnce({ isAvailable: true, manifestId: nextOtaId })
      }
    });
    await blocked.controller.start(true);
    await blocked.controller.manualCheck();
    expect(blocked.controller.snapshot.manualOutcome).toBe("reload-blocked");
    expect(blocked.runtime.fetchOta).not.toHaveBeenCalled();
  });

  it("runs a throttled true background-to-active check, downloads silently, and never reloads", async () => {
    let now = 1_000;
    const harness = createHarness({
      configuration: otaConfiguration,
      now: () => now,
      runtimePatch: {
        checkOta: vi.fn()
          .mockResolvedValueOnce({ isAvailable: false })
          .mockResolvedValueOnce({ isAvailable: true, manifestId: nextOtaId }),
        fetchOta: vi.fn(async () => ({ isNew: true, manifestId: nextOtaId }))
      }
    });
    await harness.controller.start(true);
    harness.controller.handleAppStateChange("inactive");
    expect(harness.controller.handleAppStateChange("active")).toBeUndefined();
    harness.controller.handleAppStateChange("background");
    now += 60_000;
    expect(harness.controller.handleAppStateChange("active")).toBeUndefined();
    harness.controller.handleAppStateChange("background");
    now += 5 * 60_000;
    await harness.controller.handleAppStateChange("active");
    expect(harness.runtime.fetchOta).toHaveBeenCalledOnce();
    expect(harness.runtime.reload).not.toHaveBeenCalled();
    expect(harness.controller.snapshot.pendingRestart).toBe(true);
  });

  it("persists beta before publishing it and rolls back when native channel configuration fails", async () => {
    const harness = createHarness({ configuration: otaConfiguration });
    await harness.controller.start(true);
    await harness.controller.setChannel("beta");
    expect(harness.controller.snapshot.channel).toBe("beta");
    expect(JSON.parse(harness.storage.value()!).channel).toBe("beta");

    harness.runtime.configureChannel.mockImplementationOnce(() => { throw new Error("native rejected"); });
    await expect(harness.controller.setChannel("stable")).rejects.toThrow("native rejected");
    expect(harness.controller.snapshot).toMatchObject({ channel: "beta", actionError: "channel" });
    expect(JSON.parse(harness.storage.value()!).channel).toBe("beta");
  });

  it("keeps a forced gate fail-closed on errors and stale records, then unlocks on fresh proof", async () => {
    const forced = releaseRecord({ runtimeVersion: "runtime-1", minVersion: "1.5.0" });
    const optional = releaseRecord({ version: "3.0.0", runtimeVersion: "runtime-3" });
    const harness = createHarness({
      configuration: fullConfiguration,
      runtimePatch: {
        fetchRelease: vi.fn()
          .mockResolvedValueOnce(forced)
          .mockRejectedValueOnce(new Error("offline"))
          .mockResolvedValueOnce(releaseRecord({ version: "1.5.0", runtimeVersion: "runtime-1" }))
          .mockResolvedValueOnce(optional)
      }
    });
    await harness.controller.start(true);
    await vi.waitFor(() => expect(harness.controller.snapshot.forced?.version).toBe("2.0.0"));
    await harness.controller.recheckForced();
    expect(harness.controller.snapshot).toMatchObject({ forced: expect.any(Object), forcedCheckFailed: true });
    await harness.controller.recheckForced();
    expect(harness.controller.snapshot).toMatchObject({ forced: expect.any(Object), forcedCheckFailed: true });
    await harness.controller.recheckForced();
    expect(harness.controller.snapshot.forced).toBeUndefined();
    expect(harness.controller.snapshot.prompt).toEqual(optional);
  });

  it("does not let a late forced recheck clear a newer observation", async () => {
    const held = releaseRecord({ runtimeVersion: "runtime-1", minVersion: "1.5.0" });
    const late = deferred<null>();
    const harness = createHarness({
      configuration: fullConfiguration,
      runtimePatch: {
        fetchRelease: vi.fn()
          .mockResolvedValueOnce(held)
          .mockImplementationOnce(() => late.promise)
          .mockResolvedValueOnce(held)
      }
    });
    await harness.controller.start(true);
    await vi.waitFor(() => expect(harness.controller.snapshot.forced).toBeDefined());
    const recheck = harness.controller.recheckForced();
    await vi.waitFor(() => expect(harness.runtime.fetchRelease).toHaveBeenCalledTimes(2));
    await harness.controller.setChannel("beta");
    const newerObservation = harness.controller.manualCheck();
    late.resolve(null);
    await recheck;
    await newerObservation;
    expect(harness.controller.snapshot.forced).toEqual(held);
    expect(harness.runtime.fetchRelease).toHaveBeenCalledTimes(3);
  });

  it("recovers an unreadable device record only after an explicit reset", async () => {
    const harness = createHarness({ configuration: disabledConfiguration, initialRecord: "broken" });
    await harness.controller.start(true);
    expect(harness.controller.snapshot).toMatchObject({ status: "error", actionError: "storage", startup: "ready" });
    await harness.controller.resetDeviceSettings();
    expect(harness.controller.snapshot).toMatchObject({ status: "ready", channel: "stable" });
  });
});

function createHarness(options: {
  configuration: MobileUpdateConfiguration;
  initialRecord?: string | null;
  runtimePatch?: Partial<MockRuntime>;
  now?: () => number;
}) {
  const storage = storageDriver(options.initialRecord ?? null);
  const runtime = runtimeStub(options.runtimePatch);
  const controller = new MobileUpdateController({
    configuration: options.configuration,
    platform: "android",
    runtime,
    deviceStore: new MobileUpdateDeviceStore(storage),
    now: options.now,
    startupCheckTimeoutMs: 100,
    startupFetchTimeoutMs: 100,
    manualCheckTimeoutMs: 100,
    manualFetchTimeoutMs: 100,
    releaseTimeoutMs: 100,
    resumeIntervalMs: 5 * 60_000
  });
  return { controller, runtime, storage };
}

type MockRuntime = MobileUpdateRuntime & {
  configureChannel: ReturnType<typeof vi.fn<MobileUpdateRuntime["configureChannel"]>>;
  checkOta: ReturnType<typeof vi.fn<MobileUpdateRuntime["checkOta"]>>;
  fetchOta: ReturnType<typeof vi.fn<MobileUpdateRuntime["fetchOta"]>>;
  reload: ReturnType<typeof vi.fn<MobileUpdateRuntime["reload"]>>;
  fetchRelease: ReturnType<typeof vi.fn<MobileUpdateRuntime["fetchRelease"]>>;
  openUrl: ReturnType<typeof vi.fn<MobileUpdateRuntime["openUrl"]>>;
};

function runtimeStub(patch: Partial<MockRuntime> = {}): MockRuntime {
  return {
    info: runtimeInfo(),
    configureChannel: vi.fn(() => undefined),
    checkOta: vi.fn(async () => ({ isAvailable: false })),
    fetchOta: vi.fn(async () => ({ isNew: false })),
    reload: vi.fn(async () => undefined),
    fetchRelease: vi.fn(async () => null),
    openUrl: vi.fn(async () => undefined),
    ...patch
  } as MockRuntime;
}

function runtimeInfo(patch: Partial<MobileUpdateRuntime["info"]> = {}): MobileUpdateRuntime["info"] {
  return {
    appVersion: "1.0.0",
    runtimeVersion: "runtime-1",
    isEnabled: true,
    isEmbeddedLaunch: true,
    isEmergencyLaunch: false,
    ...patch
  };
}

function releaseRecord(patch: Partial<MobileUpdateRelease> = {}): MobileUpdateRelease {
  return {
    version: "2.0.0",
    runtimeVersion: "runtime-2",
    installUrl,
    releaseNotes: "A safer mobile runtime.",
    ...patch
  };
}

function storageDriver(initial: string | null) {
  let value = initial;
  return {
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => { value = next; }),
    value: () => value
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
