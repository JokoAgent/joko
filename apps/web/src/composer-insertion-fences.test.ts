import { describe, expect, it } from "vitest";

import { fileAttachmentInsertionFor } from "./file-attachment-insertion.js";
import { fileSelectionQuoteInsertionFor } from "./file-selection-quote-insertion.js";
import type { ComposerFileSelectionQuoteDraft } from "./model.js";

const quote: ComposerFileSelectionQuoteDraft = {
  id: "quote-1",
  kind: "file",
  sessionId: "session-a",
  sourcePath: "src/editor.ts",
  text: "const answer = 42;",
  startLine: 7,
  endLine: 7
};

describe("task-scoped composer insertions", () => {
  it("accepts image and file-quote insertions only for the active producer task", () => {
    const image = new File([new Uint8Array([1, 2, 3])], "diagram.png", { type: "image/png" });
    expect(fileAttachmentInsertionFor(2, "session-a", "session-a", image))
      .toEqual({ id: 2, sessionId: "session-a", file: image });
    expect(fileAttachmentInsertionFor(2, "session-b", "session-a", image)).toBeUndefined();

    expect(fileSelectionQuoteInsertionFor(3, "session-a", "session-a", quote))
      .toEqual({ id: 3, sessionId: "session-a", quote });
    expect(fileSelectionQuoteInsertionFor(4, "session-b", "session-a", quote)).toBeUndefined();
    expect(fileSelectionQuoteInsertionFor(4, undefined, "session-a", quote)).toBeUndefined();
  });

  it("rejects invalid identities, wrong media, mismatched quote ownership, and unsafe paths", () => {
    const text = new File(["text"], "notes.txt", { type: "text/plain" });
    expect(fileAttachmentInsertionFor(0, "session-a", "session-a", text)).toBeUndefined();
    expect(fileAttachmentInsertionFor(1, "session-a", "session-a", text)).toBeUndefined();
    expect(fileSelectionQuoteInsertionFor(0, "session-a", "session-a", quote)).toBeUndefined();
    expect(fileSelectionQuoteInsertionFor(1, "session-a", "session-a", { ...quote, sessionId: "session-b" })).toBeUndefined();
    expect(fileSelectionQuoteInsertionFor(1, "session-a", "session-a", { ...quote, sourcePath: "../secret" })).toBeUndefined();
  });
});
