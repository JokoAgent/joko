import { describe, expect, it, vi } from "vitest";
import {
  MobileUpdateRequestCoordinator,
  compareMobileUpdateVersions,
  evaluateMobileBundleUpdate,
  mobileUpdateChannelHeaders,
  mobileUpdateManifestId,
  parseMobileUpdateConfiguration,
  parseMobileUpdateRelease,
  withMobileUpdateTimeout,
  type MobileUpdateRuntime
} from "./mobile-update";

const installUrl = "https://download.joko.app/mobile";

describe("mobile update contracts", () => {
  it("accepts only the exact current runtime configuration", () => {
    expect(parseMobileUpdateConfiguration({
      version: 1,
      releaseFeedUrl: "https://updates.joko.app/latest",
      otaEnabled: true,
      betaEnabled: true
    })).toEqual({
      releaseFeedUrl: "https://updates.joko.app/latest",
      otaEnabled: true,
      betaEnabled: true
    });
    for (const value of [
      undefined,
      { version: 0, releaseFeedUrl: null, otaEnabled: false, betaEnabled: false },
      { version: 1, releaseFeedUrl: "", otaEnabled: false, betaEnabled: true },
      { version: 1, releaseFeedUrl: "", otaEnabled: false, betaEnabled: false, legacy: true },
      { version: 1, releaseFeedUrl: "http://updates.joko.app", otaEnabled: false, betaEnabled: false },
      { version: 1, releaseFeedUrl: "https://127.0.0.1/latest", otaEnabled: false, betaEnabled: false },
      { version: 1, releaseFeedUrl: "https://user@updates.joko.app", otaEnabled: false, betaEnabled: false }
    ]) expect(() => parseMobileUpdateConfiguration(value)).toThrow();
    expect(parseMobileUpdateConfiguration({
      version: 1, releaseFeedUrl: "", otaEnabled: false, betaEnabled: false
    })).toEqual({ releaseFeedUrl: null, otaEnabled: false, betaEnabled: false });
  });

  it("parses a bounded public release and rejects ambiguous or unusable records", () => {
    expect(parseMobileUpdateRelease({
      version: "2.3.4",
      runtimeVersion: "runtime-2",
      installUrl,
      minVersion: "2.0.0",
      releaseNotes: "A safer mobile runtime."
    })).toEqual({
      version: "2.3.4",
      runtimeVersion: "runtime-2",
      installUrl,
      minVersion: "2.0.0",
      releaseNotes: "A safer mobile runtime."
    });
    for (const value of [
      null,
      { version: "2.3", runtimeVersion: "runtime-2", installUrl },
      { version: "02.3.4", runtimeVersion: "runtime-2", installUrl },
      { version: "2.3.4", runtimeVersion: "", installUrl },
      { version: "2.3.4", runtimeVersion: "runtime-2", installUrl: "https://localhost/mobile" },
      { version: "2.3.4", runtimeVersion: "runtime-2", installUrl: `${installUrl}?token=secret` },
      { version: "2.3.4", runtimeVersion: "runtime-2", installUrl, oldShape: true },
      { version: "2.3.4", runtimeVersion: "runtime-2", installUrl, releaseNotes: "x".repeat(4_001) }
    ]) expect(() => parseMobileUpdateRelease(value)).toThrow();
  });

  it("discovers whole-bundle updates and keeps a coherent minimum-version gate usable", () => {
    const release = parseMobileUpdateRelease({ version: "2.0.0", runtimeVersion: "runtime-2", installUrl });
    expect(evaluateMobileBundleUpdate({ currentVersion: "1.0.0", currentRuntimeVersion: "runtime-1", release }))
      .toEqual({ needsUpdate: true, forced: false, target: release });
    expect(evaluateMobileBundleUpdate({ currentVersion: "2.0.0", currentRuntimeVersion: "runtime-1", release }))
      .toEqual({ needsUpdate: false, forced: false });
    expect(evaluateMobileBundleUpdate({ currentVersion: "1.0.0", currentRuntimeVersion: "runtime-2", release }))
      .toEqual({ needsUpdate: false, forced: false });

    const forced = parseMobileUpdateRelease({
      version: "2.0.0", runtimeVersion: "runtime-1", installUrl, minVersion: "1.5.0"
    });
    expect(evaluateMobileBundleUpdate({ currentVersion: "1.0.0", currentRuntimeVersion: "runtime-1", release: forced }))
      .toEqual({ needsUpdate: true, forced: true, target: forced });
    const impossible = parseMobileUpdateRelease({
      version: "2.0.0", runtimeVersion: "runtime-2", installUrl, minVersion: "3.0.0"
    });
    expect(evaluateMobileBundleUpdate({ currentVersion: "1.0.0", currentRuntimeVersion: "runtime-1", release: impossible }))
      .toEqual({ needsUpdate: true, forced: false, target: impossible });
  });

  it("uses canonical versions, bounded manifest identities, and a single channel header", () => {
    expect(compareMobileUpdateVersions("10.0.0", "2.9.9")).toBe(1);
    expect(compareMobileUpdateVersions("1.2.3", "1.2.3")).toBe(0);
    expect(mobileUpdateManifestId({ id: "ABCDEF12-3456-7890-ABCD-EF1234567890" }))
      .toBe("abcdef12-3456-7890-abcd-ef1234567890");
    expect(mobileUpdateManifestId({ id: " x " })).toBeUndefined();
    expect(mobileUpdateChannelHeaders("beta")).toEqual({ "expo-channel-name": "beta" });
  });

  it("keeps the native request lease until a timed-out promise really settles", async () => {
    vi.useFakeTimers();
    const firstCheck = deferred<{ isAvailable: boolean }>();
    const configured: string[] = [];
    const runtime = runtimeStub({
      configureChannel: (channel) => { configured.push(channel); },
      checkOta: vi.fn()
        .mockImplementationOnce(() => firstCheck.promise)
        .mockResolvedValueOnce({ isAvailable: false })
    });
    const coordinator = new MobileUpdateRequestCoordinator(runtime);
    const first = coordinator.run("stable", async (client) => {
      try { await withMobileUpdateTimeout(client.check(), 10); }
      catch { return "timed-out"; }
      return "unexpected";
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe("timed-out");
    expect(coordinator.busy).toBe(true);

    const second = coordinator.run("beta", (client) => client.check());
    await Promise.resolve();
    expect(configured).toEqual(["stable"]);
    firstCheck.resolve({ isAvailable: false });
    await expect(second).resolves.toEqual({ isAvailable: false });
    await coordinator.waitUntilIdle();
    expect(configured).toEqual(["stable", "beta"]);
    expect(coordinator.busy).toBe(false);
    vi.useRealTimers();
  });
});

function runtimeStub(patch: Partial<MobileUpdateRuntime> = {}): MobileUpdateRuntime {
  return {
    info: {
      appVersion: "1.0.0",
      runtimeVersion: "runtime-1",
      isEnabled: true,
      isEmbeddedLaunch: true,
      isEmergencyLaunch: false
    },
    configureChannel: () => undefined,
    checkOta: async () => ({ isAvailable: false }),
    fetchOta: async () => ({ isNew: false }),
    reload: async () => undefined,
    fetchRelease: async () => null,
    openUrl: async () => undefined,
    ...patch
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
