import { describe, expect, it } from "vitest";
import {
  canonicalSelectionQuoteSourcePath,
  normalizeSelectionQuoteDrafts,
  parseSelectionQuoteMessage,
  selectionQuoteModelText,
  SELECTION_QUOTE_MAX_CHARS,
  visibleSelectionQuoteMessageText
} from "./selection-quote.js";

const messageQuote = {
  id: "quote-one",
  kind: "message" as const,
  text: "first\n\n<script>literal text only</script>",
  sessionId: "session-one",
  messageId: "message-two",
  sourceEventId: "event-three",
  role: "assistant" as const
};

describe("structured selection quotes", () => {
  it("normalizes bounded message identity and uses the marked Markdown wire format", () => {
    const quotes = normalizeSelectionQuoteDrafts([messageQuote]);
    expect(quotes).toHaveLength(1);
    expect(selectionQuoteModelText(quotes[0]!)).toBe([
      "> <!-- joko-selection-quote -->",
      "> first",
      ">",
      "> <script>literal text only</script>"
    ].join("\n"));
  });

  it("writes and parses exact file sources with no line, one line, or a range", () => {
    const base = { id: "file", kind: "file" as const, text: "selected", sessionId: "session", sourcePath: "docs/x.md" };
    expect(selectionQuoteModelText(base)).toBe([
      "> <!-- joko-selection-quote -->",
      "> selected",
      "> — source: docs/x.md"
    ].join("\n"));
    expect(selectionQuoteModelText({ ...base, id: "one-line", startLine: 12, endLine: 12 })).toContain("> — source: docs/x.md#L12");
    const ranged = selectionQuoteModelText({ ...base, id: "range", startLine: 12, endLine: 18 });
    expect(ranged).toContain("> — source: docs/x.md#L12-L18");
    expect(parseSelectionQuoteMessage(`${ranged}\n\nfix it`, true)).toEqual({
      quotes: [{ kind: "file", text: "selected", sourcePath: "docs/x.md", startLine: 12, endLine: 18 }],
      segments: [
        { kind: "quote", quote: { kind: "file", text: "selected", sourcePath: "docs/x.md", startLine: 12, endLine: 18 } },
        { kind: "text", text: "fix it" }
      ],
      body: "fix it"
    });
  });

  it("prefixes multiple quotes and preserves their interleaved document order", () => {
    const source = [
      { id: "one", kind: "message", text: "a\n\nb", sessionId: "session", messageId: "m1", role: "assistant" },
      { id: "two", kind: "file", text: "c", sessionId: "session", sourcePath: "src/c.ts", startLine: 3, endLine: 4 }
    ] as const;
    const encoded = `${source.map((quote) => selectionQuoteModelText(quote)).join("\n\n")}\n\nreply\n\n> typed by the user`;
    const parsed = parseSelectionQuoteMessage(encoded, true);
    expect(parsed.quotes).toEqual([
      { kind: "message", text: "a\n\nb" },
      { kind: "file", text: "c", sourcePath: "src/c.ts", startLine: 3, endLine: 4 }
    ]);
    expect(parsed.body).toBe("reply\n\n> typed by the user");
    expect(parsed.segments).toEqual([
      { kind: "quote", quote: { kind: "message", text: "a\n\nb" } },
      { kind: "quote", quote: { kind: "file", text: "c", sourcePath: "src/c.ts", startLine: 3, endLine: 4 } },
      { kind: "text", text: "reply\n\n> typed by the user" }
    ]);
    const ordinary = parseSelectionQuoteMessage("> ordinary\n\nbody");
    expect(ordinary.quotes).toEqual([]);
    expect(ordinary.body).toBe("> ordinary\n\nbody");
  });

  it("validates bounded canonical paths and rejects visual or traversal deception", () => {
    expect(canonicalSelectionQuoteSourcePath("src/features/a.ts")).toBe("src/features/a.ts");
    for (const path of [
      "",
      "/etc/passwd",
      "C:/secret.txt",
      "C:secret.txt",
      "src\\a.ts",
      "src//a.ts",
      "src/./a.ts",
      "src/../a.ts",
      "src/a\u0000.ts",
      "src/a\u2028.ts",
      "src/\u202efile.ts",
      "src/\u2066file.ts"
    ]) expect(canonicalSelectionQuoteSourcePath(path)).toBeUndefined();
  });

  it("rejects unsafe file line metadata and never accepts forged message fields", () => {
    const base = { id: "file", kind: "file", text: "selected", sessionId: "session", sourcePath: "src/a.ts" };
    expect(normalizeSelectionQuoteDrafts([
      { ...base, startLine: 0, endLine: 1 },
      { ...base, id: "reverse", startLine: 8, endLine: 7 },
      { ...base, id: "fraction", startLine: 1.5, endLine: 2 },
      { ...base, id: "unsafe", startLine: Number.MAX_SAFE_INTEGER + 1, endLine: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, id: "end-only", endLine: 2 },
      { ...base, id: "forged", messageId: "message", role: "assistant" }
    ])).toEqual([]);
    expect(normalizeSelectionQuoteDrafts([{ ...base, id: "single", startLine: 9 }])).toEqual([
      { ...base, id: "single", startLine: 9, endLine: 9 }
    ]);
  });

  it("preserves indentation, normalizes CRLF, strips outer newlines, and truncates once", () => {
    const normalized = normalizeSelectionQuoteDrafts([{
      id: "file",
      kind: "file",
      text: `\r\n    first\r\n${"x".repeat(SELECTION_QUOTE_MAX_CHARS + 20)}\r\n`,
      sessionId: "session",
      sourcePath: "src/a.ts",
      startLine: 2,
      endLine: 3
    }])[0];
    expect(normalized?.text.startsWith("    first\n")).toBe(true);
    expect(normalized?.text.endsWith("…")).toBe(true);
    expect(normalized?.text.length).toBe(SELECTION_QUOTE_MAX_CHARS + 1);
    expect(selectionQuoteModelText(normalized!)).toContain(">     first\n");
  });

  it("drops malformed identities, duplicate rows, and drafts without an explicit kind", () => {
    const current = { id: "same", kind: "message", text: "selected", sessionId: "session", messageId: "message", role: "assistant" };
    expect(normalizeSelectionQuoteDrafts([current, current, { ...current, id: "bad\nidentity" }])).toEqual([current]);
    expect(normalizeSelectionQuoteDrafts([{ ...current, kind: undefined }])).toEqual([]);
    expect(normalizeSelectionQuoteDrafts([{ ...current, sourceEventId: null }])).toEqual([current]);
  });

  it("does not infer structured quotes from markerless blockquote text", () => {
    const typed = "> quoted prose\n> — source: docs/example.md#L4-L6\n\nbody";
    expect(parseSelectionQuoteMessage(typed, true)).toEqual({
      quotes: [],
      segments: [{ kind: "text", text: typed }],
      body: typed
    });
  });

  it("keeps a malformed or malicious source-looking line inside quote text", () => {
    const encoded = "> <!-- joko-selection-quote -->\n> selected\n> — source: ../secret#L9-L2";
    expect(parseSelectionQuoteMessage(encoded, true).quotes).toEqual([{
      kind: "message",
      text: "selected\n— source: ../secret#L9-L2"
    }]);
  });

  it("removes markers only behind durable product truth", () => {
    const encoded = `${selectionQuoteModelText(messageQuote)}\n\nreply`;
    expect(visibleSelectionQuoteMessageText(encoded, true)).toContain("> first");
    const typed = "> <!-- joko-selection-quote -->\n> this is ordinary typed text\n\nreply";
    expect(parseSelectionQuoteMessage(typed, false)).toMatchObject({ quotes: [], body: typed });
    expect(visibleSelectionQuoteMessageText(typed, false)).toBe(typed);
  });

  it("keeps marked quotes interleaved with prose in document order", () => {
    const encoded = [
      "before",
      "",
      "> <!-- joko-selection-quote -->",
      "> first",
      "",
      "between",
      "",
      "> <!-- joko-selection-quote -->",
      "> second",
      "",
      "after"
    ].join("\n");
    expect(parseSelectionQuoteMessage(encoded, true).segments).toEqual([
      { kind: "text", text: "before" },
      { kind: "quote", quote: { kind: "message", text: "first" } },
      { kind: "text", text: "between" },
      { kind: "quote", quote: { kind: "message", text: "second" } },
      { kind: "text", text: "after" }
    ]);
  });
});
