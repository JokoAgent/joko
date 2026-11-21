import { expect, it } from "vitest";
import { regionScrollOffset } from "./region-capture-scroll.js";

const width = 160, height = 90;

function frame(origin: number, seed = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const index = (row * width + column) * 4, y = row + origin;
      data[index] = (y * (y + 47) + column * 33 + seed) % 251;
      data[index + 1] = (y * 19 + column * 13) % 253;
      data[index + 2] = (y * y * 17 + column * 3) % 255;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

it("joins only new rows in either scroll direction and ignores unchanged frames", () => {
  const original = frame(15), lower = frame(39), higher = frame(6);
  expect(regionScrollOffset(original, original)).toBe(0);
  expect(regionScrollOffset(original, lower)).toBe(24);
  expect(regionScrollOffset(original, higher)).toBe(-9);
  expect(regionScrollOffset(lower, original)).toBe(-24);
});

it("rejects unconnected or insufficiently overlapping content", () => {
  expect(regionScrollOffset(frame(0), frame(77))).toBeUndefined();
  expect(regionScrollOffset(frame(0), frame(13, 90))).toBeUndefined();
  expect(regionScrollOffset(frame(0), { ...frame(23), width: 181 })).toBeUndefined();
});
