import { create } from "@bufbuild/protobuf";
import {
  ArtifactMentionSchema,
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  SessionMentionSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendPlainTextToMobileComposer,
  insertMobileSessionMention,
  mobileComposerInput,
  mobileInputSummary,
  normalizeMobileComposerDraft,
  plainTextMobileComposerDraft,
  reconcileMobileComposerText,
  removeMobileComposerMention
} from "./mobile-composer-document";

describe("mobile structured composer document", () => {
  it("inserts repeated equal labels as independent occurrences and serializes exact UTF-16 ranges", () => {
    const first = insertMobileSessionMention(
      plainTextMobileComposerDraft("Review 😀 then "),
      { start: 15, end: 15 },
      { sessionId: "source-one", displayText: "Same task" },
      "mention-one"
    );
    const second = insertMobileSessionMention(
      first.draft,
      first.selection,
      { sessionId: "source-two", displayText: "Same task" },
      "mention-two"
    );

    expect(second.draft.text).toBe("Review 😀 then @Same task @Same task");
    expect(second.draft.mentions).toEqual([
      { kind: "session", mentionId: "mention-one", sessionId: "source-one", displayText: "Same task", start: 15, end: 25 },
      { kind: "session", mentionId: "mention-two", sessionId: "source-two", displayText: "Same task", start: 26, end: 36 }
    ]);
    expect(mobileComposerInput(second.draft)).toMatchObject({
      parts: [
        { content: { case: "text", value: second.draft.text } },
        { content: { case: "sessionMention", value: { sessionId: "source-one", displayText: "Same task" } } },
        { content: { case: "sessionMention", value: { sessionId: "source-two", displayText: "Same task" } } }
      ],
      mentionRanges: [
        { start: 15, end: 25, mentionIndex: 0 },
        { start: 26, end: 36, mentionIndex: 1 }
      ]
    });
  });

  it("maps edits around references and removes the whole atomic occurrence when an edit intersects it", () => {
    const inserted = insertMobileSessionMention(
      plainTextMobileComposerDraft("Before after"),
      { start: 7, end: 7 },
      { sessionId: "source", displayText: "Task" },
      "mention"
    );
    const before = reconcileMobileComposerText(inserted.draft, `X${inserted.draft.text}`);
    expect(before.draft.mentions).toMatchObject([{ start: 8, end: 13 }]);

    const backspaceInside = reconcileMobileComposerText(
      before.draft,
      `${before.draft.text.slice(0, 10)}${before.draft.text.slice(11)}`
    );
    expect(backspaceInside.draft.text).toBe("XBefore  after");
    expect(backspaceInside.draft.mentions).toEqual([]);
    expect(backspaceInside.selection).toEqual({ start: 8, end: 8 });
    const explicitlyRemoved = removeMobileComposerMention(inserted.draft, "mention");
    expect(explicitlyRemoved.draft).toEqual(plainTextMobileComposerDraft("Before  after"));
  });

  it("reconciles emoji substitutions without splitting a UTF-16 surrogate pair", () => {
    const changed = reconcileMobileComposerText(plainTextMobileComposerDraft("A 👋 B"), "A 👊 B");

    expect(changed.draft).toEqual(plainTextMobileComposerDraft("A 👊 B"));
    expect(changed.selection).toEqual({ start: 4, end: 4 });
  });

  it("preserves occurrences while appending ordinary text and rejects damaged ranges, duplicates, and surrogate splits", () => {
    const inserted = insertMobileSessionMention(
      plainTextMobileComposerDraft("😀 "),
      { start: 3, end: 3 },
      { sessionId: "source", displayText: "Task" },
      "mention"
    );
    expect(appendPlainTextToMobileComposer(inserted.draft, "Follow-up")).toMatchObject({
      text: "😀 @Task\n\nFollow-up",
      mentions: [{ mentionId: "mention", start: 3, end: 8 }]
    });
    expect(() => normalizeMobileComposerDraft({
      text: "😀 @Task",
      mentions: [{ kind: "session", mentionId: "mention", sessionId: "source", displayText: "Task", start: 1, end: 8 }]
    })).toThrow(/range/);
    expect(() => normalizeMobileComposerDraft({
      text: "@Task @Task",
      mentions: [
        { kind: "session", mentionId: "same", sessionId: "one", displayText: "Task", start: 0, end: 5 },
        { kind: "session", mentionId: "same", sessionId: "two", displayText: "Task", start: 6, end: 11 }
      ]
    })).toThrow(/duplicated/);
  });

  it("shows inline references once, lists non-inline references, and fails closed on malformed ranges", () => {
    const inline = create(InputContentSchema, {
      parts: [
        create(InputPartSchema, { content: { case: "text", value: "Ask @Task" } }),
        create(InputPartSchema, { content: { case: "sessionMention", value: create(SessionMentionSchema, {
          sessionId: "source", displayText: "Task"
        }) } })
      ],
      mentionRanges: [create(InputMentionRangeSchema, { start: 4, end: 9, mentionIndex: 0 })]
    });
    expect(mobileInputSummary(inline)).toBe("Ask @Task");
    expect(mobileInputSummary(inline, false)).toBe("Ask @Task\n[Untrusted structured metadata ignored]");

    const nonInline = create(InputContentSchema, {
      parts: [
        create(InputPartSchema, { content: { case: "text", value: "See the report" } }),
        create(InputPartSchema, { content: { case: "artifactMention", value: create(ArtifactMentionSchema, {
          artifactId: "artifact", sourceSessionId: "source", displayText: "report.txt"
        }) } })
      ]
    });
    expect(mobileInputSummary(nonInline)).toBe("See the report\n@report.txt");

    const malformed = create(InputContentSchema, {
      parts: inline.parts,
      mentionRanges: [create(InputMentionRangeSchema, { start: 5, end: 99, mentionIndex: 0 })]
    });
    expect(mobileInputSummary(malformed)).toBe("Ask @Task\n[Invalid reference metadata]");

    const duplicateOccurrence = create(InputContentSchema, {
      parts: inline.parts,
      mentionRanges: [
        create(InputMentionRangeSchema, { start: 0, end: 3, mentionIndex: 0 }),
        create(InputMentionRangeSchema, { start: 4, end: 9, mentionIndex: 0 })
      ]
    });
    expect(mobileInputSummary(duplicateOccurrence)).toBe("Ask @Task\n[Invalid reference metadata]");
  });
});
