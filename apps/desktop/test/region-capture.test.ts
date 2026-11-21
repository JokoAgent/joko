import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { regionCaptureControlBounds, regionCaptureCrop, validRegionPngHeader, validRegionRecording } from "../src/region-capture.js";

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

it("places recording controls outside the selected area or on another monitor", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1080 };
  const other = { x: -1220, y: -420, width: 1220, height: 720 };
  expect(regionCaptureControlBounds(primary, [primary])).toBeUndefined();
  expect(regionCaptureControlBounds(primary, [primary, other])).toEqual({ x: -840, y: -410, width: 460, height: 71 });
  expect(regionCaptureControlBounds({ ...primary, height: 860 }, [primary])).toMatchObject({ y: 999 });
});

it("checks the selected recording type and GIF dimensions before writing it to the system", () => {
  const gif = Buffer.alloc(25);
  gif.write("GIF89a"); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(180, 8); gif[gif.length - 1] = 0x3b;
  expect(validRegionRecording(gif, "gif", { width: 320, height: 180 })).toBe(true);
  expect(validRegionRecording(gif, "gif", { width: 320, height: 160 })).toBe(false);
  expect(validRegionRecording(gif, "video", { width: 320, height: 180 })).toBe(false);
  const webm = Buffer.from("1a45dfa39f4286810142f781014282847765626d", "hex");
  expect(validRegionRecording(webm, "video", { width: 320, height: 180 })).toBe(true);
  expect(validRegionRecording(webm, "gif", { width: 320, height: 180 })).toBe(false);
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
