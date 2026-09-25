import { expect, it, vi } from "vitest";
import { SimulatorH264Decoder, codecFromH264NalUnits, normalizeH264AccessUnit,
  type DecodedFrame, type SimulatorH264DecoderRuntime,
  type SimulatorH264Frame } from "./simulator-h264-decoder.js";

const keyBytes = new Uint8Array([0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f,
  0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80, 0, 0, 0, 1, 0x65, 0x88]);
function frame(changes: Partial<SimulatorH264Frame> = {}): SimulatorH264Frame {
  return { bytes: keyBytes, format: "annex-b", width: 16, height: 12,
    timestampMicros: 1_000, keyFrame: true, ...changes };
}

it("normalizes bounded Annex-B and length-prefixed access units and reads the SPS codec", () => {
  const annex = normalizeH264AccessUnit(frame());
  expect(annex?.nalUnits).toHaveLength(3);
  expect(codecFromH264NalUnits(annex!.nalUnits)).toBe("avc1.4d401f");
  const lengthPrefixed = new Uint8Array([0, 0, 0, 4, 0x67, 0x4d, 0x40, 0x1f,
    0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65]);
  expect(normalizeH264AccessUnit(frame({ bytes: lengthPrefixed,
    format: "length-prefixed" }))?.bytes).toEqual(new Uint8Array([
      0, 0, 0, 1, 0x67, 0x4d, 0x40, 0x1f, 0, 0, 0, 1, 0x68, 0, 0, 0, 1, 0x65]));
  expect(normalizeH264AccessUnit(frame({ bytes: new Uint8Array([0, 0, 0, 8, 0x65]),
    format: "length-prefixed" }))).toBeNull();
  expect(normalizeH264AccessUnit(frame({ width: 8_193 }))).toBeNull();
});

it("configures from an IDR, renders and closes output, then requires a new key frame on resize", async () => {
  let callbacks: { output(frame: DecodedFrame): void; error(error: DOMException): void } | undefined;
  const configure = vi.fn();
  const decode = vi.fn();
  const close = vi.fn();
  const runtime: SimulatorH264DecoderRuntime = {
    isConfigSupported: vi.fn(async () => true),
    createDecoder(value) { callbacks = value; return { configure, decode, close }; },
    createChunk: value => value
  };
  const render = vi.fn();
  const fallback = vi.fn();
  const decoder = new SimulatorH264Decoder({ runtime, renderFrame: render, onFallback: fallback });
  expect(await decoder.decode(frame({ keyFrame: false }), 2n)).toBe("waiting-for-key-frame");
  expect(await decoder.decode(frame(), 2n)).toBe("decoded");
  expect(configure).toHaveBeenCalledWith(expect.objectContaining({ codec: "avc1.4d401f",
    codedWidth: 16, codedHeight: 12 }));
  expect(decode).toHaveBeenCalledWith(expect.objectContaining({ type: "key", timestamp: 1_000 }));
  const output = { close: vi.fn() };
  callbacks!.output(output);
  expect(render).toHaveBeenCalledWith(output, 16, 12);
  expect(output.close).toHaveBeenCalledOnce();
  expect(await decoder.decode(frame({ width: 20, keyFrame: false }), 2n)).toBe("waiting-for-key-frame");
  expect(close).toHaveBeenCalledOnce();
  callbacks!.output({ close: vi.fn() });
  expect(render).toHaveBeenCalledTimes(1);
  expect(await decoder.decode(frame({ width: 20 }), 2n)).toBe("decoded");
  decoder.close();
  expect(await decoder.decode(frame(), 2n)).toBe("closed");
  expect(fallback).not.toHaveBeenCalled();
});

it("falls back explicitly for unavailable WebCodecs, missing parameter sets and unsupported codec", async () => {
  const unavailable = vi.fn();
  expect(await new SimulatorH264Decoder({ runtime: null, renderFrame: vi.fn(),
    onFallback: unavailable }).decode(frame(), 1n)).toBe("fallback");
  expect(unavailable).toHaveBeenCalledWith("webcodecs-unavailable");
  const missing = vi.fn();
  expect(await new SimulatorH264Decoder({ runtime: {
    isConfigSupported: async () => true, createDecoder: vi.fn(), createChunk: vi.fn()
  }, renderFrame: vi.fn(), onFallback: missing }).decode(frame({ bytes: new Uint8Array([
    0, 0, 0, 1, 0x65, 1, 2]) }), 1n)).toBe("fallback");
  expect(missing).toHaveBeenCalledWith("missing-parameter-sets");
  const unsupported = vi.fn();
  expect(await new SimulatorH264Decoder({ runtime: {
    isConfigSupported: async () => false, createDecoder: vi.fn(), createChunk: vi.fn()
  }, renderFrame: vi.fn(), onFallback: unsupported }).decode(frame(), 1n)).toBe("fallback");
  expect(unsupported).toHaveBeenCalledWith("unsupported-configuration");
});

it("closes while support is pending without configuring or rendering stale frames", async () => {
  let release!: (supported: boolean) => void;
  const support = new Promise<boolean>(resolve => { release = resolve; });
  const createDecoder = vi.fn();
  const fallback = vi.fn();
  const decoder = new SimulatorH264Decoder({ runtime: {
    isConfigSupported: () => support, createDecoder, createChunk: vi.fn()
  }, renderFrame: vi.fn(), onFallback: fallback });
  const pending = decoder.decode(frame(), 3n);
  decoder.close();
  release(true);
  expect(await pending).toBe("stale");
  expect(createDecoder).not.toHaveBeenCalled();
  expect(fallback).not.toHaveBeenCalled();
});
