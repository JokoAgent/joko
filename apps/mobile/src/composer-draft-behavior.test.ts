import { describe, expect, it } from "vitest";
import { addToMobileComposer, changeMobileComposerText } from "./composer-draft-behavior";
import { insertMobileSessionMention, plainTextMobileComposerDraft } from "./mobile-composer-document";

describe("mobile composer draft and queue edit separation", () => {
  it("persists ordinary composer changes including an explicit clear", () => {
    expect(changeMobileComposerText(false, plainTextMobileComposerDraft(""), "draft")).toEqual({
      visibleDraft: plainTextMobileComposerDraft("draft"),
      normalDraftToPersist: plainTextMobileComposerDraft("draft")
    });
    expect(changeMobileComposerText(false, plainTextMobileComposerDraft("draft"), "").normalDraftToPersist)
      .toEqual(plainTextMobileComposerDraft(""));
  });

  it("never presents a queued-input edit as the normal draft to persist", () => {
    expect(changeMobileComposerText(true, plainTextMobileComposerDraft("queued"), "edited queued body")).toEqual({
      visibleDraft: plainTextMobileComposerDraft("edited queued body"), normalDraftToPersist: null
    });
  });

  it("adds a message to the structured stashed draft without replacing the visible queue edit", () => {
    const normal = insertMobileSessionMention(
      plainTextMobileComposerDraft("Ask "),
      { start: 4, end: 4 },
      { sessionId: "source", displayText: "Task" },
      "mention"
    ).draft;
    expect(addToMobileComposer({
      visibleDraft: plainTextMobileComposerDraft("queued body"),
      queueStashedDraft: normal,
      addition: "quoted completion"
    })).toEqual({
      visibleDraft: plainTextMobileComposerDraft("queued body"),
      normalDraft: { text: "Ask @Task\n\nquoted completion", mentions: normal.mentions, attachments: [] },
      queueStashedDraft: { text: "Ask @Task\n\nquoted completion", mentions: normal.mentions, attachments: [] }
    });
  });
});
