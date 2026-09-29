import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContinuousScrollController,
  DEDICATED_HARDWARE_MAX_SCROLL_SPEED,
  DEDICATED_HARDWARE_MIN_SCROLL_SPEED,
  DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS,
  dedicatedHardwareScrollDelta,
  dedicatedHardwareScrollSpeed
} from "./continuous-scroll.js";

describe("dedicated hardware continuous scroll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 0.5 dead zone and a 90-2600 px/s squared curve", () => {
    expect(dedicatedHardwareScrollSpeed(0)).toBe(0);
    expect(dedicatedHardwareScrollSpeed(0.5)).toBe(0);
    expect(dedicatedHardwareScrollSpeed(0.500_001)).toBeGreaterThanOrEqual(DEDICATED_HARDWARE_MIN_SCROLL_SPEED);
    expect(dedicatedHardwareScrollSpeed(0.75)).toBeCloseTo(717.5);
    expect(dedicatedHardwareScrollSpeed(1)).toBe(DEDICATED_HARDWARE_MAX_SCROLL_SPEED);
    expect(dedicatedHardwareScrollSpeed(Number.NaN)).toBe(0);
  });

  it("caps every elapsed sample at 100 ms", () => {
    expect(dedicatedHardwareScrollDelta(1, 16)).toBeCloseTo(41.6);
    expect(dedicatedHardwareScrollDelta(1, 100)).toBe(260);
    expect(dedicatedHardwareScrollDelta(1, 1_000)).toBe(260);
    expect(dedicatedHardwareScrollDelta(1, -1)).toBe(0);
  });

  it("emits signed, elapsed-time deltas and stops on release", () => {
    let now = 1_000;
    const deltas: number[] = [];
    const stops: string[] = [];
    const controller = new ContinuousScrollController({
      now: () => now,
      onDelta: (delta) => deltas.push(delta),
      onStop: (reason) => stops.push(reason)
    });

    expect(controller.update("down", 1)).toBe(true);
    now += 16;
    controller.tick();
    expect(deltas).toEqual([41.6]);
    expect(controller.update("up", 1)).toBe(true);
    now += 250;
    controller.tick();
    expect(deltas[1]).toBe(-260);
    expect(controller.stop()).toBe(true);
    expect(controller.stop()).toBe(false);
    expect(stops).toEqual(["release"]);
  });

  it("refreshes and enforces the 10 second silence watchdog", async () => {
    const stops: string[] = [];
    const controller = new ContinuousScrollController({
      onDelta: () => undefined,
      onStop: (reason) => stops.push(reason)
    });
    controller.update("down", 0.8);
    await vi.advanceTimersByTimeAsync(DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS - 1);
    expect(controller.active()).toBe(true);
    controller.update("down", 0.8);
    await vi.advanceTimersByTimeAsync(DEDICATED_HARDWARE_SCROLL_WATCHDOG_MS - 1);
    expect(controller.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.active()).toBe(false);
    expect(stops).toEqual(["watchdog"]);
  });

  it("fails closed on dead-zone, malformed input, or output failure", () => {
    const stops: string[] = [];
    const controller = new ContinuousScrollController({
      onDelta: () => { throw new Error("adapter unavailable"); },
      onStop: (reason) => stops.push(reason)
    });
    expect(controller.update("down", 0.8)).toBe(true);
    vi.advanceTimersByTime(16);
    expect(controller.active()).toBe(false);
    expect(stops).toEqual(["output-failed"]);

    const secondStops: string[] = [];
    const second = new ContinuousScrollController({
      onDelta: () => undefined,
      onStop: (reason) => secondStops.push(reason)
    });
    second.update("up", 0.8);
    expect(second.update("up", 0.5)).toBe(false);
    expect(secondStops).toEqual(["dead-zone"]);
    second.update("up", 0.8);
    expect(second.update("up", Number.NaN)).toBe(false);
    expect(secondStops).toEqual(["dead-zone", "invalid-input"]);
  });
});
