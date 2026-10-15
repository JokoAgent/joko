import { describe, expect, it } from "vitest";
import { sessionWindowInitialBounds } from "../src/session-window-geometry.js";

describe("Task window initial geometry", () => {
  const defaults = { width: 1280, height: 800 };
  it("copies the live initiating window size and offsets its position for every new instance", () => {
    const source = { x: -1200, y: 90, width: 960, height: 700 };
    const first = sessionWindowInitialBounds(source, defaults);
    expect(first).toEqual({ x: -1170, y: 120, width: 960, height: 700 });
    expect(sessionWindowInitialBounds({ x: -1170, y: 120, width: 960, height: 700 }, defaults))
      .toEqual({ x: -1140, y: 150, width: 960, height: 700 });
    expect(source).toEqual({ x: -1200, y: 90, width: 960, height: 700 });
  });
  it("uses only the default size without a live initiating window", () => {
    expect(sessionWindowInitialBounds(undefined, defaults)).toEqual({ width: 1280, height: 800 });
    expect(sessionWindowInitialBounds(undefined, defaults)).not.toBe(defaults);
  });
  it("rejects invalid native bounds instead of creating an unusable window", () => {
    expect(() => sessionWindowInitialBounds({ x: Number.NaN, y: 0, width: 960, height: 700 }, defaults)).toThrow(TypeError);
    expect(() => sessionWindowInitialBounds(undefined, { width: 0, height: 800 })).toThrow(TypeError);
  });
});
