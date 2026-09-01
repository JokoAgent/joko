import { describe, expect, it } from "vitest";

import { validInlineTextRanges } from "./types.js";

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
