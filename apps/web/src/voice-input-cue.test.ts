import { describe, expect, it, vi } from "vitest";
import { playVoiceInputCue } from "./voice-input-cue.js";

describe("playVoiceInputCue", () => {
  it("uses distinct local tones and closes the short-lived audio context", async () => {
    const frequencies: number[] = [];
    const close = vi.fn(async () => undefined);
    const ended: Array<() => void> = [];
    const createContext = () => ({
      currentTime: 1,
      destination: {} as AudioDestinationNode,
      close,
      createGain: () => ({
        gain: {
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn()
        },
        connect: vi.fn()
      } as unknown as GainNode),
      createOscillator: () => ({
        type: "sine",
        frequency: { setValueAtTime: (value: number) => frequencies.push(value) },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        addEventListener: (_type: string, listener: () => void) => ended.push(listener)
      } as unknown as OscillatorNode)
    });

    playVoiceInputCue("start", createContext);
    playVoiceInputCue("stop", createContext);
    expect(frequencies).toEqual([720, 520]);
    for (const listener of ended) listener();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
