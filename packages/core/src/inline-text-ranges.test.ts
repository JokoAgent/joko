import { describe, expect, it } from "vitest";

import { validInlineTextRanges, validInputMentionRanges, type InputMentionRange } from "./types.js";

describe("inline text ranges", () => {
  it("accepts ordered UTF-16 spans and rejects overlap, repair, and split surrogates", () => {
    const text = "A😀pasteZ";
    expect(validInlineTextRanges(text, [
      { start: 0, end: 1, display: "first" },
      { start: 3, end: 8, display: "Pasted text (1 line)" }
    ])).toBe(true);
    expect(validInlineTextRanges(text, [
      { start: 3, end: 8, display: "later" },
      { start: 0, end: 1, display: "earlier" }
    ])).toBe(false);
    expect(validInlineTextRanges(text, [{ start: 1, end: 2, display: "split" }])).toBe(false);
    expect(validInlineTextRanges(text, [{ start: 3, end: 10, display: "outside" }])).toBe(false);
    expect(validInlineTextRanges(text, [{ start: 3, end: 8, display: " ".repeat(2) }])).toBe(false);
  });
});

describe("input mention ranges", () => {
  const mentions = [
    { kind: "artifact" as const, label: "report.txt", reference: "artifact-one" },
    { kind: "artifact" as const, label: "report.txt", reference: "artifact-two" }
  ];
  const text = "😀 @report.txt @report.txt @report.txt paste";
  const ranges = [
    { start: 3, end: 14, mentionIndex: 1 },
    { start: 15, end: 26, mentionIndex: 0 },
    { start: 27, end: 38, mentionIndex: 1 }
  ];

  it("retains explicit identity for repeated equal labels and permits non-inline references", () => {
    expect(validInputMentionRanges(text, mentions, ranges, [{ start: 39, end: 44, display: "paste" }])).toBe(true);
    expect(validInputMentionRanges(text, mentions, [])).toBe(true);
    expect(validInputMentionRanges("different visible label", mentions, [{ start: 0, end: 9, mentionIndex: 1 }])).toBe(true);
    expect(ranges.map((range) => mentions[range.mentionIndex]?.reference)).toEqual(["artifact-two", "artifact-one", "artifact-two"]);
  });

  it("rejects unordered, overlapping, invalid-index and split-surrogate ranges without repair", () => {
    const invalid: readonly (readonly InputMentionRange[])[] = [
      [ranges[1]!, ranges[0]!],
      [ranges[0]!, { start: 13, end: 26, mentionIndex: 0 }],
      [{ start: 1, end: 14, mentionIndex: 0 }],
      [{ start: 0, end: 1, mentionIndex: 0 }],
      [{ start: -1, end: 3, mentionIndex: 0 }],
      [{ start: 3, end: text.length + 1, mentionIndex: 0 }],
      [{ start: 3, end: 3, mentionIndex: 0 }],
      [{ start: 3.5, end: 14, mentionIndex: 0 }],
      [{ start: 3, end: 14, mentionIndex: -1 }],
      [{ start: 3, end: 14, mentionIndex: 2 }],
      [{ start: 3, end: 14, mentionIndex: 0.5 }]
    ];
    for (const candidate of invalid) expect(validInputMentionRanges(text, mentions, candidate), JSON.stringify(candidate)).toBe(false);
    expect(validInputMentionRanges(text, mentions, ranges, [{ start: 13, end: 15, display: "overlap" }])).toBe(false);
    expect(validInputMentionRanges(text, mentions, ranges, [{ start: 0, end: 1, display: "split" }])).toBe(false);
  });
});
