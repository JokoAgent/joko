import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutHoldController } from "../src/shortcut-hold-controller.js";

describe("shortcut hold controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits start immediately and classifies release before 450 ms as a tap", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(true);
    expect(phases).toEqual(["start"]);

    vi.advanceTimersByTime(449);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "tap"]);
  });

  it("classifies release at or beyond the hold threshold as an end", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(true);
    vi.advanceTimersByTime(450);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "end"]);
  });

  it("supports an injected hold delay", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({
      holdDelayMs: 25,
      onTrigger: (phase) => phases.push(phase)
    });

    controller.setPressed(true);
    vi.advanceTimersByTime(25);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "end"]);
  });

  it("ignores repeated keydown messages while the target is held", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(true);
    controller.setPressed(true);
    vi.advanceTimersByTime(500);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "end"]);
  });

  it("ends a broken shortcut and fences it until the target key is released", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(true, true);
    controller.setPressed(false, true);
    controller.setPressed(true, true);
    controller.setPressed(false, false);
    controller.setPressed(true, true);
    controller.setPressed(false, false);

    expect(phases).toEqual(["start", "end", "start", "tap"]);
  });

  it("does not activate when the target arrives while another key is already down", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(false, true);
    controller.setPressed(true, true);
    controller.setPressed(false, false);

    expect(phases).toEqual([]);
  });

  it("releaseIfPressed ends once, clears its timer, and permits a new activation", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(true);
    controller.releaseIfPressed();
    controller.releaseIfPressed();
    vi.advanceTimersByTime(1_000);
    controller.setPressed(true);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "end", "start", "tap"]);
  });

  it("reset silently clears timers and cancellation fences", () => {
    const phases: string[] = [];
    const controller = new ShortcutHoldController({ onTrigger: (phase) => phases.push(phase) });

    controller.setPressed(true);
    controller.reset();
    vi.advanceTimersByTime(1_000);
    controller.setPressed(true);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "start", "tap"]);

    controller.setPressed(false, true);
    controller.reset();
    controller.setPressed(true);
    controller.setPressed(false);

    expect(phases).toEqual(["start", "start", "tap", "start", "tap"]);
  });
});
