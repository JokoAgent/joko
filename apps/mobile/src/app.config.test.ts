import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigContext } from "expo/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import mobileExpoConfig, {
  JOKO_MOBILE_BETA_ENV,
  JOKO_MOBILE_OTA_ENV,
  JOKO_MOBILE_UPDATE_FEED_ENV,
  resolveMobileUpdateBuildConfiguration
} from "../app.config";

describe("mobile update build configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("retains iOS view controller status-bar ownership through the resolved Expo configuration", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const { expo } = JSON.parse(readFileSync(resolve(directory, "../app.json"), "utf8")) as { expo: ConfigContext["config"] };
    const config = mobileExpoConfig({ config: expo } as ConfigContext);
    expect(config.ios?.infoPlist?.UIViewControllerBasedStatusBarAppearance).toBe(true);
  });

  it("declares Android package installation only for builds with the full-package feed", () => {
    const context = { config: { name: "Joko", slug: "joko", android: {
      permissions: ["android.permission.INTERNET"]
    } } } as unknown as ConfigContext;
    vi.stubEnv(JOKO_MOBILE_UPDATE_FEED_ENV, "");
    expect(mobileExpoConfig(context).android?.permissions).toEqual(["android.permission.INTERNET"]);
    vi.stubEnv(JOKO_MOBILE_UPDATE_FEED_ENV, "https://updates.joko.app/latest");
    expect(mobileExpoConfig(context).android?.permissions).toEqual([
      "android.permission.INTERNET", "android.permission.REQUEST_INSTALL_PACKAGES"
    ]);
  });
  it("accepts only the closed Joko HTTPS authority and device-local beta flag", () => {
    expect(resolveMobileUpdateBuildConfiguration({
      [JOKO_MOBILE_UPDATE_FEED_ENV]: "https://updates.joko.app/releases",
      [JOKO_MOBILE_OTA_ENV]: "https://ota.joko.app/api/manifest",
      [JOKO_MOBILE_BETA_ENV]: "1",
      UNRELATED_SECRET: "ignored"
    })).toEqual({
      releaseFeedUrl: "https://updates.joko.app/releases",
      otaUrl: "https://ota.joko.app/api/manifest",
      betaEnabled: true
    });
    for (const environment of [
      { [JOKO_MOBILE_BETA_ENV]: "yes" },
      { [JOKO_MOBILE_BETA_ENV]: "1" },
      { [JOKO_MOBILE_OTA_ENV]: "http://ota.joko.app" },
      { [JOKO_MOBILE_OTA_ENV]: "https://localhost/manifest" },
      { [JOKO_MOBILE_OTA_ENV]: "https://user:secret@ota.joko.app/manifest" },
      { [JOKO_MOBILE_UPDATE_FEED_ENV]: "https://updates.joko.app/latest?token=secret" }
    ]) expect(() => resolveMobileUpdateBuildConfiguration(environment)).toThrow();
  });

  it("emits a fingerprint runtime, manual-only OTA checks, and only a stable request header", () => {
    const config = mobileExpoConfig({
      config: { name: "Joko", slug: "joko", extra: { retained: true } }
    } as unknown as ConfigContext);
    expect(config.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(config.updates).toEqual({
      enabled: false,
      checkAutomatically: "NEVER",
      fallbackToCacheTimeout: 0,
      requestHeaders: { "expo-channel-name": "stable" }
    });
    expect(config.updates).not.toHaveProperty("disableAntiBrickingMeasures");
    expect(config.extra).toEqual({
      retained: true,
      jokoMobileUpdate: { version: 1, releaseFeedUrl: "", otaEnabled: false, betaEnabled: false }
    });
  });

  it("keeps the checked-in native default inert and pins both native update dependencies", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const app = JSON.parse(readFileSync(resolve(directory, "../app.json"), "utf8")) as {
      expo: { runtimeVersion?: unknown; updates?: Record<string, unknown> };
    };
    const pkg = JSON.parse(readFileSync(resolve(directory, "../package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(app.expo.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(app.expo.updates).toMatchObject({ enabled: false, checkAutomatically: "NEVER",
      requestHeaders: { "expo-channel-name": "stable" } });
    expect(app.expo.updates).not.toHaveProperty("url");
    expect(app.expo.updates).not.toHaveProperty("disableAntiBrickingMeasures");
    expect(pkg.dependencies?.["expo-application"]).toBe("57.0.3");
    expect(pkg.dependencies?.["expo-updates"]).toBe("57.0.18");
  });
});
