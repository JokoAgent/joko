import { expect, it } from "vitest";
import { compareSimulatorRgbaImages } from "./visual-diff.js";

it("returns thresholded RGBA pixel metrics without publishing image data", () => {
  const before = { width: 2, height: 1,
    data: new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255]) };
  const after = { width: 2, height: 1,
    data: new Uint8Array([5, 5, 5, 255, 40, 10, 10, 255]) };
  expect(compareSimulatorRgbaImages(before, after, 8)).toEqual({
    width: 2, height: 1, comparedPixels: 2, differentPixels: 1,
    differenceRatio: 0.5, meanAbsoluteError: 5.625, maxAbsoluteError: 30, threshold: 8
  });
  expect(compareSimulatorRgbaImages(before, after, 30).differentPixels).toBe(0);
});

it("rejects mismatched dimensions, malformed data and out-of-range thresholds", () => {
  const pixel = { width: 1, height: 1, data: new Uint8Array(4) };
  expect(() => compareSimulatorRgbaImages(pixel,
    { width: 2, height: 1, data: new Uint8Array(8) })).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(() => compareSimulatorRgbaImages(pixel,
    { width: 1, height: 1, data: new Uint8Array(3) })).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  expect(() => compareSimulatorRgbaImages(pixel, pixel, 256)).toThrowError(
    expect.objectContaining({ code: "INVALID_ARGUMENT" }));
});
