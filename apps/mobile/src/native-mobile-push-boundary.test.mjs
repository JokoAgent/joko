import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;
const pkg = JSON.parse(readFileSync(new URL("package.json", project), "utf8"));
const native = readFileSync(new URL("src/native-notifications.ts", project), "utf8");
const android = readFileSync(new URL("with-joko-android-push.cjs", project), "utf8");
const controller = readFileSync(new URL("src/mobile-push-controller.ts", project), "utf8");
const root = readFileSync(new URL("src/App.tsx", project), "utf8");

describe("mobile push native boundary", () => {
  it("links the real notification module on both platforms and preserves the iOS entitlement", () => {
    expect(pkg.dependencies["expo-notifications"]).toBe("~57.0.15");
    expect(pkg.expo.autolinking.android.exclude).not.toContain("expo-notifications");
    expect(app.ios.entitlements["aps-environment"]).toBe("production");
    expect(app.android.blockedPermissions).toContain("android.permission.POST_NOTIFICATIONS");
  });

  it("uses the same Android channel in native presentation and the device request", () => {
    expect(native).toContain('from "expo-notifications"');
    expect(app.plugins).toContain("./with-joko-android-push.cjs");
    expect(native).toContain('setNotificationChannelAsync("joko-task-attention"');
    expect(android).toContain('"com.google.firebase.messaging.default_notification_channel_id", "joko-task-attention"');
    expect(android).toContain('"firebase_messaging_auto_init_enabled", "false"');
  });

  it("wires startup, foreground, locale, Settings, and public-intent delivery at the root", () => {
    expect(root).toContain("new MobilePushController");
    expect(root).toContain("mobilePush.handleAppStateChange(status)");
    expect(root).toContain("mobilePush.handleAppStateChange(AppState.currentState)");
    expect(root).toContain("mobilePush.setLocale(locale.effectiveLocale)");
    expect(root).toContain("onPushEnabledChange={(enabled) => mobilePush.setEnabled(enabled)}");
    expect(controller).toContain("shouldShowBanner: false");
    expect(controller).toContain("parseMobileNotificationResponseIntent(response)");
  });
});
