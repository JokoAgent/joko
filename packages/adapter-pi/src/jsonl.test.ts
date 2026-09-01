import { describe, expect, it } from "vitest";
import {
  encodeJsonLine,
  MAX_SAFE_PI_JSONL_RECORD_BYTES,
  StrictJsonLineDecoder
} from "./jsonl.js";

describe("StrictJsonLineDecoder", () => {
  it("splits only LF bytes and preserves legal Unicode separators", () => {
    const values: unknown[] = [];
    const decoder = new StrictJsonLineDecoder({ onValue: (value) => values.push(value) });
    const wire = Buffer.from('{"text":"a b c"}\r\n{"ok":true}\n', "utf8");
    for (let index = 0; index < wire.length; index += 2) decoder.push(wire.subarray(index, index + 2));
    decoder.end();
    expect(values).toEqual([{ text: "a b c" }, { ok: true }]);
  });

  it("rejects a final record without LF", () => {
    const decoder = new StrictJsonLineDecoder({ onValue: () => undefined });
    decoder.push(Buffer.from('{"ok":true}'));
    expect(() => decoder.end()).toThrow(/not terminated by LF/);
  });

  it("accepts an exact byte boundary and rejects the first byte beyond it", () => {
    const values: unknown[] = [];
    const exactRecord = Buffer.from('{"x":"1234"}', "utf8");
    expect(exactRecord.byteLength).toBe(12);
    const exact = new StrictJsonLineDecoder({
      maxRecordBytes: exactRecord.byteLength,
      onValue: (value) => values.push(value)
    });
    exact.push(exactRecord.subarray(0, 5));
    exact.push(Buffer.concat([exactRecord.subarray(5), Buffer.from("\n")]));
    exact.end();
    expect(values).toEqual([{ x: "1234" }]);

    const oversized = new StrictJsonLineDecoder({
      maxRecordBytes: exactRecord.byteLength,
      onValue: () => undefined
    });
    oversized.push(exactRecord);
    expect(() => oversized.push(Buffer.from("x"))).toThrow(/larger than 12 bytes/);
  });

  it("reserves capacity without allocation and enforces the configured and platform ceilings", () => {
    const decoder = new StrictJsonLineDecoder({
      maxRecordBytes: 8,
      maxRecordBytesCeiling: 12,
      onValue: () => undefined
    });
    decoder.reserveRecordBytes(12);
    expect(decoder.maxRecordBytes).toBe(12);
    expect(() => decoder.reserveRecordBytes(13)).toThrow(/configured 12-byte ceiling/);
    expect(decoder.maxRecordBytes).toBe(12);

    expect(() => new StrictJsonLineDecoder({
      maxRecordBytes: MAX_SAFE_PI_JSONL_RECORD_BYTES + 1,
      onValue: () => undefined
    })).toThrow(/platform JSON string ceiling/);
  });

  it("serializes exactly one LF-terminated record", () => {
    expect(encodeJsonLine({ type: "get_state" }).toString("utf8")).toBe('{"type":"get_state"}\n');
  });
});

