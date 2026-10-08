import { describe, expect, it } from "vitest";
import { mobileDeviceNameSource, validMobileDeviceName } from "./mobile-device-name";

describe("mobile device name source", () => {
  it("reports the trimmed native name without replacing it with a node or platform name", () => {
    expect(mobileDeviceNameSource("  Field tablet  ", "ios").defaultDisplayName).toBe("Field tablet");
  });

  it.each([
    { nativeName: undefined, platform: "android", expected: "Joko android" },
    { nativeName: null, platform: "ios", expected: "Joko ios" },
    { nativeName: "  ", platform: "ios", expected: "Joko ios" }
  ])("uses $expected when the native name is absent", ({ nativeName, platform, expected }) => {
    expect(mobileDeviceNameSource(nativeName, platform).defaultDisplayName).toBe(expected);
  });

  it("uses the shared 128-character name boundary for native sources and manual names", () => {
    const maximum = "a".repeat(128);
    expect(mobileDeviceNameSource(maximum, "ios").defaultDisplayName).toBe(maximum);
    expect(validMobileDeviceName(`  ${maximum}  `)).toBe(true);
    expect(validMobileDeviceName(" ")).toBe(false);
    expect(validMobileDeviceName("a".repeat(129))).toBe(false);
    expect(validMobileDeviceName("phone\u0000name")).toBe(false);
    expect(validMobileDeviceName("phone\u007fname")).toBe(false);
    expect(() => mobileDeviceNameSource("a".repeat(129), "ios")).toThrow(/native device name is invalid/u);
    expect(() => mobileDeviceNameSource("phone\u0000name", "ios")).toThrow(/native device name is invalid/u);
  });
});
