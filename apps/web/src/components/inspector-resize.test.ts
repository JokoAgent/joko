import { describe, expect, it } from "vitest";
import { INSPECTOR_DEFAULT_RATIO, inspectorPointerWidth, inspectorRatioForWidth, inspectorResizeDeltaForKey, inspectorWidthForRatio, normalizeInspectorRatio } from "./inspector-resize.js";

describe("right-sidebar sizing", () => {
  it("defaults to half of the available session workbench", () => {
    expect(inspectorWidthForRatio(1_200, INSPECTOR_DEFAULT_RATIO)).toBe(600);
  });

  it("keeps a 280px sidebar and a 400px main chat whenever space permits", () => {
    expect(inspectorWidthForRatio(1_000, 0.1)).toBe(280);
    expect(inspectorWidthForRatio(1_000, 0.9)).toBe(600);
    expect(inspectorWidthForRatio(600, 0.5)).toBe(200);
  });

  it("normalizes persisted and pointer-derived ratios to the 10–90 percent range", () => {
    expect(normalizeInspectorRatio(null)).toBe(0.5);
    expect(normalizeInspectorRatio("bad")).toBe(0.5);
    expect(normalizeInspectorRatio(0.01)).toBe(0.1);
    expect(normalizeInspectorRatio(2)).toBe(0.9);
    expect(inspectorRatioForWidth(1_000, 420)).toBe(0.42);
  });

  it("mirrors pointer and keyboard resizing when the panel moves left", () => {
    expect(inspectorPointerWidth(1_000, 620, "right")).toBe(380);
    expect(inspectorPointerWidth(100, 480, "left")).toBe(380);
    expect(inspectorResizeDeltaForKey("right", "ArrowLeft")).toBe(16);
    expect(inspectorResizeDeltaForKey("right", "ArrowRight", true)).toBe(-64);
    expect(inspectorResizeDeltaForKey("left", "ArrowLeft")).toBe(-16);
    expect(inspectorResizeDeltaForKey("left", "ArrowRight", true)).toBe(64);
  });
});
