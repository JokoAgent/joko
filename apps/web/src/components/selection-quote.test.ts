import { describe, expect, it } from "vitest";
import { boundedTimelineSelectionText, TIMELINE_SELECTION_QUOTE_MAX_CHARS } from "./SelectionQuoteButton.js";

describe("timeline selection quotes", () => {
  it("preserves indentation, strips only outer newlines, and bounds selected text", () => {
    expect(boundedTimelineSelectionText("\n  const value = 1;\n")).toBe("  const value = 1;");
    expect(boundedTimelineSelectionText(" \n ")).toBeUndefined();
    const bounded = boundedTimelineSelectionText("x".repeat(TIMELINE_SELECTION_QUOTE_MAX_CHARS + 20));
    expect(bounded).toBe(`${"x".repeat(TIMELINE_SELECTION_QUOTE_MAX_CHARS)}…`);
  });
});
