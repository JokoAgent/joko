import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;
const pkg = JSON.parse(readFileSync(new URL("package.json", project), "utf8"));
const native = readFileSync(new URL("src/native-notifications.ts", project), "utf8");
const android = readFileSync(new URL("src/native-notifications.android.ts", project), "utf8");
const controller = readFileSync(new URL("src/mobile-push-controller.ts", project), "utf8");
const root = readFileSync(new URL("src/App.tsx", project), "utf8");

describe("mobile push native boundary", () => {
  it("pins the real iOS module and excludes it from Android native autolinking", () => {
    expect(pkg.dependencies["expo-notifications"]).toBe("~57.0.15");
    expect(pkg.expo.autolinking.android.exclude).toContain("expo-notifications");
    expect(app.ios.entitlements["aps-environment"]).toBe("production");
    expect(app.android.blockedPermissions).toContain("android.permission.POST_NOTIFICATIONS");
  });

  it("keeps the runtime import behind a platform file with an explicit Android failure adapter", () => {
    expect(native).toContain('from "expo-notifications"');
    expect(android).not.toContain('from "expo-notifications"');
    expect(android).toContain("not supported on Android");
    expect(android).toContain("PermissionStatus.DENIED");
  });

  it("wires startup, foreground, locale, Settings, and public-intent delivery at the root", () => {
    expect(root).toContain("new MobilePushController");
    expect(root).toContain("mobilePush.start(offerUrl)");
    expect(root).toContain("mobilePush.handleAppStateChange(foreground)");
    expect(root).toContain("mobilePush.setLocale(locale.effectiveLocale)");
    expect(root).toContain("onPushEnabledChange={(enabled) => mobilePush.setEnabled(enabled)}");
    expect(controller).toContain("shouldShowBanner: false");
    expect(controller).toContain("parseMobileNotificationResponseIntent(response)");
  });
});
