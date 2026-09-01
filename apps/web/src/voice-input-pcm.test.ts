// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { StreamingPcm16Resampler } from "./voice-input-pcm.js";

describe("StreamingPcm16Resampler", () => {
  it("keeps sample continuity across chunks and emits little-endian PCM16", () => {
    const resampler = new StreamingPcm16Resampler(48_000, 16_000);
    const first = resampler.push(Float32Array.from([0, 0.25, 0.5, 0.75]));
    const second = resampler.push(Float32Array.from([1, 0.75, 0.5, 0.25, 0]));
    const bytes = new Uint8Array(first.byteLength + second.byteLength);
    bytes.set(first);
    bytes.set(second, first.byteLength);
    const view = new DataView(bytes.buffer);

    expect(bytes.byteLength).toBeGreaterThanOrEqual(4);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBeGreaterThan(0);
  });

  it("clips out-of-range floating samples", () => {
    const resampler = new StreamingPcm16Resampler(16_000, 16_000);
    const bytes = resampler.push(Float32Array.from([-2, 2, 0]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(-32_768);
    expect(view.getInt16(2, true)).toBe(32_767);
  });
});
