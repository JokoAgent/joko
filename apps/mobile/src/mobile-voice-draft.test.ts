import { describe, expect, it } from "vitest";
import {
  insertMobileSessionMention,
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
});
