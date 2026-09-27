import { describe, expect, it, vi } from "vitest";

import {
  SourceAwareVoiceLease,
  type VoiceLeaseBackend,
  type VoiceLeaseStopReason
} from "./voice-lease.js";

interface StopCall {
  readonly generation: number;
  readonly source: string;
  readonly reason: VoiceLeaseStopReason;
}

function resolvedBackend() {
  const starts: Array<{ generation: number; source: string }> = [];
  const stops: StopCall[] = [];
  const backend: VoiceLeaseBackend<string> = {
    start: async (request) => {
      starts.push(request);
      return true;
    },
    stop: async (request) => {
      stops.push(request);
    }
  };
  return { backend, starts, stops };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("source-aware voice lease", () => {
  it("keeps a short tap recording and lets the same source toggle it complete", async () => {
    const { backend, starts, stops } = resolvedBackend();
    let now = 0;
    const lease = new SourceAwareVoiceLease({ backend, now: () => now });

    const first = lease.press("hardware");
    expect(first).toMatchObject({ accepted: true, effect: "start" });
    await lease.settle();
    now = 449;
    if (!first.accepted) throw new Error("Expected a voice press lease.");
    expect(lease.release(first.lease)).toBe(true);
    expect(lease.snapshot()).toEqual({ state: "recording", generation: 1, source: "hardware" });
    expect(stops).toEqual([]);

    expect(lease.press("native-shortcut")).toEqual({
      accepted: false,
      reason: "recording-transition"
    });
    const toggle = lease.press("hardware");
    expect(toggle).toMatchObject({ accepted: true, effect: "toggle-complete" });
    await lease.settle();
    expect(starts).toEqual([{ generation: 1, source: "hardware" }]);
    expect(stops).toEqual([{ generation: 1, source: "hardware", reason: "complete" }]);
    expect(lease.snapshot()).toEqual({ state: "idle" });
  });

  it("completes a long hold on release", async () => {
    const { backend, stops } = resolvedBackend();
    let now = 100;
    const lease = new SourceAwareVoiceLease({ backend, now: () => now });
    const press = lease.press("hardware");
    await lease.settle();
    now = 550;
    if (!press.accepted) throw new Error("Expected a voice press lease.");
    lease.release(press.lease);
    await lease.settle();

    expect(stops).toEqual([{ generation: 1, source: "hardware", reason: "complete" }]);
    expect(lease.snapshot()).toEqual({ state: "idle" });
  });

  it("finishes after an asynchronous start when release arrived first", async () => {
    const start = deferred<boolean>();
    const stops: StopCall[] = [];
    let now = 0;
    const lease = new SourceAwareVoiceLease<string>({
      backend: {
        start: () => start.promise,
        stop: async (request) => { stops.push(request); }
      },
      now: () => now
    });
    const press = lease.press("hardware");
    now = 500;
    if (!press.accepted) throw new Error("Expected a voice press lease.");
    lease.release(press.lease);
    expect(stops).toEqual([]);
    expect(lease.snapshot()).toMatchObject({ state: "starting", generation: 1 });

    start.resolve(true);
    await lease.settle();
    expect(stops).toEqual([{ generation: 1, source: "hardware", reason: "complete" }]);
    expect(lease.snapshot()).toEqual({ state: "idle" });
  });

  it("cancels a pending start after disable without admitting another generation", async () => {
    const start = deferred<boolean>();
    const stops: StopCall[] = [];
    const lease = new SourceAwareVoiceLease<string>({
      backend: {
        start: () => start.promise,
        stop: async (request) => { stops.push(request); }
      }
    });
    lease.press("hardware");
    expect(lease.cancelSource("hardware")).toBe(true);
    expect(lease.press("native-shortcut")).toEqual({
      accepted: false,
      reason: "recording-transition"
    });

    start.resolve(true);
    await lease.settle();
    expect(stops).toEqual([{ generation: 1, source: "hardware", reason: "cancel" }]);
    expect(lease.snapshot()).toEqual({ state: "idle" });
  });

  it("does not let an old source release stop a newer recording", async () => {
    const { backend, stops } = resolvedBackend();
    let now = 0;
    const lease = new SourceAwareVoiceLease({ backend, now: () => now });
    const oldPress = lease.press("hardware");
    await lease.settle();

    if (!oldPress.accepted) throw new Error("Expected a voice press lease.");
    expect(lease.release(oldPress.lease, "tap")).toBe(true);
    lease.press("hardware");
    await lease.settle();
    const current = lease.press("hardware-new-generation");
    await lease.settle();
    expect(current).toMatchObject({ accepted: true, effect: "start" });
    expect(lease.snapshot()).toEqual({
      state: "recording",
      generation: 2,
      source: "hardware-new-generation"
    });

    now = 5_000;
    expect(lease.release(oldPress.lease, "hold")).toBe(false);
    await lease.settle();
    expect(stops).toEqual([{ generation: 1, source: "hardware", reason: "complete" }]);
    expect(lease.snapshot()).toMatchObject({ state: "recording", generation: 2 });
  });

  it("requires the exact activation and rejects repeated press from one source", async () => {
    const { backend } = resolvedBackend();
    const lease = new SourceAwareVoiceLease({ backend });
    const press = lease.press("hardware");
    expect(lease.press("hardware")).toEqual({ accepted: false, reason: "source-held" });
    if (!press.accepted) throw new Error("Expected a voice press lease.");
    expect(lease.release({ ...press.lease, activation: press.lease.activation + 1 })).toBe(false);
    expect(lease.release(press.lease, "tap")).toBe(true);
    await lease.settle();
    expect(lease.snapshot()).toMatchObject({ state: "recording", generation: 1 });
  });

  it("fails closed after an uncertain stop and needs an exact owner acknowledgement", async () => {
    const failures = vi.fn();
    const lease = new SourceAwareVoiceLease<string>({
      backend: {
        start: async () => true,
        stop: async () => { throw new Error("stop failed"); }
      },
      onFailure: failures
    });
    const press = lease.press("hardware");
    await lease.settle();
    if (!press.accepted) throw new Error("Expected a voice press lease.");
    lease.release(press.lease, "hold");
    await lease.settle();

    expect(lease.snapshot()).toEqual({ state: "uncertain", generation: 1, source: "hardware" });
    expect(lease.press("native-shortcut")).toEqual({
      accepted: false,
      reason: "recording-uncertain"
    });
    expect(lease.acknowledgeStopped(2)).toBe(false);
    expect(lease.acknowledgeStopped(1)).toBe(true);
    expect(lease.snapshot()).toEqual({ state: "idle" });
    expect(failures).toHaveBeenCalledWith(expect.any(Error), "stop", 1);
  });

  it("cancels the recording only from its owning source or an explicit global lifecycle", async () => {
    const { backend, stops } = resolvedBackend();
    const lease = new SourceAwareVoiceLease({ backend });
    lease.press("hardware");
    await lease.settle();
    expect(lease.cancelSource("native-shortcut")).toBe(false);
    expect(lease.snapshot()).toMatchObject({ state: "recording" });
    expect(lease.cancelAll()).toBe(true);
    await lease.settle();
    expect(stops).toEqual([{ generation: 1, source: "hardware", reason: "cancel" }]);
  });
});
