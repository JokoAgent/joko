import { afterEach, describe, expect, it, vi } from "vitest";

import { isDedicatedHardwareLightingFrameOff, type DedicatedHardwareLightingFrame } from "./lighting-frame.js";
import { createDedicatedHardwareLightingRuntime } from "./lighting-runtime.js";
import type { DedicatedHardwareLightingState } from "./protocol.js";
import { createDefaultDedicatedHardwareSettings, type DedicatedHardwareSettings } from "./settings.js";

afterEach(() => vi.useRealTimers());

describe("dedicated hardware lighting runtime", () => {
  it("keeps the inactivity deadline stable on equal updates and wakes for input or semantic base changes", async () => {
    vi.useFakeTimers();
    const frames: DedicatedHardwareLightingFrame[] = [];
    const runtime = createDedicatedHardwareLightingRuntime({ apply: async (frame) => { frames.push(frame); } });
    const settings = enabledSettings();
    const state = activityState("running");
    runtime.update(settings, state);
    await flush();
    expect(frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    runtime.update(settings, state);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frames).toHaveLength(2);
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);
    runtime.update(settings, state);
    await flush();
    expect(frames).toHaveLength(2);

    runtime.physicalActivity();
    await flush();
    expect(frames.at(-1)!.threads[0]!.color).toBe(0x4c6fff);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);
    runtime.update(settings, activityState("needs-interaction"));
    await flush();
    expect(frames.at(-1)!.threads[0]!.color).toBe(0xffa000);
    expect(frames).toHaveLength(5);

    runtime.update({ ...settings, lighting: { ...settings.lighting, brightnessPercent: 0 } }, activityState("needs-interaction"));
    await flush();
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    runtime.physicalActivity();
    await flush();
    expect(frames).toHaveLength(6);
    runtime.close();
  });

  it("pulses only explicit visible reveal occurrences, retires them on hide or input, and expires after two seconds", async () => {
    vi.useFakeTimers();
    const frames: DedicatedHardwareLightingFrame[] = [];
    const runtime = createDedicatedHardwareLightingRuntime({ apply: async (frame) => { frames.push(frame); } });
    const settings = enabledSettings();
    const empty: DedicatedHardwareLightingState = { version: 1, taskSlots: [null, null, null, null, null, null], revealOccurrence: "0", primaryVisible: true };
    runtime.update(settings, empty);
    await flush();
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);
    runtime.update(settings, { ...empty, revealOccurrence: "1" });
    await flush();
    expect(frames.at(-1)!.ambient.color).toBe(0xff9800);
    await vi.advanceTimersByTimeAsync(1_000);
    runtime.update(settings, { ...empty, revealOccurrence: "1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);

    runtime.update(settings, { ...empty, revealOccurrence: "2" });
    await flush();
    expect(frames.at(-1)!.ambient.color).toBe(0xff9800);
    runtime.update(settings, { ...empty, revealOccurrence: "2", primaryVisible: false });
    await flush();
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);
    const afterHide = frames.length;
    runtime.update(settings, { ...empty, revealOccurrence: "2" });
    await flush();
    expect(frames).toHaveLength(afterHide);
    runtime.update(settings, { ...empty, revealOccurrence: "3" });
    await flush();
    runtime.physicalActivity();
    await flush();
    expect(isDedicatedHardwareLightingFrameOff(frames.at(-1)!)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    runtime.close();
  });

  it("keeps one apply in flight, coalesces to latest, and does not automatically retry a failed frame", async () => {
    vi.useFakeTimers();
    const pending: PendingApply[] = [];
    const failures: unknown[] = [];
    const runtime = createDedicatedHardwareLightingRuntime({
      apply: (frame, signal) => new Promise<void>((resolve, reject) => { pending.push({ frame, signal, resolve, reject }); }),
      onApplyFailure: (error) => failures.push(error)
    });
    const settings = enabledSettings("off");
    runtime.update(settings, activityState("running"));
    await flush();
    runtime.update(settings, activityState("needs-interaction"));
    runtime.update(settings, activityState("error"));
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.signal.aborted).toBe(false);
    pending[0]!.resolve();
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.frame.ambient.color).toBe(0xff453a);
    pending[1]!.reject(new Error("lighting roundtrip failed"));
    await flush();
    runtime.update(settings, activityState("error"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending).toHaveLength(2);
    expect(failures).toHaveLength(1);

    runtime.physicalActivity();
    await flush();
    expect(pending).toHaveLength(3);
    pending[2]!.reject(new Error("lighting roundtrip failed again"));
    await flush();
    expect(pending).toHaveLength(3);
    runtime.update(settings, activityState("needs-interaction"));
    await flush();
    expect(pending).toHaveLength(4);
    pending[3]!.resolve();
    await flush();
    runtime.update(settings, activityState("needs-interaction"));
    await flush();
    expect(pending).toHaveLength(4);
    runtime.close();
  });

  it("retires timers and writes on pause or close and requires explicit resume to apply the latest generation", async () => {
    vi.useFakeTimers();
    const pending: PendingApply[] = [];
    const runtime = createDedicatedHardwareLightingRuntime({
      apply: (frame, signal) => new Promise<void>((resolve, reject) => { pending.push({ frame, signal, resolve, reject }); })
    });
    const settings = enabledSettings();
    runtime.update(settings, activityState("running"));
    await flush();
    runtime.update(settings, activityState("needs-interaction"));
    runtime.pause();
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    runtime.update(settings, { ...activityState("error"), revealOccurrence: "1" });
    runtime.resume();
    await flush();
    expect(pending).toHaveLength(1);
    pending[0]!.resolve();
    await flush();
    expect(pending).toHaveLength(2);
    expect(pending[1]!.frame.ambient.color).toBe(0xff453a);
    runtime.close();
    expect(pending[1]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    pending[1]!.resolve();
    runtime.resume();
    runtime.physicalActivity();
    runtime.update(settings, activityState("running"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending).toHaveLength(2);

    const beforeDispatch = vi.fn(async () => {});
    const retired = createDedicatedHardwareLightingRuntime({ apply: beforeDispatch });
    retired.update(settings, activityState("running"));
    retired.pause();
    await flush();
    expect(beforeDispatch).not.toHaveBeenCalled();
    retired.close();
  });
});

interface PendingApply {
  readonly frame: DedicatedHardwareLightingFrame;
  readonly signal: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function enabledSettings(autoDim: DedicatedHardwareSettings["lighting"]["autoDim"] = "30-seconds"): DedicatedHardwareSettings {
  const settings = createDefaultDedicatedHardwareSettings("creator-micro-2");
  return { ...settings, enabled: true, lighting: { ...settings.lighting, autoDim } };
}

function activityState(phase: "running" | "needs-interaction" | "error"): DedicatedHardwareLightingState {
  return {
    version: 1, primaryVisible: true, revealOccurrence: "0",
    taskSlots: [{ phase, attention: phase === "error" }, null, null, null, null, null]
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
