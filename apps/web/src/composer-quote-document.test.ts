import { describe, expect, it } from "vitest";
import {
  appendQuoteToComposerDocument,
  appendTextToComposerDocument,
  composerDocumentFromEditedEncodedMessage,
  composerDocumentFromEncodedMessage,
  composerDocumentFromMessage,
  composerDocumentIsEmpty,
  composerDocumentPlainText,
  composerDocumentQuotes,
  emptyComposerDocument,
  joinComposerDocuments,
  normalizeComposerDocument,
  plainTextToComposerDocument,
  serializeComposerDocument
} from "./composer-quote-document.js";

const source = { sessionId: "session-one", messageId: "user-one", sourceEventId: "event-one", role: "user" as const };

describe("composer quote documents", () => {
  it("joins a rejected send snapshot before newer input without flattening either document", () => {
    const sent = appendQuoteToComposerDocument(plainTextToComposerDocument("first"), {
      id: "quote-one", kind: "message", text: "evidence", sessionId: "session-one", messageId: "assistant-one", role: "assistant"
    });
    const merged = joinComposerDocuments(sent, plainTextToComposerDocument("typed while sending"));

    expect(composerDocumentPlainText(merged)).toBe("first\n\ntyped while sending");
    expect(composerDocumentQuotes(merged).map((quote) => quote.id)).toEqual(["quote-one"]);
    expect(serializeComposerDocument(merged).text).toContain("typed while sending");
  });

  it("serializes text, quote, and text in their exact inline order", () => {
    const withQuote = appendQuoteToComposerDocument(plainTextToComposerDocument("before"), {
      id: "quote-one",
      kind: "message",
      text: "selected\n\nlines",
      sessionId: "session-one",
      messageId: "assistant-one",
      role: "assistant"
    });
    const document = appendTextToComposerDocument(withQuote, "after");

    expect(serializeComposerDocument(document)).toEqual({
      text: [
        "before",
        "",
        "> <!-- joko-selection-quote -->",
        "> selected",
        ">",
        "> lines",
        "",
        "after"
      ].join("\n"),
      quotesEncoded: true
    });
    expect(composerDocumentPlainText(document)).toBe("before\nafter");
  });

  it("supports multiple adjacent quote atoms and quote-only drafts", () => {
    let document = emptyComposerDocument();
    document = appendQuoteToComposerDocument(document, {
      id: "one", kind: "message", text: "first", sessionId: "session-one", messageId: "assistant-one", role: "assistant"
    });
    document = appendQuoteToComposerDocument(document, {
      id: "two", kind: "message", text: "second", sessionId: "session-one", messageId: "user-two", role: "user"
    });

    expect(composerDocumentIsEmpty(document)).toBe(false);
    expect(composerDocumentQuotes(document).map((quote) => [quote.id, quote.kind === "message" ? quote.role : undefined])).toEqual([
      ["one", "assistant"],
      ["two", "user"]
    ]);
    expect(serializeComposerDocument(document).text).toBe([
      "> <!-- joko-selection-quote -->",
      "> first",
      "",
      "> <!-- joko-selection-quote -->",
      "> second"
    ].join("\n"));
  });

  it("round-trips marked interleaving for history and edit recovery", () => {
    const encoded = [
      "before",
      "",
      "> <!-- joko-selection-quote -->",
      "> selected",
      "",
      "after"
    ].join("\n");
    const restored = composerDocumentFromEncodedMessage(encoded, source, "history");
    expect(serializeComposerDocument(restored)).toEqual({ text: encoded, quotesEncoded: true });

    const edited = composerDocumentFromEditedEncodedMessage(encoded, "changed before\n\nchanged after", source, "edit");
    expect(serializeComposerDocument(edited).text).toBe([
      "changed before",
      "",
      "> <!-- joko-selection-quote -->",
      "> selected",
      "",
      "changed after"
    ].join("\n"));
  });

  it("drops malformed quote attrs and unsupported nodes when restoring persisted JSON", () => {
    expect(normalizeComposerDocument({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "safe" },
          { type: "composerQuote", attrs: { id: "bad\nid", text: "hidden", sessionId: "s", messageId: "m", role: "assistant" } },
          { type: "image", attrs: { src: "https://invalid.example" } }
        ]
      }]
    })).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "safe" }] }] });
  });

  it("retains TipTap's nullable optional source-event attribute", () => {
    const normalized = normalizeComposerDocument({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "composerQuote",
          attrs: {
            id: "quote-one",
            kind: "message",
            text: "selected",
            sessionId: "session-one",
            messageId: "assistant-one",
            sourceEventId: null,
            role: "assistant"
          }
        }]
      }]
    });
    expect(composerDocumentQuotes(normalized)).toEqual([{
      id: "quote-one",
      kind: "message",
      text: "selected",
      sessionId: "session-one",
      messageId: "assistant-one",
      role: "assistant"
    }]);
  });

  it("round-trips message and file atoms in exact text → quote → text order", () => {
    let document = plainTextToComposerDocument("before");
    document = appendQuoteToComposerDocument(document, {
      id: "file-one",
      kind: "file",
      text: "    first\nsecond",
      sessionId: "session-one",
      sourcePath: "src/example.ts",
      startLine: 7,
      endLine: 8
    });
    document = appendTextToComposerDocument(document, "between");
    document = appendQuoteToComposerDocument(document, {
      id: "message-two",
      kind: "message",
      text: "reply",
      sessionId: "session-one",
      messageId: "assistant-two",
      role: "assistant"
    });
    document = appendTextToComposerDocument(document, "after");

    const encoded = serializeComposerDocument(document);
    expect(encoded).toEqual({
      quotesEncoded: true,
      text: [
        "before",
        "",
        "> <!-- joko-selection-quote -->",
        ">     first",
        "> second",
        "> — source: src/example.ts#L7-L8",
        "",
        "between",
        "",
        "> <!-- joko-selection-quote -->",
        "> reply",
        "",
        "after"
      ].join("\n")
    });

    const restored = composerDocumentFromEncodedMessage(encoded.text, source, "history");
    expect(serializeComposerDocument(restored)).toEqual(encoded);
    expect(composerDocumentQuotes(restored)).toEqual([
      {
        id: "history:quote:user-one:0",
        kind: "file",
        text: "    first\nsecond",
        sessionId: "session-one",
        sourcePath: "src/example.ts",
        startLine: 7,
        endLine: 8
      },
      {
        id: "history:quote:user-one:1",
        kind: "message",
        text: "reply",
        sessionId: "session-one",
        messageId: "user-one",
        sourceEventId: "event-one",
        role: "user"
      }
    ]);
  });

  it("drops file atoms with traversal paths, unsafe lines, or forged message identity", () => {
    const document = normalizeComposerDocument({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "composerQuote", attrs: { id: "traversal", kind: "file", text: "x", sessionId: "s", sourcePath: "../secret", startLine: 1, endLine: 1 } },
          { type: "composerQuote", attrs: { id: "range", kind: "file", text: "x", sessionId: "s", sourcePath: "src/a.ts", startLine: 9, endLine: 2 } },
          { type: "composerQuote", attrs: { id: "forged", kind: "file", text: "x", sessionId: "s", sourcePath: "src/a.ts", messageId: "message", role: "assistant" } }
        ]
      }]
    });
    expect(composerDocumentQuotes(document)).toEqual([]);
  });

  it("projects exact pasted-text ranges after wire trimming and ordinary prose", () => {
    const text = "first\nsecond";
    const serialized = serializeComposerDocument({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "  before " },
          { type: "composerPastedText", attrs: { text, display: "Pasted text (2 lines)" } },
          { type: "text", text: " after  " }
        ]
      }]
    });
    expect(serialized.text).toBe(`before ${text} after`);
    expect(serialized.pastedTextRanges).toEqual([{
      start: "before ".length,
      end: "before ".length + text.length,
      display: "Pasted text (2 lines)"
    }]);
    expect(serialized.text.slice(serialized.pastedTextRanges![0]!.start, serialized.pastedTextRanges![0]!.end)).toBe(text);
  });

  it("keeps multiple pasted ranges precise across quote block separators", () => {
    const serialized = serializeComposerDocument({
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "composerPastedText", attrs: { text: "alpha", display: "Pasted text A" } },
          { type: "composerQuote", attrs: { id: "q", kind: "message", text: "quoted", sessionId: "s", messageId: "m", role: "assistant" } },
          { type: "composerPastedText", attrs: { text: "omega", display: "Pasted text B" } }
        ]
      }]
    });
    expect(serialized.pastedTextRanges?.map((range) => serialized.text.slice(range.start, range.end))).toEqual(["alpha", "omega"]);
  });

  it("includes generated continuation indentation in a pasted list range", () => {
    const serialized = serializeComposerDocument({
      type: "doc",
      content: [{
        type: "orderedList",
        attrs: { start: 12, marker: ")", separator: " " },
        content: [{
          type: "listItem",
          content: [{
            type: "paragraph",
            content: [{ type: "composerPastedText", attrs: { text: "line one\nline two", display: "Pasted text (2 lines)" } }]
          }]
        }]
      }]
    });
    expect(serialized.text).toBe("12) line one\n    line two");
    expect(serialized.pastedTextRanges).toEqual([{
      start: 4,
      end: serialized.text.length,
      display: "Pasted text (2 lines)"
    }]);
  });

  it("restores persisted pasted ranges into editable atoms for history and fork drafts", () => {
    const pasted = "first\nsecond\nthird";
    const text = `before ${pasted} after`;
    const start = text.indexOf(pasted);
    const ranges = [{ start, end: start + pasted.length, display: "Pasted text (3 lines)" }];
    const restored = composerDocumentFromMessage(text, false, source, "history", ranges);
    expect(serializeComposerDocument(restored)).toEqual({ text, quotesEncoded: false, pastedTextRanges: ranges });
  });

  it("keeps pasted atoms on an unchanged quote edit and drops stale offsets after a text edit", () => {
    const body = "before\nfirst\nsecond\nafter";
    const encoded = `> <!-- joko-selection-quote -->\n> selected\n\n${body}`;
    const pasted = "first\nsecond";
    const start = encoded.indexOf(pasted);
    const ranges = [{ start, end: start + pasted.length, display: "Pasted text (2 lines)" }];
    expect(serializeComposerDocument(composerDocumentFromEditedEncodedMessage(encoded, body, source, "edit", ranges))).toEqual({
      text: encoded,
      quotesEncoded: true,
      pastedTextRanges: ranges
    });
    expect(serializeComposerDocument(composerDocumentFromEditedEncodedMessage(encoded, `${body}!`, source, "edit", ranges))).not.toHaveProperty("pastedTextRanges");
  });
});
