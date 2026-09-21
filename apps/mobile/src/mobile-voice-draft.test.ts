import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  insertMobilePastedText,
  insertMobileSessionMention,
  markMobileComposerSlashCommand,
  mobileComposerDraftsEqual,
  plainTextMobileComposerDraft
} from "./mobile-composer-document";
import { applyMobileVoiceTranscript, rollbackMobileVoiceTranscript } from "./mobile-voice-draft";

describe("mobile voice draft projection", () => {
  it("replaces only the selected structured range and restores its exact mention on cancellation", () => {
    const base = insertMobileSessionMention(
      plainTextMobileComposerDraft("Review "),
      { start: 7, end: 7 },
      { sessionId: "source-task", displayText: "Earlier task" },
      "voice-overlap-mention"
    ).draft;
    const mention = base.mentions[0]!;
    const partial = applyMobileVoiceTranscript(
      base,
      { start: mention.start, end: mention.end },
      undefined,
      "  dictated words  ",
      false,
      "draft-one"
    );

    expect(partial.draft?.text).toBe("Review dictated words");
    expect(partial.draft?.mentions).toEqual([]);
    expect(partial.context).toMatchObject({
      draftOwnerKey: "draft-one",
      insertion: { start: 7, end: 21, text: "dictated words" },
      persisted: false
    });

    const stable = applyMobileVoiceTranscript(
      partial.draft!,
      partial.selection!,
      partial.context,
      "final words",
      true,
      "draft-one"
    );
    expect(stable.draft?.text).toBe("Review final words");
    expect(stable.context?.persisted).toBe(true);

    const restored = rollbackMobileVoiceTranscript(stable.draft!, stable.context!);
    expect(restored).toBeDefined();
    expect(mobileComposerDraftsEqual(restored!.draft, base)).toBe(true);
  });

  it("does not erase a selection for an empty partial or overwrite an externally changed insertion", () => {
    const base = plainTextMobileComposerDraft("Keep this text");
    expect(applyMobileVoiceTranscript(base, { start: 0, end: 4 }, undefined, "  ", false, "draft-one"))
      .toEqual({});

    const partial = applyMobileVoiceTranscript(base, { start: 5, end: 9 }, undefined, "voice", false, "draft-one");
    const externallyChanged = plainTextMobileComposerDraft("Keep edited text");
    const late = applyMobileVoiceTranscript(
      externallyChanged,
      { start: externallyChanged.text.length, end: externallyChanged.text.length },
      partial.context,
      "late result",
      true,
      "draft-one"
    );
    expect(late).toEqual({});
    expect(rollbackMobileVoiceTranscript(externallyChanged, partial.context!)).toBeUndefined();
  });

  it("restores an exact pasted-text atom when a cancellable transcript replaced its token", () => {
    const base = insertMobilePastedText(
      plainTextMobileComposerDraft("Before "),
      { start: 7, end: 7 },
      "line\n".repeat(24),
      "paste"
    ).draft;
    const atom = base.atoms[0]!;
    const partial = applyMobileVoiceTranscript(
      base,
      { start: atom.start, end: atom.end },
      undefined,
      "dictated",
      false,
      "draft-one"
    );
    expect(partial.draft?.atoms).toEqual([]);
    expect(partial.context?.rollbackAtoms).toHaveLength(1);
    const restored = rollbackMobileVoiceTranscript(partial.draft!, partial.context!);
    expect(restored).toBeDefined();
    expect(mobileComposerDraftsEqual(restored!.draft, base)).toBe(true);
  });

  it("restores an exact selected slash mark when a cancellable transcript replaced its editable text", () => {
    const base = markMobileComposerSlashCommand(plainTextMobileComposerDraft("/review next"), 0, "/review");
    const partial = applyMobileVoiceTranscript(
      base,
      { start: 0, end: 7 },
      undefined,
      "dictated",
      false,
      "draft-one"
    );
    expect(partial.draft?.slashCommands).toEqual([]);
    expect(partial.context?.rollbackSlashCommands).toHaveLength(1);
    const restored = rollbackMobileVoiceTranscript(partial.draft!, partial.context!);
    expect(restored).toBeDefined();
    expect(mobileComposerDraftsEqual(restored!.draft, base)).toBe(true);
  });

  it("keeps a quote block isolated while dictating after it and removes the boundary on rollback", () => {
    const base = appendMobileSelectionQuote(plainTextMobileComposerDraft(""), {
      sourceSessionId: "task",
      sourceMessageId: "message",
      sourceEventId: "event",
      sourceRole: "assistant",
      text: "quoted"
    }, "quote").draft;
    const partial = applyMobileVoiceTranscript(
      base,
      { start: base.text.length, end: base.text.length },
      undefined,
      "answer",
      false,
      "draft-one"
    );
    expect(partial.draft?.text).toBe("⟦Quote from Assistant⟧\n\nanswer");
    expect(partial.context?.insertion.text).toBe("\n\nanswer");
    const updated = applyMobileVoiceTranscript(
      partial.draft!,
      partial.selection!,
      partial.context,
      "better answer",
      true,
      "draft-one"
    );
    expect(updated.draft?.text).toBe("⟦Quote from Assistant⟧\n\nbetter answer");
    const restored = rollbackMobileVoiceTranscript(updated.draft!, updated.context!);
    expect(restored).toBeDefined();
    expect(mobileComposerDraftsEqual(restored!.draft, base)).toBe(true);
  });
});
