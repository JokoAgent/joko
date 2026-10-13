import { describe, expect, it } from "vitest";

import {
  createSystemAudioMuteBackend,
  SystemAudioMuteGuard,
  type SystemAudioMuteBackend
} from "../src/system-audio-mute.js";

function fakeBackend(initialMuted: boolean): SystemAudioMuteBackend & {
  readonly writes: boolean[];
  muted: boolean;
} {
  const backend = {
    supported: true,
    muted: initialMuted,
    writes: [] as boolean[],
    async getMuted() { return backend.muted; },
    async setMuted(muted: boolean) {
      backend.writes.push(muted);
      backend.muted = muted;
    }
  };
  return backend;
}

describe("SystemAudioMuteGuard", () => {
  it("mutes for the first owner and restores the original unmuted state", async () => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<string>(backend);

    await guard.acquire("capture");
    expect(backend.muted).toBe(true);
    await guard.release("capture");

    expect(backend.muted).toBe(false);
    expect(backend.writes).toEqual([true, false]);
  });

  it("does not unmute audio that was muted before capture", async () => {
    const backend = fakeBackend(true);
    const guard = new SystemAudioMuteGuard<string>(backend);

    await guard.acquire("capture");
    await guard.release("capture");

    expect(backend.muted).toBe(true);
    expect(backend.writes).toEqual([]);
  });

  it("keeps audio muted until all overlapping owners release", async () => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<number | object>(backend);
    const viewer = {};

    await Promise.all([guard.acquire(viewer), guard.acquire(1)]);
    await guard.release(viewer);
    expect(backend.muted).toBe(true);
    await guard.release(1);

    expect(backend.writes).toEqual([true, false]);
  });

  it("restores all owners during shutdown", async () => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<string>(backend);

    await guard.acquire("first");
    await guard.acquire("second");
    await guard.releaseAll();

    expect(backend.muted).toBe(false);
    expect(backend.writes).toEqual([true, false]);
  });

  it("retries a rejected restore after its owner was already removed", async () => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<object>(backend);
    const owner = {};
    let rejectRestore = true;
    backend.setMuted = async (muted) => {
      backend.writes.push(muted);
      if (!muted && rejectRestore) { rejectRestore = false; throw new Error("Restore unavailable"); }
      backend.muted = muted;
    };
    await guard.acquire(owner);
    await expect(guard.release(owner)).rejects.toThrow("Restore unavailable");
    expect(backend.muted).toBe(true);
    await guard.release(owner);
    expect(backend.muted).toBe(false);
    expect(backend.writes).toEqual([true, false, false]);
  });

  it("reasserts mute for a new owner when a rejected restore may have reached the OS", async () => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<number | object>(backend);
    const viewer = {};
    let rejectRestore = true;
    backend.setMuted = async (muted) => {
      backend.writes.push(muted);
      backend.muted = muted;
      if (!muted && rejectRestore) { rejectRestore = false; throw new Error("Restore outcome unknown"); }
    };
    await guard.acquire(viewer);
    await expect(guard.release(viewer)).rejects.toThrow("Restore outcome unknown");
    expect(backend.muted).toBe(false);
    await guard.acquire(1);
    expect(backend.muted).toBe(true);
    await guard.release(viewer);
    expect(backend.muted).toBe(true);
    await guard.release(1);
    expect(backend.muted).toBe(false);
    expect(backend.writes).toEqual([true, false, true, false]);
  });

  it("rechecks authority after reading native state before performing mute", async () => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<object>(backend);
    let finishRead!: (muted: boolean) => void;
    backend.getMuted = () => new Promise((resolve) => { finishRead = resolve; });
    let current = true;
    const check = (): void => { if (!current) throw new Error("Retired"); };
    const pending = guard.acquire({}, check);
    const rejected = expect(pending).rejects.toThrow("Retired");
    await Promise.resolve();
    current = false;
    finishRead(false);
    await rejected;
    expect(backend.writes).toEqual([]);
  });

  it.each(["retired", "native failure"])("preserves recovery after mute reaches the OS with %s", async (failure) => {
    const backend = fakeBackend(false);
    const guard = new SystemAudioMuteGuard<object>(backend);
    const owner = {};
    let current = true;
    backend.setMuted = async (muted) => {
      backend.writes.push(muted);
      backend.muted = muted;
      if (muted) {
        current = false;
        if (failure === "native failure") throw new Error("Native outcome unknown");
      }
    };
    await expect(guard.acquire(owner, () => { if (!current) throw new Error("Retired"); })).rejects.toThrow();
    expect(backend.muted).toBe(true);
    await guard.release(owner);
    expect(backend.muted).toBe(false);
    expect(backend.writes).toEqual([true, false]);
  });

  it("uses a no-op backend on unsupported platforms", async () => {
    const backend = createSystemAudioMuteBackend("linux", async () => {
      throw new Error("must not load");
    });

    expect(backend.supported).toBe(false);
    await expect(backend.getMuted()).resolves.toBe(false);
    await expect(backend.setMuted(true)).resolves.toBeUndefined();
  });
});
