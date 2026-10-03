import { describe, expect, it } from "vitest";

import {
  DEDICATED_HARDWARE_WINDOW_REVEAL_MS,
  DedicatedHardwareLightingEffect,
  applyDedicatedHardwareLightingBrightness,
  computeDedicatedHardwareLightingFrame,
  createDedicatedHardwareLightingFrame,
  createDedicatedHardwareOffFrame,
  createDedicatedHardwareWindowRevealFrame,
  dedicatedHardwareAutoDimMs,
  isDedicatedHardwareLightingFrameOff,
  type DedicatedHardwareLightingActivity
} from "./lighting-frame.js";
import {
  DEDICATED_HARDWARE_PHYSICAL_KEYS,
  createDefaultDedicatedHardwareSettings,
  type DedicatedHardwareModelId,
  type DedicatedHardwareSettings
} from "./settings.js";

const SLOTS: readonly (DedicatedHardwareLightingActivity | null)[] = [
  { phase: "running", attention: false },
  { phase: "completed", attention: false },
  { phase: "error", attention: true },
  { phase: "needs-interaction", attention: false },
  { phase: "completed", attention: true },
  null
];

describe("dedicated hardware lighting", () => {
  it("keeps LEDs on the selected task slots, acknowledges terminal activity, and prioritizes waiting", () => {
    const frame = createDedicatedHardwareLightingFrame(SLOTS);
    expect(frame.threads.map((thread) => thread.id)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(frame.threads.map((thread) => thread.color)).toEqual([0x4c6fff, 0, 0xff453a, 0xffa000, 0x35c759, 0]);
    expect(frame.threads.map((thread) => thread.effect)).toEqual([4, 0, 4, 4, 1, 0]);
    expect(frame.threads[2]).toMatchObject({ brightness: 0.8, speed: 0.35 });
    expect(frame.ambient).toEqual({ effect: 4, brightness: 0.95, speed: 0.35, magic: 0, color: 0xffa000 });
    expect(frame.keys).toEqual({ effect: 1, brightness: 0.28, speed: 0, magic: 0, color: 0xffa000 });

    const reordered = createDedicatedHardwareLightingFrame([null, SLOTS[0]!, null, null, null, null]);
    expect(reordered.threads[0]!.brightness).toBe(0);
    expect(reordered.threads[1]!.color).toBe(0x4c6fff);
    expect(reordered.ambient.effect).toBe(DedicatedHardwareLightingEffect.Snake);
    const acknowledged = createDedicatedHardwareLightingFrame([
      { phase: "completed", attention: false }, { phase: "error", attention: false },
      { phase: null, attention: true }, null, null, null
    ]);
    expect(acknowledged).toEqual(createDedicatedHardwareOffFrame());
    expect(() => createDedicatedHardwareLightingFrame(SLOTS.slice(0, 5))).toThrow(/six task slots/);
    expect(() => createDedicatedHardwareLightingFrame([...SLOTS, null])).toThrow(/six task slots/);
  });

  it.each(["codex-micro", "creator-micro-2"] as const)(
    "mutes shared key lighting after layout reassignment while retaining six task indicators on %s",
    (model) => {
      const settings = enabledSettings(model);
      const normal = computeDedicatedHardwareLightingFrame({ settings, taskSlots: SLOTS, dimmed: false, windowReveal: false });
      expect(normal.keys.brightness).toBeGreaterThan(0);
      for (const taskKeys of [["ACT12"] as const, DEDICATED_HARDWARE_PHYSICAL_KEYS, []]) {
        const changed: DedicatedHardwareSettings = { ...settings, layout: { ...settings.layout, taskKeys } };
        const muted = computeDedicatedHardwareLightingFrame({ settings: changed, taskSlots: SLOTS, dimmed: false, windowReveal: false });
        expect(muted.keys.brightness).toBe(0);
        expect(muted.ambient).toEqual(normal.ambient);
        expect(muted.threads).toEqual(normal.threads);
        expect(muted.threads).toHaveLength(6);
      }
    }
  );

  it("scales a reveal across the whole board and lets off and dim override it without altering the base", () => {
    const settings = enabledSettings("creator-micro-2");
    const selected: DedicatedHardwareSettings = {
      ...settings, lighting: { ...settings.lighting, brightnessPercent: 50 },
      layout: { ...settings.layout, taskKeys: ["ACT12"] }
    };
    const base = createDedicatedHardwareLightingFrame(SLOTS);
    const baseCopy = structuredClone(base);
    const reveal = computeDedicatedHardwareLightingFrame({ settings: selected, taskSlots: SLOTS, dimmed: false, windowReveal: true });
    expect(reveal.ambient).toEqual({ effect: 2, brightness: 0.39, speed: 0.55, magic: 0, color: 0xff9800 });
    expect(reveal.keys.brightness).toBe(0.17);
    expect(reveal.threads.every((thread) => thread.color === 0xff9800 && thread.brightness === 0.36)).toBe(true);
    expect(DEDICATED_HARDWARE_WINDOW_REVEAL_MS).toBe(2_000);
    expect(isDedicatedHardwareLightingFrameOff(createDedicatedHardwareWindowRevealFrame())).toBe(false);
    expect(computeDedicatedHardwareLightingFrame({ settings: selected, taskSlots: SLOTS, dimmed: true, windowReveal: true }))
      .toEqual(createDedicatedHardwareOffFrame());
    expect(computeDedicatedHardwareLightingFrame({ settings: { ...selected, enabled: false }, taskSlots: SLOTS, dimmed: false, windowReveal: true }))
      .toEqual(createDedicatedHardwareOffFrame());
    const zero = applyDedicatedHardwareLightingBrightness(base, 0);
    expect(isDedicatedHardwareLightingFrameOff(zero)).toBe(true);
    expect(zero.ambient.effect).toBe(base.ambient.effect);
    expect(base).toEqual(baseCopy);
  });

  it("uses the configured inactivity deadline and disables the deadline for off", () => {
    expect(dedicatedHardwareAutoDimMs("off")).toBeNull();
    expect(dedicatedHardwareAutoDimMs("30-seconds")).toBe(30_000);
    expect(dedicatedHardwareAutoDimMs("1-minute")).toBe(60_000);
    expect(dedicatedHardwareAutoDimMs("3-minutes")).toBe(180_000);
    expect(dedicatedHardwareAutoDimMs("10-minutes")).toBe(600_000);
    expect(dedicatedHardwareAutoDimMs("30-minutes")).toBe(1_800_000);
    expect(dedicatedHardwareAutoDimMs("1-hour")).toBe(3_600_000);
  });
});

function enabledSettings(model: DedicatedHardwareModelId): DedicatedHardwareSettings {
  return { ...createDefaultDedicatedHardwareSettings(model), enabled: true };
}
