import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;
const pkg = JSON.parse(readFileSync(new URL("package.json", project), "utf8"));
const config = readFileSync(new URL("app.config.ts", project), "utf8");
const runtime = readFileSync(new URL("src/mobile-update-runtime.ts", project), "utf8");
const controller = readFileSync(new URL("src/mobile-update-controller.ts", project), "utf8");
const surface = readFileSync(new URL("src/MobileUpdateSurface.tsx", project), "utf8");
const root = readFileSync(new URL("src/App.tsx", project), "utf8");

describe("mobile update native boundary", () => {
  it("keeps the checked-in build inert and pins a fingerprint runtime with manual checks", () => {
    expect(app.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(app.updates).toEqual({
      enabled: false,
      checkAutomatically: "NEVER",
      fallbackToCacheTimeout: 0,
      requestHeaders: { "expo-channel-name": "stable" }
    });
    expect(app.updates).not.toHaveProperty("disableAntiBrickingMeasures");
    expect(pkg.dependencies["expo-application"]).toBe("57.0.3");
    expect(pkg.dependencies["expo-updates"]).toBe("57.0.18");
  });

  it("accepts only build-time Joko authority variables and exposes a strict credential-free v1 record", () => {
    expect(config).toContain('"JOKO_MOBILE_UPDATE_FEED_URL"');
    expect(config).toContain('"JOKO_MOBILE_OTA_URL"');
    expect(config).toContain('"JOKO_MOBILE_BETA_UPDATES"');
    expect(config).toContain('checkAutomatically: "NEVER"');
    expect(config).toContain('requestHeaders: { "expo-channel-name": "stable" }');
    expect(config).toContain('releaseFeedUrl: update.releaseFeedUrl ?? ""');
  });

  it("switches only the channel header and never enables the unsafe runtime URL override", () => {
    expect(runtime).toContain("Updates.setUpdateRequestHeadersOverride(mobileUpdateChannelHeaders(channel))");
    expect(runtime).not.toContain("setUpdateURLAndRequestHeadersOverride");
    expect(runtime).toContain('credentials: "omit"');
    expect(runtime).toContain('cache: "no-store"');
    expect(runtime).toContain('redirect: "error"');
    expect(runtime).toContain("Application.nativeApplicationVersion");
  });

  it("owns startup, resume, manual, emergency, forced, and reload-loop behavior in one coordinator", () => {
    expect(controller).toContain("new MobileUpdateRequestCoordinator(options.runtime)");
    expect(controller).toContain("#runStartupOta");
    expect(controller).toContain("#recoverEmergencyOta");
    expect(controller).toContain("#runManualCheck");
    expect(controller).toContain("#runResumeCheck");
    expect(controller).toContain("#runForcedRecheck");
    expect(controller).toContain("isReloadBlocked");
    expect(controller).toContain("recordReload");
  });

  it("mounts update startup, lifecycle, Settings, optional prompt, and back-proof forced gate at root", () => {
    expect(root).toContain("mobileUpdates.start(AppState.currentState");
    expect(root).toContain("mobileUpdates.handleAppStateChange(status)");
    expect(root).toContain('updates.startup === "checking"');
    expect(root).not.toContain("<MobileUpdateSettingsScreen");
    expect(root).toContain("<MobileSettingsScreen");
    expect(root).toContain("updates={updates} updateActions={mobileUpdateActions}");
    expect(root).toContain("<MobileUpdatePrompt");
    expect(root).toContain("<MobileForcedUpdateGate");
    expect(surface).toContain('BackHandler.addEventListener("hardwareBackPress", () => true)');
    expect(surface).toContain("actions.onRecheckForced()");
    expect(surface).toContain("actions.onOpenUpdate(target)");
  });
});
