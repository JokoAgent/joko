import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPEARANCE_PREFERENCES,
  applyAppearanceTypography,
  clampWindowZoom,
  normalizeAppearancePreferences
} from "./appearance-settings.js";

describe("appearance preferences", () => {
  it("normalizes untrusted persisted values with the supported bounds and defaults", () => {
    expect(normalizeAppearancePreferences({
      uiFamily: "  Inter  ",
      codeFamily: 42,
      uiSize: 99,
      codeSize: 9.6,
      windowZoom: 1.26
    })).toEqual({
      uiFamily: "Inter",
      codeFamily: "",
      uiSize: 24,
      codeSize: 10,
      windowZoom: 1.3
    });
    expect(normalizeAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    expect(clampWindowZoom(Number.NaN)).toBe(1);
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
  });
});
