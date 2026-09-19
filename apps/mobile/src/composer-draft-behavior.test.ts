import { describe, expect, it } from "vitest";
import { addToMobileComposer, changeMobileComposerText } from "./composer-draft-behavior";

describe("mobile composer draft and queue edit separation", () => {
  it("persists ordinary composer changes including an explicit clear", () => {
    expect(changeMobileComposerText(false, "draft")).toEqual({
      visibleText: "draft", normalDraftToPersist: "draft"
    });
    expect(changeMobileComposerText(false, "").normalDraftToPersist).toBe("");
  });

  it("never presents a queued-input edit as the normal draft to persist", () => {
    expect(changeMobileComposerText(true, "edited queued body")).toEqual({
      visibleText: "edited queued body", normalDraftToPersist: null
    });
  });

  it("adds a message to the stashed normal draft without replacing the visible queue edit", () => {
    expect(addToMobileComposer({
      visibleText: "queued body",
      queueStashedDraft: "normal draft",
      addition: "quoted completion"
    })).toEqual({
      visibleText: "queued body",
      normalDraft: "normal draft\n\nquoted completion",
      queueStashedDraft: "normal draft\n\nquoted completion"
    });
  });
});
