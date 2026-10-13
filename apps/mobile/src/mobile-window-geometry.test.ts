import { describe, expect, it } from "vitest";
import { avoidReservedRegions, controlRegion, keyboardControlRegion, parseMobileWindowGeometry,
  safeWindowRect, windowDivision, type MobileWindowGeometry } from "./mobile-window-geometry";

const base: MobileWindowGeometry = { width: 800, height: 1000, insets: { top: 20, right: 10, bottom: 20, left: 10 },
  regularWidth: true, regularHeight: true, barEdge: "none", reservedRegionsSupported: true,
  regions: [{ kind: "division", x: 10, y: 490, width: 780, height: 20 }] };

describe("current window geometry boundary", () => {
  it("copies only the current complete finite payload without retaining mutable bridge objects", () => {
    const raw = { ...base, insets: { ...base.insets }, regions: base.regions.map(region => ({ ...region })) };
    const geometry = parseMobileWindowGeometry(raw)!;
    expect(geometry).toEqual(base); expect(Object.isFrozen(geometry)).toBe(true);
    raw.insets.top = 100; raw.regions[0]!.y = 100;
    expect(geometry.insets.top).toBe(20); expect(geometry.regions[0]!.y).toBe(490);
    expect(parseMobileWindowGeometry({ ...base, regions: [], reservedRegionsSupported: false })).toBeDefined();
  });
  it.each([
    null, [], { ...base, width: 0 }, { ...base, height: Infinity }, { ...base, width: "800" },
    { ...base, regularWidth: 1 }, { ...base, barEdge: "leading" }, { ...base, reservedRegionsSupported: "true" },
    { ...base, extra: true }, { ...base, insets: { ...base.insets, bottom: NaN } },
    { ...base, insets: { top: 0, right: 0, bottom: 0 } }, { ...base, insets: { ...base.insets, left: -1 } },
    { ...base, regions: [{ kind: "division", x: 0, y: 500, width: 800, height: 0 }] },
    { ...base, regions: [{ kind: "hinge", x: 0, y: 500, width: 800, height: 20 }] },
    { ...base, regions: [{ kind: "occlusion", x: 799, y: 0, width: 2, height: 30 }] },
    { ...base, regions: [{ kind: "division", x: 0, y: 990, width: 800, height: 20 }] },
    { ...base, regions: [{ kind: "occlusion", x: 0, y: 0, width: 20, height: 30, window: "other" }] },
    { ...base, reservedRegionsSupported: false }, { ...base, reservedRegionsSupported: false, regions: [], barEdge: "left" }
  ])("rejects malformed or unsupported reserved geometry %#", value => {
    expect(parseMobileWindowGeometry(value)).toBeUndefined();
  });
});

describe("safe window control layout", () => {
  it("uses safe insets and splits horizontal or vertical hardware divisions", () => {
    expect(safeWindowRect(base)).toEqual({ x: 10, y: 20, width: 780, height: 960 });
    expect(windowDivision(base)).toEqual({ axis: "horizontal", first: { x: 10, y: 20, width: 780, height: 470 },
      second: { x: 10, y: 510, width: 780, height: 470 } });
    expect(windowDivision({ ...base, regions: [{ kind: "division", x: 390, y: 20, width: 20, height: 960 }] }))
      .toEqual({ axis: "vertical", first: { x: 10, y: 20, width: 380, height: 960 }, second: { x: 410, y: 20, width: 380, height: 960 } });
  });
  it.each([
    { kind: "division" as const, x: 10, y: 490, width: 623, height: 20 },
    { kind: "division" as const, x: 10, y: 20, width: 780, height: 20 },
    { kind: "division" as const, x: 10, y: 980, width: 780, height: 20 },
    { kind: "division" as const, x: 390, y: 20, width: 0, height: 960 },
    { kind: "occlusion" as const, x: 10, y: 490, width: 780, height: 20 }
  ])("keeps nonspanning, outside-safe or nondivision regions from splitting the window %#", region => {
    expect(windowDivision({ ...base, regions: [region] })).toBeNull();
  });
  it("keeps a complete control group in the largest unobscured part of the trailing pane", () => {
    expect(controlRegion({ ...base, regions: [...base.regions,
      { kind: "occlusion", x: 10, y: 510, width: 780, height: 40 }] }))
      .toEqual({ x: 10, y: 550, width: 780, height: 430 });
    expect(avoidReservedRegions({ x: 0, y: 0, width: 800, height: 1000 }, [{ x: 350, y: 0, width: 100, height: 1000 }]))
      .toEqual({ x: 0, y: 0, width: 350, height: 1000 });
  });
  it("moves controls above a covering keyboard and restores the original lower pane after dismissal", () => {
    expect(keyboardControlRegion(base, 100)).toEqual({ x: 10, y: 510, width: 780, height: 390 });
    expect(keyboardControlRegion(base, 400)).toEqual({ x: 10, y: 20, width: 780, height: 470 });
    expect(keyboardControlRegion(base, 0)).toEqual(controlRegion(base));
    const vertical = { ...base, regions: [{ kind: "division" as const, x: 390, y: 20, width: 20, height: 960 }] };
    expect(keyboardControlRegion(vertical, 400)).toEqual({ x: 410, y: 20, width: 380, height: 580 });
  });
});
