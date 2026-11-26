import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPEARANCE_PREFERENCES,
  applyAppearanceTypography,
  clampWindowZoom,
  normalizeAppearancePreferences,
  windowZoomAfterIntent
} from "./appearance-settings.js";

describe("appearance preferences", () => {
  it("normalizes untrusted persisted values with the supported bounds and defaults", () => {
    expect(normalizeAppearancePreferences({
      uiFamily: "  Inter  ",
      codeFamily: 42,
      terminalFamily: "  Terminal Mono  ",
      uiSize: 99,
      codeSize: 9.6,
      terminalSize: 18.2,
      windowZoom: 1.26
    })).toEqual({
      chatLayout: "standard", chatWidthPercent: 75,
      uiFamily: "Inter",
      codeFamily: "",
      terminalFamily: "Terminal Mono",
      uiSize: 24,
      codeSize: 10,
      terminalSize: 18,
      windowZoom: 1.3
    });
    expect(normalizeAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(normalizeAppearancePreferences({ chatLayout: "wide", chatWidthPercent: 95 })).toMatchObject({ chatLayout: "wide", chatWidthPercent: 95 });
    expect(normalizeAppearancePreferences({ chatWidthPercent: 56 }).chatWidthPercent).toBe(75);
    expect(clampWindowZoom(Number.NaN)).toBe(1);
    expect(windowZoomAfterIntent(1.2, "increase")).toBe(1.3);
    expect(windowZoomAfterIntent(0.5, "decrease")).toBe(0.5);
    expect(windowZoomAfterIntent(2.4, "reset")).toBe(1);
  });

  it("updates both root and detached-document body targets and removes empty overrides", () => {
    const setProperty = vi.fn();
    const removeProperty = vi.fn();
    const target = { style: { setProperty, removeProperty } } as unknown as Pick<HTMLElement, "style">;
    applyAppearanceTypography(DEFAULT_APPEARANCE_PREFERENCES, [target, target]);
    expect(setProperty).toHaveBeenCalledWith("--app-ui-font-size", "14px");
    expect(setProperty).toHaveBeenCalledWith("--app-code-font-size", "14px");
    expect(removeProperty).toHaveBeenCalledWith("--app-font-ui");
    expect(removeProperty).toHaveBeenCalledWith("--app-font-code");
    expect(removeProperty).toHaveBeenCalledWith("--app-font-terminal");
    expect(removeProperty).toHaveBeenCalledWith("--app-terminal-font-size");
  });
});
