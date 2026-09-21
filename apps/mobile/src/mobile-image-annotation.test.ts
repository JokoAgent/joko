import { describe, expect, it } from "vitest";
import {
  MOBILE_ANNOTATION_MAX_BURN_DIMENSION,
  buildMobileAnnotationBurnHtml,
  buildMobileAnnotationBurnInvocation,
  canAnnotateMobileImage,
  decodeMobileBase64,
  encodeMobileBase64,
  mobileAnnotationDisplayRect,
  mobileAnnotationStrokePath,
  normalizeMobileAnnotationPoint,
  normalizeMobileAnnotationStrokes,
  parseMobileAnnotationBurnMessage,
  shouldAppendMobileAnnotationPoint,
  sniffMobileImageMediaType
} from "./mobile-image-annotation";

describe("mobile image annotation", () => {
  it("maps contain + transform coordinates into bounded image points", () => {
    const rect = mobileAnnotationDisplayRect({
      containerWidth: 400, containerHeight: 800, naturalWidth: 800, naturalHeight: 400,
      translateX: 20, translateY: -10, scale: 2
    });
    expect(rect).toEqual({ left: -180, top: 190, width: 800, height: 400 });
    expect(normalizeMobileAnnotationPoint({ x: 220, y: 390 }, rect!)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeMobileAnnotationPoint({ x: -999, y: 999 }, rect!)).toEqual({ x: 0, y: 1 });
  });

  it("bounds persisted strokes and decimates move points", () => {
    const stroke = { points: [{ x: 0.5, y: 0.5 }] };
    expect(shouldAppendMobileAnnotationPoint(stroke, { x: 0.5001, y: 0.5001 })).toBe(false);
    expect(shouldAppendMobileAnnotationPoint(stroke, { x: 0.51, y: 0.5 })).toBe(true);
    expect(normalizeMobileAnnotationStrokes([stroke])).toEqual([stroke]);
    expect(() => normalizeMobileAnnotationStrokes([{ points: [{ x: 2, y: 0 }] }])).toThrow(/invalid point/u);
  });

  it("renders single and multi-point strokes into stable SVG paths", () => {
    expect(mobileAnnotationStrokePath({ points: [{ x: 0.5, y: 0.5 }] }, 100, 100))
      .toBe("M 50.0 50.0 L 50.1 50.0");
    expect(mobileAnnotationStrokePath({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, 200, 100))
      .toBe("M 0.0 0.0 L 200.0 100.0");
  });

  it("excludes animated/vector/non-image sources from the drawing surface", () => {
    expect(canAnnotateMobileImage("image/jpeg")).toBe(true);
    expect(canAnnotateMobileImage("image/heic")).toBe(true);
    expect(canAnnotateMobileImage("image/gif")).toBe(false);
    expect(canAnnotateMobileImage("image/svg+xml")).toBe(false);
    expect(canAnnotateMobileImage("video/mp4")).toBe(false);
  });

  it("uses a bounded isolated burn protocol", () => {
    const html = buildMobileAnnotationBurnHtml();
    expect(html).toContain("window.__jokoBurnIn");
    expect(html).toContain(String(MOBILE_ANNOTATION_MAX_BURN_DIMENSION));
    expect(html).toContain("default-src 'none'; img-src data:; script-src 'unsafe-inline'");
    expect(html).toContain("ready: true");
    const invocation = buildMobileAnnotationBurnInvocation({
      id: "burn-1", base64: "QUJD", mediaType: "image/png",
      strokes: [{ points: [{ x: 0.1, y: 0.2 }] }]
    });
    expect(invocation).toContain('"id":"burn-1"');
    expect(invocation.endsWith("true;")).toBe(true);
    expect(parseMobileAnnotationBurnMessage(JSON.stringify({ ready: true }))).toEqual({ ready: true });
    expect(parseMobileAnnotationBurnMessage(JSON.stringify({
      id: "burn-2", ok: true, base64: "eA==", mediaType: "image/png", width: 20, height: 10
    }))).toEqual({ id: "burn-2", ok: true, base64: "eA==", mediaType: "image/png", width: 20, height: 10 });
    expect(parseMobileAnnotationBurnMessage(JSON.stringify({
      id: "burn-3", ok: true, base64: "eA==", mediaType: "image/png", width: 5000, height: 10
    }))).toBeUndefined();
  });

  it("round-trips base64 within a byte budget and verifies raster signatures", () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(decodeMobileBase64(encodeMobileBase64(png), png.length)).toEqual(png);
    expect(() => decodeMobileBase64(encodeMobileBase64(png), png.length - 1)).toThrow(/exceeds/u);
    expect(sniffMobileImageMediaType(png)).toBe("image/png");
    expect(sniffMobileImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 1]))).toBe("image/jpeg");
    expect(sniffMobileImageMediaType(Uint8Array.from([1, 2, 3]))).toBeUndefined();
  });
});
