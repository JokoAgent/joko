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
    const guard = new SystemAudioMuteGuard<string>(backend);

    await Promise.all([guard.acquire("first"), guard.acquire("second")]);
    await guard.release("first");
    expect(backend.muted).toBe(true);
    await guard.release("second");

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

  it("uses a no-op backend on unsupported platforms", async () => {
    const backend = createSystemAudioMuteBackend("linux", async () => {
      throw new Error("must not load");
    });

    expect(backend.supported).toBe(false);
    await expect(backend.getMuted()).resolves.toBe(false);
    await expect(backend.setMuted(true)).resolves.toBeUndefined();
  });
});
