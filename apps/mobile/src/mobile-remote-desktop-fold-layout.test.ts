import { describe, expect, it } from "vitest";
import { mobileRemoteDesktopFoldLayout, mobileRemoteDesktopLocalGeometry } from "./mobile-remote-desktop-fold-layout";
import type { MobileWindowGeometry } from "./mobile-window-geometry";

function geometry(axis: "horizontal" | "vertical" = "horizontal"): MobileWindowGeometry {
  return { width: 800, height: 1000, insets: { top: 20, right: 10, bottom: 20, left: 10 },
    regularWidth: true, regularHeight: true, barEdge: "none", reservedRegionsSupported: true,
    regions: [axis === "horizontal" ? { kind: "division", x: 10, y: 480, width: 780, height: 40 }
      : { kind: "division", x: 380, y: 20, width: 40, height: 960 }] };
}

describe("Mobile divided Remote Desktop layout", () => {
  it("projects observed reservations into the measured child after safe area and header consumption", () => {
    const value = geometry(), local = mobileRemoteDesktopLocalGeometry(value, { x: 10, y: 82, width: 780, height: 898 })!;
    expect(local.insets).toEqual({ top: 0, left: 0, right: 0, bottom: 0 });
    expect(local.regions).toEqual([{ kind: "division", x: 0, y: 398, width: 780, height: 40 }]);
    expect(mobileRemoteDesktopFoldLayout(local, 0, 0, false)).toEqual({
      media: { x: 0, y: 0, width: 780, height: 398 }, controls: { x: 0, y: 438, width: 780, height: 460 }
    });
    expect(mobileRemoteDesktopLocalGeometry(value, { x: 0, y: 0, width: 900, height: 1000 })).toBeNull();
    expect(mobileRemoteDesktopLocalGeometry(value, { x: 0, y: Number.NaN, width: 800, height: 1000 })).toBeNull();
  });

  it("requires an actual spanning division with two usable 160-point panes", () => {
    expect(mobileRemoteDesktopFoldLayout({ ...geometry(), regions: [] }, 0, 0, false)).toBeNull();
    expect(mobileRemoteDesktopFoldLayout({ ...geometry(), regions: [{ kind: "division", x: 10, y: 179, width: 780, height: 40 }] }, 0, 0, false)).toBeNull();
    expect(mobileRemoteDesktopFoldLayout({ ...geometry(), regions: [{ kind: "division", x: 10, y: 180, width: 780, height: 40 }] }, 0, 0, false)).toMatchObject({
      media: { x: 10, y: 20, width: 780, height: 160 }
    });
    expect(mobileRemoteDesktopFoldLayout({ ...geometry("vertical"), regions: [{ kind: "division", x: 630, y: 20, width: 1, height: 960 }] }, 0, 0, false)).toBeNull();
  });

  it("shares the media rectangle and keeps controls in the second safe pane without mutating geometry", () => {
    const value = geometry(), before = structuredClone(value);
    expect(mobileRemoteDesktopFoldLayout(value, -20, 900, false)).toEqual({
      media: { x: 10, y: 20, width: 780, height: 460 }, controls: { x: 10, y: 520, width: 780, height: 460 }
    });
    expect(value).toEqual(before);
  });

  it("keeps the lower pane at 140 available points and moves a keyboard panel above the fold below that threshold", () => {
    const value = geometry();
    expect(mobileRemoteDesktopFoldLayout(value, 340, 300, true)).toEqual({
      media: { x: 10, y: 20, width: 780, height: 460 }, controls: { x: 10, y: 520, width: 780, height: 140 }
    });
    expect(mobileRemoteDesktopFoldLayout(value, 341, 300, true)).toEqual({
      media: { x: 10, y: 20, width: 780, height: 160 }, controls: { x: 10, y: 20, width: 780, height: 460 }
    });
    expect(mobileRemoteDesktopFoldLayout(value, 600, 500, true)).toEqual({
      media: { x: 10, y: 20, width: 780, height: 1 }, controls: { x: 10, y: 20, width: 780, height: 380 }
    });
    expect(mobileRemoteDesktopFoldLayout(value, 0, 300, false)?.media.height).toBe(460);
  });

  it("clips vertical media above a docked keyboard without reserving another column's custom panel", () => {
    const value = geometry("vertical");
    expect(mobileRemoteDesktopFoldLayout(value, 400, 350, true)).toEqual({
      media: { x: 10, y: 20, width: 370, height: 580 }, controls: { x: 420, y: 20, width: 370, height: 580 }
    });
    expect(mobileRemoteDesktopFoldLayout(value, 0, -100, true)).toEqual({
      media: { x: 10, y: 20, width: 370, height: 960 }, controls: { x: 420, y: 20, width: 370, height: 960 }
    });
  });

  it("uses one complete control rectangle outside the lower-pane camera reservation", () => {
    const value = geometry();
    expect(mobileRemoteDesktopFoldLayout({ ...value, regions: [...value.regions,
      { kind: "occlusion", x: 350, y: 520, width: 100, height: 120 }] }, 0, 0, false)).toEqual({
      media: { x: 10, y: 20, width: 780, height: 460 }, controls: { x: 10, y: 640, width: 780, height: 340 }
    });
  });
});
