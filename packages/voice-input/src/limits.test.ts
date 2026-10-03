import { describe, expect, it } from "vitest";
import { normalizeRecognitionContext, VoiceInputBoundsError } from "./limits.js";

describe("recognition context bounds", () => {
  it("preserves ordered normalized text in an independent deeply frozen snapshot, including explicit empty context", () => {
    expect(normalizeRecognitionContext(undefined)).toBeUndefined();
    const empty = normalizeRecognitionContext({ hotwords: [], contextData: [] });
    expect(empty).toEqual({ hotwords: [], contextData: [] });
    expect(Object.isFrozen(empty)).toBe(true);
    const source = { hotwords: ["  Term  ", "Term", "Term"], contextData: [{ text: "  First  " }, { text: "第二段" }] };
    const snapshot = normalizeRecognitionContext(source);
    expect(snapshot).toEqual({ hotwords: source.hotwords, contextData: [{ text: "First" }, { text: "第二段" }] });
    expect(normalizeRecognitionContext({ hotwords: [], contextData: [{ text: "  First\r\nsecond\rthird\tfourth  " }] }).contextData)
      .toEqual([{ text: "First\nsecond\nthird\tfourth" }]);
    source.hotwords[0] = "changed";
    source.contextData[0]!.text = "changed";
    expect(snapshot.hotwords).toEqual(["  Term  ", "Term", "Term"]);
    expect(snapshot.contextData[0]!.text).toBe("First");
    expect(normalizeRecognitionContext(snapshot)).toEqual(snapshot);
    expect([snapshot, snapshot.hotwords, snapshot.contextData, ...snapshot.contextData].every(Object.isFrozen)).toBe(true);
  });

  it("rejects malformed shapes and controls without sanitizing them", () => {
    for (const value of [null, [], {}, { hotwords: [], contextData: [], extra: true },
      { hotwords: null, contextData: [] }, { hotwords: [], contextData: null },
      { hotwords: [null], contextData: [] }, { hotwords: [], contextData: ["text"] },
      { hotwords: [], contextData: [{ text: null }] }, { hotwords: [], contextData: [{ text: "text", speaker: "user" }] },
      { hotwords: [], contextData: [{ text: " \r\n\t " }] }, { hotwords: [], contextData: [{ text: "bad\u0000text" }] },
      { hotwords: ["bad\nword"], contextData: [] }, { hotwords: [], contextData: [{ text: "bad\u0085text" }] }]) {
      expect(() => normalizeRecognitionContext(value)).toThrowError(VoiceInputBoundsError);
    }
  });

  it("enforces item counts, character bounds and UTF-8 byte bounds at their exact limits", () => {
    const boundary = { hotwords: Array.from({ length: 1_000 }, () => "字".repeat(120)),
      contextData: [{ text: "字".repeat(682) + "ab" }, ...Array.from({ length: 3 }, () => ({ text: "x".repeat(2_048) }))] };
    expect(normalizeRecognitionContext(boundary)).toEqual(boundary);
    expect(normalizeRecognitionContext({ hotwords: [], contextData: Array.from({ length: 20 }, () => ({ text: "x" })) }).contextData).toHaveLength(20);
    for (const value of [
      { hotwords: Array.from({ length: 1_001 }, () => "x"), contextData: [] },
      { hotwords: ["x".repeat(121)], contextData: [] },
      { hotwords: [], contextData: Array.from({ length: 21 }, () => ({ text: "x" })) },
      { hotwords: [], contextData: [{ text: "字".repeat(683) }] },
      { hotwords: [], contextData: [...boundary.contextData, { text: "x" }] }
    ]) expect(() => normalizeRecognitionContext(value)).toThrowError(VoiceInputBoundsError);
  });
});
