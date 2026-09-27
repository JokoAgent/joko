import { describe, expect, it, vi } from "vitest";

import {
  settleCompleteExitOperations,
  settleGlobalVoiceForExit
} from "./complete-exit-coordination.js";
import { SourceAwareVoiceLease } from "./dedicated-hardware-action/voice-lease.js";
import { createManagedExitFence } from "./managed-exit-fence.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("complete exit coordination", () => {
  it("keeps the exact voice generation owned until cancellation is acknowledged", async () => {
    const stopped = deferred<void>();
    const stop = vi.fn(() => stopped.promise);
    const lease = new SourceAwareVoiceLease<string>({
      backend: { start: async () => true, stop }
    });
    const pressed = lease.press("shortcut");
    expect(pressed.accepted).toBe(true);
    await lease.settle();

    let settled = false;
    const exiting = settleGlobalVoiceForExit(lease).then(() => { settled = true; });
    await flushMicrotasks();

    expect(stop).toHaveBeenCalledExactlyOnceWith({
      generation: 1,
      source: "shortcut",
      reason: "cancel"
    });
    expect(lease.snapshot()).toEqual({ state: "stopping", generation: 1, source: "shortcut" });
    expect(settled).toBe(false);

    stopped.resolve(undefined);
    await exiting;
    expect(settled).toBe(true);
    expect(lease.snapshot()).toEqual({ state: "idle" });
  });

  it("keeps a failed voice cancellation uncertain instead of admitting a replacement", async () => {
    const lease = new SourceAwareVoiceLease<string>({
      backend: {
        start: async () => true,
        stop: async () => { throw new Error("renderer did not acknowledge cancellation"); }
      }
    });
    lease.press("hardware");
    await lease.settle();

    await expect(settleGlobalVoiceForExit(lease)).rejects.toThrow(
      "Global voice cancellation was not acknowledged"
    );
    expect(lease.snapshot()).toEqual({ state: "uncertain", generation: 1, source: "hardware" });
    expect(lease.press("hardware")).toEqual({ accepted: false, reason: "recording-uncertain" });
  });

  it("waits for every stop leg before exposing a failure to recovery", async () => {
    const runtimeStopped = deferred<void>();
    const runtime = { stop: vi.fn(() => runtimeStopped.promise) };
    const fence = createManagedExitFence({
      getInitialization: () => undefined,
      clearInitialization: () => undefined,
      getRuntime: () => runtime,
      stopRuntime: (owned) => owned.stop(),
      clearRuntime: () => undefined
    });
    const clipboardFailure = new Error("clipboard restoration failed");
    let rejected = false;
    const exiting = settleCompleteExitOperations([
      () => fence.stop(),
      () => Promise.reject(clipboardFailure)
    ]).catch((error: unknown) => {
      rejected = true;
      throw error;
    });

    await flushMicrotasks();
    expect(fence.shutdownStarted).toBe(true);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(rejected).toBe(false);

    runtimeStopped.resolve(undefined);
    await expect(exiting).rejects.toBe(clipboardFailure);
    expect(rejected).toBe(true);
    expect(fence.shutdownStarted).toBe(true);

    fence.releaseForRecovery();
    expect(fence.shutdownStarted).toBe(false);
  });

  it("starts later stop legs even when an earlier leg throws synchronously", async () => {
    const failure = new Error("first stop failed");
    const later = vi.fn(async () => undefined);

    await expect(settleCompleteExitOperations([
      () => { throw failure; },
      later
    ])).rejects.toBe(failure);
    expect(later).toHaveBeenCalledOnce();
  });
});
