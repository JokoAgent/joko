import { describe, expect, it } from "vitest";
import { mobileKeyboardAvoidancePadding, mobileKeyboardObstructionHeight } from "./keyboard-layout";

const viewport = { viewportWidth: 390, viewportHeight: 844 };

describe("mobile keyboard geometry", () => {
  it("uses only the viewport obstruction of an iOS docked keyboard", () => {
    expect(mobileKeyboardObstructionHeight({
      platform: "ios", visible: true, frame: { screenX: 0, screenY: 544, width: 390, height: 300 }, ...viewport
    })).toBe(300);
    expect(mobileKeyboardAvoidancePadding(300, 34)).toBe(266);
  });

  it("does not lift the whole composer for floating, split, or cross-fade frames", () => {
    expect(mobileKeyboardObstructionHeight({
      platform: "ios", visible: true, frame: { screenX: 80, screenY: 400, width: 250, height: 250 }, ...viewport
    })).toBe(0);
    expect(mobileKeyboardObstructionHeight({
      platform: "ios", visible: true, frame: { screenX: 0, screenY: 0, width: 390, height: 844 }, ...viewport
    })).toBe(0);
  });

  it("recomputes obstruction against rotated viewport geometry", () => {
    const frame = { screenX: 0, screenY: 200, width: 844, height: 190 };
    expect(mobileKeyboardObstructionHeight({
      platform: "ios", visible: true, frame, viewportWidth: 844, viewportHeight: 390
    })).toBe(190);
  });

  it("leaves Android avoidance to one height KAV while retaining keyboard height for resize bounds", () => {
    expect(mobileKeyboardObstructionHeight({
      platform: "android", visible: true, frame: { screenX: 0, screenY: 544, width: 390, height: 300 }, ...viewport
    })).toBe(300);
    expect(mobileKeyboardAvoidancePadding(0, 24)).toBe(0);
  });
});
