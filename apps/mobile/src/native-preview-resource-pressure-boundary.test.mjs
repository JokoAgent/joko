import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const moduleRoot = resolve(import.meta.dirname, "../modules/joko-mobile-resource-pressure");

describe("native preview resource-pressure boundary", () => {
  it("autolinks the same Joko-owned module on Android and iOS", () => {
    const config = JSON.parse(readFileSync(resolve(moduleRoot, "expo-module.config.json"), "utf8"));
    expect(config).toEqual({
      platforms: ["apple", "android"],
      apple: { modules: ["JokoMobileResourcePressureModule"] },
      android: { modules: ["app.joko.resourcepressure.JokoMobileResourcePressureModule"] }
    });
  });

  it("binds Android application pressure callbacks for the module lifetime", () => {
    const source = readFileSync(resolve(moduleRoot,
      "android/src/main/java/app/joko/resourcepressure/JokoMobileResourcePressureModule.kt"), "utf8");
    expect(source).toContain("ComponentCallbacks2");
    expect(source).toContain("registerComponentCallbacks");
    expect(source).toContain("unregisterComponentCallbacks");
    expect(source).toContain("override fun onTrimMemory");
    expect(source).toContain("override fun onLowMemory");
    expect(source).toContain("TRIM_MEMORY_UI_HIDDEN");
    expect(source).toContain('Events(RESOURCE_PRESSURE_EVENT)');
  });

  it("binds and removes the iOS memory-warning observer", () => {
    const source = readFileSync(resolve(moduleRoot,
      "ios/JokoMobileResourcePressureModule.swift"), "utf8");
    expect(source).toContain("UIApplication.didReceiveMemoryWarningNotification");
    expect(source).toContain("NotificationCenter.default.removeObserver");
    expect(source).toContain('Events("onResourcePressure")');
  });
});
