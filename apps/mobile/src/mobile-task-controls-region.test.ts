import { describe, expect, it } from "vitest";
import type { MobileWindowGeometry } from "./mobile-window-geometry";
import { mobileTaskControlsRegion } from "./mobile-task-controls-region";

const base: MobileWindowGeometry = { width: 800, height: 1000, insets: { top: 20, right: 10, bottom: 20, left: 10 },
  regularWidth: true, regularHeight: true, barEdge: "none", regions: [], reservedRegionsSupported: false };

describe("Task controls region", () => {
  it("keeps normal flow when the current window has no reservations", () => {
    expect(mobileTaskControlsRegion({ geometry: base, detailLeft: 10, detailWidth: 780,
      keyboardHeight: 300, consumedBottomInset: 20 })).toBeUndefined();
  });
  it("maps a trailing pane and camera occlusion to local margins without crossing the navigation division", () => {
    const geometry = { ...base, reservedRegionsSupported: true, regions: [
      { kind: "division" as const, x: 250, y: 20, width: 20, height: 960 },
      { kind: "occlusion" as const, x: 750, y: 20, width: 40, height: 960 }
    ] };
    expect(mobileTaskControlsRegion({ geometry, detailLeft: 270, detailWidth: 520,
      keyboardHeight: 0, consumedBottomInset: 20 }))
      .toEqual({ marginLeft: 0, marginRight: 40, marginBottom: 0, maxHeight: 960, overflow: "hidden" });
  });
  it("keeps a lower pane's keyboard budget once and uses the upper pane when that lower pane is covered", () => {
    const geometry = { ...base, reservedRegionsSupported: true,
      regions: [{ kind: "division" as const, x: 10, y: 490, width: 780, height: 20 }] };
    expect(mobileTaskControlsRegion({ geometry, detailLeft: 10, detailWidth: 780,
      keyboardHeight: 200, consumedBottomInset: 20 }))
      .toEqual({ marginLeft: 0, marginRight: 0, marginBottom: 0, maxHeight: 290, overflow: "hidden" });
    expect(mobileTaskControlsRegion({ geometry, detailLeft: 10, detailWidth: 780,
      keyboardHeight: 600, consumedBottomInset: 20 }))
      .toEqual({ marginLeft: 0, marginRight: 0, marginBottom: 0, maxHeight: 380, overflow: "hidden" });
  });
  it("reserves the space below an upper control rectangle within the already inset flow", () => {
    const geometry = { ...base, reservedRegionsSupported: true,
      regions: [{ kind: "occlusion" as const, x: 10, y: 780, width: 780, height: 200 }] };
    expect(mobileTaskControlsRegion({ geometry, detailLeft: 10, detailWidth: 780,
      keyboardHeight: 0, consumedBottomInset: 20 }))
      .toEqual({ marginLeft: 0, marginRight: 0, marginBottom: 200, maxHeight: 760, overflow: "hidden" });
  });
});
