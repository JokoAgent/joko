import { describe, expect, it } from "vitest";

import { browserCommentTargetFromCanvas, scaleBrowserCommentPlacement } from "./ToolsPage.js";

describe("Browser screenshot comment targeting", () => {
  it("maps a click to intrinsic screenshot pixels", () => {
    expect(browserCommentTargetFromCanvas(
      { width: 1200, height: 800 },
      { x: 0.25, y: 0.5, region: false },
      { x: 0.25, y: 0.5 }
    )).toEqual({ kind: "element", point: { x: 300, y: 400 }, viewport: { width: 1200, height: 800 } });
  });

  it("maps a reverse Shift drag to a normalized region and release marker", () => {
    const target = browserCommentTargetFromCanvas(
      { width: 1000, height: 500 },
      { x: 0.8, y: 0.7, region: true },
      { x: 0.2, y: 0.1 }
    );
    expect(target).toMatchObject({
      kind: "region",
      point: { x: 200, y: 50 },
      viewport: { width: 1000, height: 500 },
      region: { x: 200, y: 50, height: 300 }
    });
    if (target.kind !== "region") throw new Error("Expected a region target.");
    expect(target.region.width).toBeCloseTo(600);
  });

  it("treats a tiny Shift click as an element selection", () => {
    expect(browserCommentTargetFromCanvas(
      { width: 1000, height: 500 },
      { x: 0.4, y: 0.4, region: true },
      { x: 0.405, y: 0.405 }
    ).kind).toBe("element");
  });

  it("preserves offscreen document projections instead of clamping markers to screenshot edges", () => {
    expect(scaleBrowserCommentPlacement({
      markerNumber: 3,
      point: { x: -12, y: 96 },
      viewport: { width: 1280, height: 720 },
      pending: true,
      textRegions: [{ x: -20, y: 80, width: 40, height: 18 }]
    }, 640, 360)).toEqual({
      markerNumber: 3,
      point: { x: -6, y: 48 },
      viewport: { width: 640, height: 360 },
      pending: true,
      textRegions: [{ x: -10, y: 40, width: 20, height: 9 }]
    });
  });
});
