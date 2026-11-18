import { describe, expect, it } from "vitest";
import { emptyMobileComposerDraft } from "./mobile-composer-document";
import { captureMobileQuoteSelection, commitMobileQuoteSelection, readNativeMessageSelection } from "./mobile-composer-quote";
import type { TimelineRow } from "./timeline";

function assistantRow(text = "Alpha 👋 omega"): TimelineRow {
  return {
    id: "message",
    eventId: "complete",
    label: "Assistant",
    text,
    sequence: 4n,
    kind: "assistant",
    completed: true,
    quoteSource: { sourceMessageId: "message", sourceEventId: "complete", text }
  };
}

describe("mobile assistant selection quote", () => {
  it("freezes exact message identity and appends only the selected Unicode-safe text", () => {
    const row = assistantRow();
    const lease = captureMobileQuoteSelection("task", row)!;
    const result = commitMobileQuoteSelection({
      lease,
      currentSessionId: "task",
      latestRow: row,
      selection: { start: 6, end: 8 },
      draft: emptyMobileComposerDraft(),
      atomId: "quote"
    });
    expect(result.draft.atoms).toEqual([{
      kind: "quote",
      atomId: "quote",
      sourceSessionId: "task",
      sourceMessageId: "message",
      sourceEventId: "complete",
      sourceRole: "assistant",
      text: "👋",
      start: 0,
      end: 22
    }]);
  });

  it("fails closed for row drift, ineligible messages, split surrogates, empty text, and oversized selections", () => {
    const row = assistantRow();
    const lease = captureMobileQuoteSelection("task", row)!;
    const input = {
      lease,
      currentSessionId: "task",
      latestRow: row,
      draft: emptyMobileComposerDraft(),
      atomId: "quote"
    };
    expect(() => commitMobileQuoteSelection({ ...input, latestRow: assistantRow("changed"), selection: { start: 0, end: 1 } }))
      .toThrow(/changed/u);
    expect(() => commitMobileQuoteSelection({ ...input, selection: { start: 7, end: 8 } }))
      .toThrow(/Unicode/u);
    expect(() => commitMobileQuoteSelection({ ...input, selection: { start: 0, end: 0 } }))
      .toThrow(/Select/u);
    const longRow = assistantRow("x".repeat(4_001));
    const longLease = captureMobileQuoteSelection("task", longRow)!;
    expect(() => commitMobileQuoteSelection({
      ...input,
      lease: longLease,
      latestRow: longRow,
      selection: { start: 0, end: 4_001 }
    })).toThrow(/at most 4,000/u);
    expect(captureMobileQuoteSelection("task", { ...row, kind: "user" })).toBeUndefined();
    expect(captureMobileQuoteSelection("task", { ...row, completed: false })).toBeUndefined();
    expect(captureMobileQuoteSelection("task", { ...row, quoteSource: undefined })).toBeUndefined();
  });
});

describe("selection on the original timeline text", () => {
  it.each(["user", "assistant"] as const)("adopts only the native selection from the current %s message", (kind) => {
    const current = assistantRow();
    const row = kind === "user" ? { ...current, kind, label: "You", sourceText: current.text, quoteSource: undefined } : current;
    const lease = captureMobileQuoteSelection("task", row, "timeline")!;
    const selected = { registration: "mounted-text", start: 6, end: 8, text: "👋" };
    const selection = readNativeMessageSelection(selected, "mounted-text", row.text)!;
    expect(selection).toEqual({ start: 6, end: 8 });
    expect(readNativeMessageSelection(selected, "retired-text", row.text)).toBeUndefined();
    expect(readNativeMessageSelection({ ...selected, end: 7, text: row.text.slice(6, 7) }, "mounted-text", row.text)).toBeUndefined();
    expect(readNativeMessageSelection({ ...selected, text: "changed" }, "mounted-text", row.text)).toBeUndefined();
    const input = { lease, selection, currentSessionId: "task", latestRow: row,
      draft: emptyMobileComposerDraft(), atomId: "native-quote" };
    expect(commitMobileQuoteSelection(input).draft.atoms).toMatchObject([{ sourceRole: kind, text: "👋",
      sourceMessageId: row.id, sourceEventId: row.eventId }]);
    expect(() => commitMobileQuoteSelection({ ...input, latestRow: { ...row, eventId: "replaced" } })).toThrow(/changed/u);
    expect(captureMobileQuoteSelection("task", { ...row, text: `**${row.text}**` }, "timeline")).toBeUndefined();
  });
});
