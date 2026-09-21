import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let statusListener: ((status: { didJustFinish: boolean }) => void) | undefined;
  const remove = vi.fn();
  const release = vi.fn();
  const play = vi.fn();
  const addListener = vi.fn((_event: string, listener: typeof statusListener) => {
    statusListener = listener;
    return { remove };
  });
  const createAudioPlayer = vi.fn((_source: string, _options?: unknown) => ({ addListener, play, release }));
  return {
    addListener,
    createAudioPlayer,
    play,
    release,
    remove,
    readStatusListener: () => statusListener,
    resetStatusListener: () => { statusListener = undefined; }
  };
});

vi.mock("expo-audio", () => ({ createAudioPlayer: mocks.createAudioPlayer }));

import { playMobileVoiceInputEndCue } from "./mobile-voice-cue";

describe("mobile voice cue", () => {
  beforeEach(() => {
    mocks.resetStatusListener();
    vi.clearAllMocks();
  });

  it("plays a generated WAV only after requested and releases its native player at completion", () => {
    playMobileVoiceInputEndCue();

    expect(mocks.createAudioPlayer).toHaveBeenCalledOnce();
    expect(mocks.createAudioPlayer.mock.calls[0]?.[0]).toMatch(/^data:audio\/wav;base64,UklGR/u);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    mocks.readStatusListener()?.({ didJustFinish: true });
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("keeps optional feedback failures out of the transcription path", () => {
    mocks.play.mockImplementationOnce(() => { throw new Error("playback unavailable"); });

    expect(() => playMobileVoiceInputEndCue()).not.toThrow();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
