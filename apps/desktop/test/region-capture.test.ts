import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { regionCaptureCrop, validRegionPngHeader } from "../src/region-capture.js";

it("maps an exact dragged region using the captured display pixels and rejects out-of-bounds values", () => {
  const image = { width: 5095, height: 2871 };
  expect(regionCaptureCrop({ left: .25, top: .5, right: .75, bottom: 1 }, image))
    .toEqual({ x: 1273, y: 1435, width: 2549, height: 1436 });
  expect(regionCaptureCrop({ left: 0, top: 0, right: 1, bottom: 1 }, { width: 1920, height: 1080 }))
    .toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  expect(regionCaptureCrop({ left: -.01, top: 0, right: 1, bottom: 1 }, image)).toBeUndefined();
  expect(regionCaptureCrop({ left: .5, top: 0, right: .5, bottom: 1 }, image)).toBeUndefined();
  expect(regionCaptureCrop({ left: 0, top: 0, right: 1, bottom: 1, display: 5 }, image)).toBeUndefined();
});

it("checks the PNG dimensions before decoding renderer bytes for clipboard, save or attachment", () => {
  const header = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(header);
  header.writeUInt32BE(640, 16);
  header.writeUInt32BE(320, 20);
  expect(validRegionPngHeader(header, { width: 640, height: 320 })).toBe(true);
  expect(validRegionPngHeader(header, { width: 1280, height: 640 })).toBe(false);
  expect(validRegionPngHeader(header.subarray(0, 26), { width: 640, height: 320 })).toBe(false);
  header.writeUInt32BE(9000, 16);
  header.writeUInt32BE(8000, 20);
  expect(validRegionPngHeader(header, { width: 9000, height: 8000 })).toBe(false);
});
