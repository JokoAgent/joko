import { describe, expect, it, vi } from "vitest";
import { VoiceInputMicrophonePrewarmer } from "./voice-input-prewarm.js";

describe("VoiceInputMicrophonePrewarmer", () => {
  it("keeps one warm source, checks out clones, and releases stale devices", async () => {
    const first = fakeStream();
    const second = fakeStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    const prewarmer = new VoiceInputMicrophonePrewarmer({ getUserMedia });

    await expect(prewarmer.warm("mic-one")).resolves.toBe(true);
    expect(prewarmer.checkout()).toBe(first.clone);
    await expect(prewarmer.warm("mic-one")).resolves.toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await expect(prewarmer.warm("mic-two")).resolves.toBe(true);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(prewarmer.checkout()).toBe(second.clone);
    prewarmer.release();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("stops a late stale stream without replacing the current device", async () => {
    const stale = fakeStream();
    const current = fakeStream();
    let resolveStale!: (stream: MediaStream) => void;
    const staleRequest = new Promise<MediaStream>((resolve) => { resolveStale = resolve; });
    const getUserMedia = vi.fn()
      .mockReturnValueOnce(staleRequest)
      .mockResolvedValueOnce(current.stream);
    const prewarmer = new VoiceInputMicrophonePrewarmer({ getUserMedia });

    const firstWarm = prewarmer.warm("mic-one");
    await expect(prewarmer.warm("mic-two")).resolves.toBe(true);
    resolveStale(stale.stream);
    await expect(firstWarm).resolves.toBe(false);

    expect(stale.stop).toHaveBeenCalledOnce();
    expect(prewarmer.checkout()).toBe(current.clone);
    expect(current.stop).not.toHaveBeenCalled();
    prewarmer.release();
  });
});

function fakeStream(): { readonly stream: MediaStream; readonly clone: MediaStream; readonly stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn();
  const track = { readyState: "live", stop } as unknown as MediaStreamTrack;
  const clone = {} as MediaStream;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
    clone: () => clone
  } as unknown as MediaStream;
  return { stream, clone, stop };
}
