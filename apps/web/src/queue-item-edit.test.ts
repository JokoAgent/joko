import { describe, expect, it } from "vitest";
import type { QueueItemView } from "./model.js";
import { queueItemEditProjection, remapQueueItemTextEdit } from "./queue-item-edit.js";

function item(overrides: Partial<QueueItemView> = {}): QueueItemView {
  return {
    id: "queue", sessionId: "task", revision: 1n, generation: 1n,
    source: "user", mode: "followUp", text: "before @report after",
    state: "accepted", editLocked: false, ordinal: 0, createdAt: 1,
    ...overrides
  };
}

describe("queued input text editing", () => {
  it("removes only private quote markers and shifts exact ranges", () => {
    const text = "> <!-- joko-selection-quote -->\n> quoted\n\nuse @report";
    const start = text.indexOf("@report");
    expect(queueItemEditProjection(item({
      text,
      quotesEncoded: true,
      mentionRanges: [{ start, end: start + 7, mentionIndex: 0 }],
      pastedTextRanges: [{ start: text.indexOf("quoted"), end: text.indexOf("quoted") + 6, display: "Pasted" }]
    }))).toEqual({
      text: "> quoted\n\nuse @report",
      mentionRanges: [{ start: 14, end: 21, mentionIndex: 0 }],
      pastedTextRanges: [{ start: 2, end: 8, display: "Pasted" }],
      textSplices: [{ start: 0, end: text.indexOf("\n") + 1, replacementText: "" }]
    });
  });

  it("shifts untouched atoms and removes only ranges intersected by the edit", () => {
    const initial = {
      text: "before @report after PASTE",
      mentionRanges: [{ start: 7, end: 14, mentionIndex: 0 }],
      pastedTextRanges: [{ start: 21, end: 26, display: "Pasted" }],
      textSplices: []
    } as const;
    expect(remapQueueItemTextEdit(initial, "new before @report after PASTE", {
      selectionStart: 0, selectionEnd: 0, inputType: "insertText"
    })).toEqual({
      text: "new before @report after PASTE",
      mentionRanges: [{ start: 11, end: 18, mentionIndex: 0 }],
      pastedTextRanges: [{ start: 25, end: 30, display: "Pasted" }],
      textSplices: [{ start: 0, end: 0, replacementText: "new " }]
    });
    expect(remapQueueItemTextEdit(initial, "before report after PASTE", {
      selectionStart: 7, selectionEnd: 8, inputType: "deleteContentForward"
    })).toEqual({
      text: "before report after PASTE",
      mentionRanges: [],
      pastedTextRanges: [{ start: 20, end: 25, display: "Pasted" }],
      textSplices: [{ start: 7, end: 8, replacementText: "" }]
    });
  });

  it("uses the captured selection instead of guessing between identical labels", () => {
    const initial = {
      text: "@same @same",
      mentionRanges: [
        { start: 0, end: 5, mentionIndex: 0 },
        { start: 6, end: 11, mentionIndex: 1 }
      ],
      pastedTextRanges: [],
      textSplices: []
    } as const;
    expect(remapQueueItemTextEdit(initial, "@same", {
      selectionStart: 0, selectionEnd: 6, inputType: "deleteContentForward"
    })).toEqual({
      text: "@same",
      mentionRanges: [{ start: 0, end: 5, mentionIndex: 1 }],
      pastedTextRanges: [],
      textSplices: [{ start: 0, end: 6, replacementText: "" }]
    });
    expect(remapQueueItemTextEdit(initial, "@same")).toEqual({
      text: "@same",
      mentionRanges: [],
      pastedTextRanges: [],
      textSplices: [{ start: 0, end: 11, replacementText: "@same" }]
    });
  });

  it("revokes an occurrence replaced with identical display text", () => {
    const initial = {
      text: "@same @same",
      mentionRanges: [
        { start: 0, end: 5, mentionIndex: 0 },
        { start: 6, end: 11, mentionIndex: 1 }
      ],
      pastedTextRanges: [],
      textSplices: []
    } as const;
    expect(remapQueueItemTextEdit(initial, initial.text, {
      selectionStart: 0,
      selectionEnd: 5,
      inputType: "insertReplacementText"
    })).toEqual({
      text: initial.text,
      mentionRanges: [{ start: 6, end: 11, mentionIndex: 1 }],
      pastedTextRanges: [],
      textSplices: [{ start: 0, end: 5, replacementText: "@same" }]
    });
  });
});
