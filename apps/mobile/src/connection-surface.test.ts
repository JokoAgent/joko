import { describe, expect, it } from "vitest";
import {
  CONNECTION_PAD_LANDSCAPE_MIN_HEIGHT,
  CONNECTION_PAD_LANDSCAPE_MIN_SCALE,
  CONNECTION_PAD_LANDSCAPE_MIN_WIDTH,
  CONNECTION_PAD_LANDSCAPE_STAGE,
  CONNECTION_PAD_PORTRAIT_MIN_WIDTH,
  CONNECTION_PAD_PORTRAIT_STAGE,
  CONNECTION_PHONE_LONG,
  CONNECTION_PHONE_SHORT,
  connectionStageBoxInViewport,
  resolveConnectionSurface,
  resolveConnectionSurfaceMode,
  type ConnectionStageBox
} from "./connection-surface";

function expectBox(actual: ConnectionStageBox, expected: ConnectionStageBox): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.width).toBeCloseTo(expected.width, 6);
  expect(actual.height).toBeCloseTo(expected.height, 6);
}

describe("mobile connection stage", () => {
  it("uses the fixed three-mode breakpoints and keeps narrow landscape windows in phone mode", () => {
    expect(resolveConnectionSurfaceMode(393, 852)).toBe("phone");
    expect(resolveConnectionSurfaceMode(852, 393)).toBe("phone");
    expect(resolveConnectionSurfaceMode(1100, 600)).toBe("phone");
    expect(resolveConnectionSurfaceMode(320, 768)).toBe("phone");
    expect(resolveConnectionSurfaceMode(CONNECTION_PAD_PORTRAIT_MIN_WIDTH, 1000)).toBe("pad-portrait");
    expect(resolveConnectionSurfaceMode(CONNECTION_PAD_PORTRAIT_MIN_WIDTH - 1, 1000)).toBe("phone");
    expect(resolveConnectionSurfaceMode(
      CONNECTION_PAD_LANDSCAPE_MIN_WIDTH,
      CONNECTION_PAD_LANDSCAPE_MIN_HEIGHT
    )).toBe("pad-landscape");
    expect(resolveConnectionSurfaceMode(
      CONNECTION_PAD_LANDSCAPE_MIN_WIDTH - 1,
      CONNECTION_PAD_LANDSCAPE_MIN_HEIGHT
    )).toBe("phone");
  });

  it("uses the fixed 750-unit phone stage and interpolates the complete brand cluster", () => {
    const short = resolveConnectionSurface(375, 667);
    expect(short.mode).toBe("phone");
    expect(short.scale).toBe(0.5);
    expect(short.stageHeight).toBe(1334);
    expectBox(short.hero, CONNECTION_PHONE_SHORT.hero);
    expectBox(short.lockup, CONNECTION_PHONE_SHORT.lockup);
    expect(short.form.y).toBe(CONNECTION_PHONE_SHORT.formY);

    const long = resolveConnectionSurface(375, 812);
    expect(long.stageHeight).toBe(1624);
    expectBox(long.hero, CONNECTION_PHONE_LONG.hero);
    expectBox(long.lockup, CONNECTION_PHONE_LONG.lockup);
    expect(long.form.y).toBe(CONNECTION_PHONE_LONG.formY);

    const midpoint = resolveConnectionSurface(375, 739.5);
    expectBox(midpoint.hero, { x: 37.5, y: 83, width: 674.5, height: 811 });
    expectBox(midpoint.lockup, { x: 195, y: 578.085, width: 361, height: 123.59 });
    expect(midpoint.form.y).toBeCloseTo(724.5, 6);
  });

  it("compresses only the brand cluster when a phone-mode viewport must prioritize the form", () => {
    const compact = resolveConnectionSurface(375, 500);
    expect(compact.stageHeight).toBe(1000);
    expect(compact.form).toMatchObject({ x: 35, y: 360, width: 680, height: 640 });
    expectBox(compact.hero, {
      x: 211.51226158038146,
      y: 32.697547683923706,
      width: 326.43051771117164,
      height: 392.3705722070845
    });

    const landscapePhone = resolveConnectionSurface(852, 393);
    expect(landscapePhone.mode).toBe("phone");
    expect(landscapePhone.stageHeight).toBe(600);
    expect(landscapePhone.form.y).toBe(0);
    expect(landscapePhone.hero.width).toBeCloseTo(CONNECTION_PHONE_SHORT.hero.width * 0.25, 6);
  });

  it("uses the fixed centered portrait-pad canvas and scale", () => {
    const base = resolveConnectionSurface(744, 1133);
    expect(base.mode).toBe("pad-portrait");
    expect(base.scale).toBe(1);
    expect(base.offsetX).toBe(0);
    expect(base.offsetY).toBe(0);
    expectBox(base.hero, CONNECTION_PAD_PORTRAIT_STAGE.hero);
    expectBox(base.lockup, CONNECTION_PAD_PORTRAIT_STAGE.lockup);
    expect(base.form).toMatchObject({
      x: CONNECTION_PAD_PORTRAIT_STAGE.formX,
      y: CONNECTION_PAD_PORTRAIT_STAGE.formY,
      width: CONNECTION_PAD_PORTRAIT_STAGE.formWidth
    });

    const shorter = resolveConnectionSurface(744, 1000);
    expect(shorter.scale).toBeCloseTo(1000 / 1133, 10);
    expect(shorter.offsetY).toBeCloseTo((1000 - 1133 * shorter.scale) / 2, 6);
  });

  it("uses the fixed landscape-pad canvas with its minimum scale and no maximum cap", () => {
    const base = resolveConnectionSurface(1180, 820);
    expect(base.mode).toBe("pad-landscape");
    expect(base.horizontal).toBe(true);
    expect(base.scale).toBe(1);
    expectBox(base.hero, CONNECTION_PAD_LANDSCAPE_STAGE.hero);
    expectBox(base.lockup, CONNECTION_PAD_LANDSCAPE_STAGE.lockup);
    expect(base.form).toMatchObject({
      x: CONNECTION_PAD_LANDSCAPE_STAGE.formX,
      y: CONNECTION_PAD_LANDSCAPE_STAGE.formY,
      width: CONNECTION_PAD_LANDSCAPE_STAGE.formWidth
    });

    expect(resolveConnectionSurface(1100, 690).scale).toBe(CONNECTION_PAD_LANDSCAPE_MIN_SCALE);
    expect(resolveConnectionSurface(1770, 1230).scale).toBeCloseTo(1.5, 10);
  });

  it("projects stage boxes into the physical viewport without changing their aspect", () => {
    const surface = resolveConnectionSurface(375, 667);
    expectBox(connectionStageBoxInViewport(surface, surface.lockup), {
      x: 104,
      y: 243.5,
      width: 167.5,
      height: 57.5
    });
    const landscape = resolveConnectionSurface(1180, 820);
    expectBox(connectionStageBoxInViewport(landscape, landscape.form), landscape.form);
  });

  it("rejects invalid viewport dimensions instead of producing unusable native styles", () => {
    expect(() => resolveConnectionSurface(0, 800)).toThrow(/positive and finite/iu);
    expect(() => resolveConnectionSurface(390, Number.NaN)).toThrow(/positive and finite/iu);
    expect(() => resolveConnectionSurfaceMode(Number.POSITIVE_INFINITY, 800)).toThrow(/positive and finite/iu);
  });
});
