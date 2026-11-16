import { describe, expect, it, vi } from "vitest";

import {
  clampWorkspaceImageScale,
  createWorkspaceImageWheelSourceTracker,
  drawWorkspaceImageStrokes,
  normalizeWorkspaceImagePoint,
  shouldAppendWorkspaceImagePoint,
  workspaceImageStrokePath,
  workspaceImageStrokeWidth,
  workspaceImageWheelZoomFactor,
  workspaceImageWheelIntent,
  zoomWorkspaceImageAtPoint
} from "./workspace-image-annotations.js";

describe("workspace image annotations", () => {
  it("normalizes and clamps points against the transformed image rectangle", () => {
    expect(normalizeWorkspaceImagePoint(25, 75, { left: 5, top: 25, width: 40, height: 100 })).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeWorkspaceImagePoint(-20, 200, { left: 5, top: 25, width: 40, height: 100 })).toEqual({ x: 0, y: 1 });
    expect(normalizeWorkspaceImagePoint(0, 0, { left: 0, top: 0, width: 0, height: 1 })).toBeUndefined();
  });

  it("filters dense move points and preserves a visible tap", () => {
    const stroke = { points: [{ x: 0.1, y: 0.1 }] };
    expect(shouldAppendWorkspaceImagePoint(stroke, { x: 0.101, y: 0.1 })).toBe(false);
    expect(shouldAppendWorkspaceImagePoint(stroke, { x: 0.103, y: 0.1 })).toBe(true);
    expect(workspaceImageStrokePath(stroke, 100, 50)).toBe("M 10.0 5.0 L 10.1 5.0");
  });

  it("uses bounded relative stroke width and two-pass burn-in", () => {
    expect(workspaceImageStrokeWidth(100, 100)).toBe(4);
    expect(workspaceImageStrokeWidth(2_000, 1_000)).toBe(5);
    expect(workspaceImageStrokeWidth(10_000, 10_000)).toBe(24);
    const context: Pick<CanvasRenderingContext2D,
      "lineCap" | "lineJoin" | "strokeStyle" | "lineWidth" | "beginPath" | "moveTo" | "lineTo" | "stroke"
    > = {
      lineCap: "butt",
      lineJoin: "miter",
      strokeStyle: "",
      lineWidth: 0,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn()
    };
    drawWorkspaceImageStrokes(context, [{ points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 1 }] }], 200, 100);
    expect(context.stroke).toHaveBeenCalledTimes(2);
    expect(context.moveTo).toHaveBeenNthCalledWith(1, 50, 50);
    expect(context.lineTo).toHaveBeenNthCalledWith(1, 150, 100);
  });

  it("enforces a 1x to 8x zoom fence and focal-point transform", () => {
    expect(clampWorkspaceImageScale(0.2)).toBe(1);
    expect(clampWorkspaceImageScale(20)).toBe(8);
    expect(zoomWorkspaceImageAtPoint({ scale: 1, x: 0, y: 0 }, { x: 30, y: -20 }, 2)).toEqual({ scale: 2, x: -30, y: 20 });
    expect(zoomWorkspaceImageAtPoint({ scale: 2, x: 12, y: 8 }, { x: 30, y: 20 }, 1)).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("normalizes wheel units before applying the continuous zoom curve", () => {
    expect(workspaceImageWheelZoomFactor(-40, 0)).toBeCloseTo(Math.exp(0.4));
    expect(workspaceImageWheelZoomFactor(-3, 1)).toBeCloseTo(Math.exp(0.4));
    expect(workspaceImageWheelZoomFactor(1, 2)).toBeCloseTo(Math.exp(-0.4));
  });

  it("keeps trackpad momentum panning, separates a later mouse stream and lets pinch zoom", () => {
    const track = createWorkspaceImageWheelSourceTracker();
    const sample = { deltaMode: 0, deltaX: 20, deltaY: 0, shiftKey: false };
    expect(track(sample, 1)).toBe("trackpad");
    const tail = { ...sample, deltaX: 0, deltaY: 12 };
    expect(track(tail, 20)).toBe("trackpad");
    expect(workspaceImageWheelIntent({ ...tail, ctrlKey: false, metaKey: false }, track(tail, 30), 2)).toBe("pan");
    expect(workspaceImageWheelIntent({ ...sample, ctrlKey: false, metaKey: false }, "trackpad", 1)).toBe("none");
    expect(workspaceImageWheelIntent({ ...tail, ctrlKey: true, metaKey: false }, "trackpad", 2)).toBe("zoom");
    expect(track(tail, 500)).toBe("mouse");
    expect(workspaceImageWheelIntent({ ...tail, ctrlKey: false, metaKey: false }, track(tail, 510), 2)).toBe("zoom");
    const fresh = createWorkspaceImageWheelSourceTracker();
    expect(fresh({ ...tail, deltaMode: 1 }, 1)).toBe("mouse");
    expect(fresh(sample, 2)).toBe("trackpad");
    expect(createWorkspaceImageWheelSourceTracker()({ ...tail, wheelDeltaY: -36 }, 1)).toBe("trackpad");
    expect(createWorkspaceImageWheelSourceTracker()({ ...tail, deltaY: 40, wheelDeltaY: -120 }, 1)).toBe("mouse");
    expect(createWorkspaceImageWheelSourceTracker()({ ...sample, shiftKey: true }, 1)).toBe("mouse");
  });
});
