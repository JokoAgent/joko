import { describe, expect, it } from "vitest";

import {
  normalizeWorkspaceFileSource,
  WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS,
  workspaceFileQuoteFromOffsets
} from "./workspace-file-selection.js";

describe("workspace file selection quotes", () => {
  it("preserves indentation and internal blank lines with a closed line range", () => {
    const source = "before\n    first\n\n      third\nafter";
    const start = source.indexOf("    first");
    const end = source.indexOf("\nafter");
    expect(workspaceFileQuoteFromOffsets(source, start, end)).toEqual({
      text: "    first\n\n      third",
      startLine: 2,
      endLine: 4
    });
  });

  it("handles reverse selections and removes only outer newlines", () => {
    const source = "zero\n\n  one\n two\n\nlast";
    const start = source.indexOf("\n\n  one");
    const end = source.lastIndexOf("\nlast") + 1;
    expect(workspaceFileQuoteFromOffsets(source, end, start)).toEqual({
      text: "  one\n two",
      startLine: 3,
      endLine: 4
    });
  });

  it("attributes a selection ending at the next line's column zero to the preceding line", () => {
    const source = "alpha\nbeta\ngamma";
    expect(workspaceFileQuoteFromOffsets(source, 0, source.indexOf("beta"))).toEqual({
      text: "alpha",
      startLine: 1,
      endLine: 1
    });
  });

  it("rejects newline-only, whitespace-only, collapsed, and invalid offsets", () => {
    expect(workspaceFileQuoteFromOffsets("a\n\nb", 1, 3)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("a   b", 1, 4)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("text", 2, 2)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("text", -1, 2)).toBeUndefined();
    expect(workspaceFileQuoteFromOffsets("text", 0, 8)).toBeUndefined();
  });

  it("normalizes CRLF before applying DOM-equivalent UTF-16 offsets", () => {
    const source = normalizeWorkspaceFileSource("first\r\nsecond\rthird");
    expect(source).toBe("first\nsecond\nthird");
    expect(workspaceFileQuoteFromOffsets(source, 6, 12)).toEqual({
      text: "second",
      startLine: 2,
      endLine: 2
    });
  });

  it("truncates only the visible text while preserving the complete selection range", () => {
    const source = `${"x".repeat(WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS + 20)}\nlast`;
    const quote = workspaceFileQuoteFromOffsets(source, 0, source.length);
    expect(quote?.text).toBe(`${"x".repeat(WORKSPACE_FILE_QUOTE_MAXIMUM_CHARACTERS)}…`);
    expect(quote?.startLine).toBe(1);
    expect(quote?.endLine).toBe(2);
  });
});
