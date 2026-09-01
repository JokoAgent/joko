import { describe, expect, it } from "vitest";
import {
  finalizeNavigationDrag,
  navigationLayoutForResizeKey,
  navigationVisualWidth
} from "./navigation-layout.js";

describe("navigation layout", () => {
  it("persists expanded, rail, and hidden geometry as distinct states", () => {
    expect(navigationVisualWidth({ mode: "expanded", width: 260 })).toBe(260);
    expect(navigationVisualWidth({ mode: "rail", width: 320 })).toBe(78);
    expect(navigationVisualWidth({ mode: "hidden", width: 320 })).toBe(0);
    expect(finalizeNavigationDrag(119, 312)).toEqual({ mode: "rail", width: 312 });
    expect(finalizeNavigationDrag(120, 312)).toEqual({ mode: "expanded", width: 180 });
    expect(finalizeNavigationDrag(900, 312)).toEqual({ mode: "expanded", width: 480 });
  });

  it("keeps the expanded width while keyboard controls cross the rail boundary", () => {
    expect(navigationLayoutForResizeKey({ mode: "expanded", width: 180 }, "ArrowLeft")).toEqual({ mode: "rail", width: 180 });
    expect(navigationLayoutForResizeKey({ mode: "rail", width: 312 }, "ArrowRight")).toEqual({ mode: "expanded", width: 312 });
    expect(navigationLayoutForResizeKey({ mode: "expanded", width: 312 }, "Home")).toEqual({ mode: "rail", width: 312 });
    expect(navigationLayoutForResizeKey({ mode: "rail", width: 312 }, "End")).toEqual({ mode: "expanded", width: 480 });
  });
});
