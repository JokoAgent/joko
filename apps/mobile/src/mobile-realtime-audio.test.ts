import { describe, expect, it } from "vitest";
import { createPcm16Converter, decodeBase64Pcm, mobilePcmIsVoiced } from "./mobile-pcm";

describe("mobile realtime PCM", () => {
  it("classifies silence and voiced PCM using the shared normalized RMS boundary", () => {
    expect(mobilePcmIsVoiced(new Uint8Array(320))).toBe(false);
    const voiced = new Uint8Array(320);
    const view = new DataView(voiced.buffer);
    for (let offset = 0; offset < voiced.byteLength; offset += 2) view.setInt16(offset, 2_000, true);
    expect(mobilePcmIsVoiced(voiced)).toBe(true);
  });

  it("mixes and resamples PCM16 into continuous 16 kHz mono chunks", () => {
    const source = new ArrayBuffer(480 * 2 * 2);
    const view = new DataView(source);
    for (let frame = 0; frame < 480; frame += 1) {
      view.setInt16(frame * 4, 1_000, true);
      view.setInt16(frame * 4 + 2, 3_000, true);
    }
    const convert = createPcm16Converter(16_000);
    const first = convert(source, 48_000, 2);
    const second = convert(source, 48_000, 2);
    expect(first.byteLength).toBe(320);
    expect(second.byteLength).toBe(320);
    expect(new DataView(first.buffer).getInt16(0, true)).toBe(2_000);
  });

  it("decodes only even-length PCM payloads", () => {
    expect([...decodeBase64Pcm("AQACAAMA")]).toEqual([1, 0, 2, 0, 3, 0]);
    expect(() => decodeBase64Pcm("AQ==")).toThrow(/PCM bytes/i);
    expect(() => decodeBase64Pcm("not base64")).toThrow(/base64 PCM/i);
  });
});
