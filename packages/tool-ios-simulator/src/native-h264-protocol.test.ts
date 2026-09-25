import { expect, it } from "vitest";
import { SimulatorNativeH264FrameParser, SimulatorNativeH264ProtocolError
} from "./native-h264-protocol.js";

function encode(sequence: number, changes: Record<string, unknown> = {},
  bytes = new Uint8Array([0, 0, 0, 1, 0x65, 0x88])): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({ sequence, width: 16,
    height: 12, timestampMicros: sequence * 1_000, keyFrame: sequence === 1,
    format: "annex-b", ...changes }));
  const length = 2 + metadata.byteLength + bytes.byteLength;
  const output = new Uint8Array(4 + length);
  output[0] = length & 0xff;
  output[1] = length >> 8 & 0xff;
  output[2] = length >> 16 & 0xff;
  output[3] = length >> 24 & 0xff;
  output[4] = metadata.byteLength & 0xff;
  output[5] = metadata.byteLength >> 8 & 0xff;
  output.set(metadata, 6);
  output.set(bytes, 6 + metadata.byteLength);
  return output;
}

it("accepts split and coalesced frames with exact monotonic sequence", () => {
  const parser = new SimulatorNativeH264FrameParser();
  const first = encode(1);
  expect(parser.push(first.subarray(0, 3))).toEqual([]);
  expect(parser.push(first.subarray(3, 12))).toEqual([]);
  const second = encode(2);
  const remaining = new Uint8Array(first.byteLength - 12 + second.byteLength);
  remaining.set(first.subarray(12));
  remaining.set(second, first.byteLength - 12);
  const frames = parser.push(remaining);
  expect(frames.map(value => value.sequence)).toEqual([1, 2]);
  expect(frames[0]).toMatchObject({ width: 16, height: 12, keyFrame: true,
    format: "annex-b", timestampMicros: 1_000 });
  expect(frames[0]?.bytes).toEqual(new Uint8Array([0, 0, 0, 1, 0x65, 0x88]));
  expect(() => parser.finish()).not.toThrow();
});

it("fails closed for oversized, malformed, duplicate, foreign and partial output", () => {
  const oversized = new Uint8Array([0xff, 0xff, 0xff, 0x7f]);
  expect(() => new SimulatorNativeH264FrameParser().push(oversized))
    .toThrow(SimulatorNativeH264ProtocolError);
  expect(() => new SimulatorNativeH264FrameParser().push(encode(1, { width: 8_193 })))
    .toThrow(SimulatorNativeH264ProtocolError);
  expect(() => new SimulatorNativeH264FrameParser().push(encode(1, { path: "/private/host" })))
    .toThrow(SimulatorNativeH264ProtocolError);
  expect(() => new SimulatorNativeH264FrameParser().push(encode(1, {},
    new Uint8Array([1, 2, 3, 4, 5])))).toThrow(SimulatorNativeH264ProtocolError);
  const parser = new SimulatorNativeH264FrameParser();
  parser.push(encode(1));
  expect(() => parser.push(encode(1))).toThrow(SimulatorNativeH264ProtocolError);
  const partial = new SimulatorNativeH264FrameParser();
  partial.push(encode(1).subarray(0, 10));
  expect(() => partial.finish()).toThrow(SimulatorNativeH264ProtocolError);
});
