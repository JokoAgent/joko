import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "ios",
  googlePlay: false,
  startInstaller: vi.fn(() => false),
  configure: vi.fn(),
  check: vi.fn(async () => ({
    isAvailable: true,
    manifest: { id: "ABCDEF12-3456-7890-ABCD-EF1234567890" }
  })),
  fetch: vi.fn(async () => ({
    isNew: true,
    manifest: { id: "22222222-2222-4222-8222-222222222222" }
  })),
  reload: vi.fn(async () => undefined),
  canOpen: vi.fn(async () => true),
  open: vi.fn(async () => undefined)
}));

vi.mock("expo-application", () => ({ nativeApplicationVersion: "1.2.3", applicationId: "app.joko.mobile" }));
vi.mock("./mobile-android-installer", () => ({
  isMobileGooglePlayInstallation: () => native.googlePlay,
  mobileAndroidInstaller: { start: native.startInstaller }
}));
vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "9.9.9-from-ota",
      extra: {
        jokoMobileUpdate: {
          version: 1,
          releaseFeedUrl: "https://updates.joko.app/latest",
          otaEnabled: true,
          betaEnabled: true
        }
      }
    }
  }
}));
vi.mock("expo-updates", () => ({
  isEnabled: true,
  updateId: "11111111-1111-4111-8111-111111111111",
  channel: "stable",
  runtimeVersion: "runtime-native",
  isEmergencyLaunch: false,
  emergencyLaunchReason: null,
  isEmbeddedLaunch: false,
  createdAt: new Date(2026, 8, 21, 9, 30),
  setUpdateRequestHeadersOverride: native.configure,
  checkForUpdateAsync: native.check,
  fetchUpdateAsync: native.fetch,
  reloadAsync: native.reload
}));
vi.mock("react-native", () => ({
  Platform: { get OS() { return native.platform; } },
  Linking: { canOpenURL: native.canOpen, openURL: native.open }
}));

import {
  ExpoMobileUpdateRuntime,
  createMobileUpdateRuntimeEnvironment
} from "./mobile-update-runtime";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  native.platform = "ios";
  native.googlePlay = false;
  native.startInstaller.mockReturnValue(false);
});

describe("ExpoMobileUpdateRuntime", () => {
  it("uses native app truth, the exact v1 config, and header-only channel switching", async () => {
    const environment = createMobileUpdateRuntimeEnvironment();
    expect(environment).toMatchObject({
      platform: "ios",
      configuration: {
        releaseFeedUrl: "https://updates.joko.app/latest",
        otaEnabled: true,
        betaEnabled: true
      }
    });
    expect(environment.runtime.info).toMatchObject({
      appVersion: "1.2.3",
      runtimeVersion: "runtime-native",
      updateId: "11111111-1111-4111-8111-111111111111",
      isEnabled: true,
      isEmbeddedLaunch: false
    });
    environment.runtime.configureChannel("beta");
    expect(native.configure).toHaveBeenCalledWith({ "expo-channel-name": "beta" });
    await expect(environment.runtime.checkOta()).resolves.toEqual({
      isAvailable: true,
      manifestId: "abcdef12-3456-7890-abcd-ef1234567890"
    });
    await expect(environment.runtime.fetchOta()).resolves.toEqual({
      isNew: true,
      manifestId: "22222222-2222-4222-8222-222222222222"
    });
  });

  it("fetches releases anonymously with platform, channel, cache-buster, and a bounded abort", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ release: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const runtime = new ExpoMobileUpdateRuntime();
    await expect(runtime.fetchRelease("https://updates.joko.app/latest", "ios", "beta", 100))
      .resolves.toEqual({ release: true });
    const [requested, options] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requested));
    expect(url.origin + url.pathname).toBe("https://updates.joko.app/latest");
    expect(url.searchParams.get("platform")).toBe("ios");
    expect(url.searchParams.get("channel")).toBe("beta");
    expect(url.searchParams.get("t")).toMatch(/^\d+$/u);
    expect(options).toMatchObject({ method: "GET", credentials: "omit", cache: "no-store", redirect: "error" });
    expect(options!.headers).toEqual({ Accept: "application/json" });
  });

  it("treats a release 404 as an authoritative absence and opens only public HTTPS install pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const runtime = new ExpoMobileUpdateRuntime();
    await expect(runtime.fetchRelease("https://updates.joko.app/latest", "ios", "stable", 100))
      .resolves.toBeNull();
    await expect(runtime.openRelease(release("https://download.joko.app/mobile"))).resolves.toBeUndefined();
    expect(native.open).toHaveBeenCalledWith("https://download.joko.app/mobile");
    await expect(runtime.openRelease(release("https://localhost/mobile"))).rejects.toThrow("install target");
    await expect(runtime.openRelease(release("https://download.joko.app/mobile?token=secret"))).rejects.toThrow("install target");
  });

  it("routes Android APKs to the shared installer and keeps browser fallback for unavailable native support", async () => {
    native.platform = "android";
    native.startInstaller.mockReturnValue(true);
    const runtime = new ExpoMobileUpdateRuntime();
    const target = release("https://download.joko.app/mobile.apk");
    await runtime.openRelease(target);
    expect(native.startInstaller).toHaveBeenCalledWith({ version: target.version, installUrl: target.installUrl });
    expect(native.open).not.toHaveBeenCalled();
    native.startInstaller.mockReturnValue(false);
    await runtime.openRelease(release("https://download.joko.app/mobile"));
    expect(native.open).toHaveBeenCalledWith("https://download.joko.app/mobile");
  });

  it("keeps Google Play installations on Play even for a stale direct APK target", async () => {
    native.platform = "android";
    native.googlePlay = true;
    const runtime = new ExpoMobileUpdateRuntime();
    expect(runtime.bundleUpdatesSupported).toBe(false);
    native.open.mockRejectedValueOnce(new Error("market unavailable"));
    await runtime.openRelease(release("https://download.joko.app/mobile.apk"));
    expect(native.startInstaller).not.toHaveBeenCalled();
    expect(native.open).toHaveBeenNthCalledWith(1, "market://details?id=app.joko.mobile");
    expect(native.open).toHaveBeenNthCalledWith(2, "https://play.google.com/store/apps/details?id=app.joko.mobile");
  });

  it("rejects on its own deadline even if a native fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const runtime = new ExpoMobileUpdateRuntime();
    const request = runtime.fetchRelease("https://updates.joko.app/latest", "ios", "stable", 25);
    const rejection = expect(request).rejects.toThrow("mobile-release-timeout(25ms)");
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    vi.useRealTimers();
  });

  it("rejects an oversized release response before it can enter product state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(16_385), { status: 200 })));
    const runtime = new ExpoMobileUpdateRuntime();
    await expect(runtime.fetchRelease("https://updates.joko.app/latest", "ios", "stable", 100))
      .rejects.toThrow("mobile-release-response-too-large");
  });
});

function release(installUrl: string) {
  return { version: "1.2.4", runtimeVersion: "runtime-new", installUrl };
}
