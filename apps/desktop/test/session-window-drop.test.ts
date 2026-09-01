import { describe, expect, it } from "vitest";

import { pointIsInsideAnyRectangle, pointIsInsideRectangle, sessionWindowDropBounds } from "../src/session-window-drop.js";

describe("task window drop geometry", () => {
  const workArea = { x: -1920, y: 0, width: 1920, height: 1080 };

  it("uses half-open source-window bounds so an outside release is unambiguous", () => {
    const bounds = { x: 100, y: 200, width: 800, height: 600 };
    expect(pointIsInsideRectangle({ x: 100, y: 200 }, bounds)).toBe(true);
    expect(pointIsInsideRectangle({ x: 899, y: 799 }, bounds)).toBe(true);
    expect(pointIsInsideRectangle({ x: 900, y: 799 }, bounds)).toBe(false);
    expect(pointIsInsideRectangle({ x: 899, y: 800 }, bounds)).toBe(false);
  });

  it("treats every visible application window rectangle as an inside drop target", () => {
    const bounds = [
      { x: 100, y: 100, width: 800, height: 600 },
      { x: -1200, y: 200, width: 900, height: 700 }
    ];
    expect(pointIsInsideAnyRectangle({ x: 400, y: 300 }, bounds)).toBe(true);
    expect(pointIsInsideAnyRectangle({ x: -800, y: 500 }, bounds)).toBe(true);
    expect(pointIsInsideAnyRectangle({ x: 1_500, y: 500 }, bounds)).toBe(false);
  });

  it("places the detached title bar near the pointer and clamps it to the display", () => {
    expect(sessionWindowDropBounds({
      point: { x: -1200, y: 400 },
      workArea,
      windowSize: { width: 1000, height: 700 }
    })).toEqual({ x: -1280, y: 376, width: 1000, height: 700 });
    expect(sessionWindowDropBounds({
      point: { x: -1910, y: 10 },
      workArea,
      windowSize: { width: 1000, height: 700 }
    })).toEqual({ x: -1920, y: 0, width: 1000, height: 700 });
    expect(sessionWindowDropBounds({
      point: { x: -10, y: 1070 },
      workArea,
      windowSize: { width: 1000, height: 700 }
    })).toEqual({ x: -1000, y: 380, width: 1000, height: 700 });
  });

  it("shrinks a saved window that is larger than the drop display", () => {
    expect(sessionWindowDropBounds({
      point: { x: -1200, y: 400 },
      workArea: { x: -1440, y: 0, width: 1440, height: 900 },
      windowSize: { width: 1800, height: 1200 }
    })).toEqual({ x: -1440, y: 0, width: 1440, height: 900 });
  });

  it("fails closed on non-finite geometry", () => {
    expect(() => sessionWindowDropBounds({
      point: { x: Number.NaN, y: 0 },
      workArea,
      windowSize: { width: 1000, height: 700 }
    })).toThrow("Task drop point is invalid");
  });
});
