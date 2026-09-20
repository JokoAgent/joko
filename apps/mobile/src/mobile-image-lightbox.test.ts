import { describe, expect, it } from "vitest";
import {
  MOBILE_LIGHTBOX_DOUBLE_TAP_SCALE,
  MOBILE_LIGHTBOX_MAX_SCALE,
  MOBILE_LIGHTBOX_MIN_SCALE,
  clampMobileImageTransform,
  clampMobileLightboxScale,
  mobileAccessibleZoomTransform,
  mobileContainedImageSize,
  mobileDoubleTapTransform,
  mobileLightboxPointerIntent,
  mobileLightboxIsTap,
  mobileLightboxIsZoomed,
  mobilePinchTransform,
  mobileTouchCentroid,
  mobileTouchDistance
} from "./mobile-image-lightbox";

describe("mobile image lightbox", () => {
  const container = { width: 400, height: 800 };
  const landscape = { width: 800, height: 400 };

  it("contains images, clamps scale, and only pans across actual overflow", () => {
    expect(mobileContainedImageSize(container, landscape)).toEqual({ width: 400, height: 200 });
    expect(clampMobileLightboxScale(0)).toBe(MOBILE_LIGHTBOX_MIN_SCALE);
    expect(clampMobileLightboxScale(99)).toBe(MOBILE_LIGHTBOX_MAX_SCALE);
    expect(clampMobileImageTransform({ scale: 2, translateX: 999, translateY: 99 }, container, landscape))
      .toEqual({ scale: 2, translateX: 200, translateY: 0 });
  });

  it("keeps the initial focal image point beneath a moving pinch centroid", () => {
    const result = mobilePinchTransform({
      initial: { scale: 1, translateX: 0, translateY: 0 },
      initialCentroid: { x: 300, y: 400 },
      initialDistance: 100,
      centroid: { x: 280, y: 440 },
      distance: 250,
      container,
      natural: { width: 400, height: 800 }
    });
    expect(result.scale).toBe(2.5);
    expect(result.translateX).toBe(-170);
    expect(result.translateY).toBe(40);
  });

  it("uses a bounded double tap focal zoom and resets the full transform", () => {
    const zoomed = mobileDoubleTapTransform(
      { scale: 1, translateX: 0, translateY: 0 },
      { x: 300, y: 500 },
      container,
      { width: 400, height: 800 }
    );
    expect(zoomed).toEqual({ scale: MOBILE_LIGHTBOX_DOUBLE_TAP_SCALE, translateX: -150, translateY: -150 });
    expect(mobileDoubleTapTransform(zoomed, { x: 10, y: 10 }, container, landscape))
      .toEqual({ scale: 1, translateX: 0, translateY: 0 });
  });

  it("provides accessible zoom controls with the same pan clamps", () => {
    const zoomed = mobileAccessibleZoomTransform(
      { scale: 1, translateX: 0, translateY: 0 }, 1, container, landscape
    );
    expect(zoomed).toEqual({ scale: 2, translateX: 0, translateY: 0 });
    expect(mobileAccessibleZoomTransform(zoomed, -4, container, landscape))
      .toEqual({ scale: 1, translateX: 0, translateY: 0 });
    expect(mobileLightboxIsZoomed(1.005)).toBe(false);
    expect(mobileLightboxIsZoomed(1.02)).toBe(true);
  });

  it("normalizes multi-touch geometry without trusting invalid coordinates", () => {
    expect(mobileTouchCentroid([{ x: 0, y: 20 }, { x: 20, y: 40 }])).toEqual({ x: 10, y: 30 });
    expect(mobileTouchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(mobileTouchCentroid([{ x: Number.NaN, y: 2 }])).toEqual({ x: 0, y: 2 });
  });

  it("assigns one annotation pointer to drawing and two pointers only to transforms", () => {
    expect(mobileLightboxPointerIntent(true, 1)).toBe("draw");
    expect(mobileLightboxPointerIntent(true, 2)).toBe("transform");
    expect(mobileLightboxPointerIntent(false, 1)).toBe("pan");
    expect(mobileLightboxPointerIntent(false, 3)).toBe("transform");
    expect(mobileLightboxPointerIntent(true, 0)).toBe("idle");
  });

  it("does not promote long presses or drags into double-tap candidates", () => {
    expect(mobileLightboxIsTap(1_000, 1_200, 3)).toBe(true);
    expect(mobileLightboxIsTap(1_000, 1_501, 3)).toBe(false);
    expect(mobileLightboxIsTap(1_000, 1_200, 13)).toBe(false);
    expect(mobileLightboxIsTap(1_000, 999, 0)).toBe(false);
  });
});
