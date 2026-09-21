import { create } from "@bufbuild/protobuf";
import {
  ArtifactMentionSchema,
  InlineTextRangeSchema,
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  ResourceMentionSchema,
  SessionMentionSchema,
  WorkspaceLineRangeSchema,
  WorkspaceMentionSchema
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  appendPlainTextToMobileComposer,
  emptyMobileComposerDraft,
  insertMobileClipboardText,
  insertMobileRouteReferencePaste,
  insertMobileStructuredClipboardText,
  insertMobilePastedText,
  insertMobileArtifactMention,
  insertMobileResourceMention,
  insertMobileSessionMention,
  insertMobileWorkspaceMention,
  mobileComposerInput,
  mobileComposerDraftWithoutPrefix,
  mobileInputSummary,
  mobileLongPasteMaximumCharacters,
  mobileSelectionQuoteMarkerLine,
  normalizeMobileComposerDraft,
  plainTextMobileComposerDraft,
  recoverMobileComposerDraft,
  reconcileMobileComposerText,
  removeMobileComposerAtom,
  updateMobilePastedTextAtom,
  updateMobileRouteReferenceAtom,
  removeMobileComposerMention
} from "./mobile-composer-document";
import { segmentMobileComposerRoutePaste } from "./mobile-composer-route-links";

describe("mobile structured composer document", () => {
  it("serializes attachment-only image/file drafts in stable order and requires canonical uploaded identities", () => {
    const draft = normalizeMobileComposerDraft({
      text: "",
      mentions: [],
      atoms: [],
      slashCommands: [],
      attachments: [
        {
          state: "uploaded",
          attachmentId: "image-one",
          kind: "image",
          fileName: "pixel.png",
          mediaType: "image/png",
          byteSize: 4,
          sha256Hex: "a".repeat(64),
          capturedAtUnixMs: 100,
          blobId: "blob-image-one"
        },
        {
          state: "uploaded",
          attachmentId: "file-one",
          kind: "file",
          fileName: "proof.pdf",
          mediaType: "application/pdf",
          byteSize: 7,
          sha256Hex: "b".repeat(64),
          capturedAtUnixMs: 101,
          blobId: "blob-file-one"
        }
      ]
    });

    expect(mobileComposerInput(draft)).toMatchObject({
      parts: [
        { content: { case: "image", value: {
          altText: "pixel.png",
          blob: {
            blobId: "blob-image-one", fileName: "pixel.png", mediaType: "image/png",
            byteSize: 4n, sha256Hex: "a".repeat(64)
          }
        } } },
        { content: { case: "file", value: {
          blobId: "blob-file-one", fileName: "proof.pdf", mediaType: "application/pdf",
          byteSize: 7n, sha256Hex: "b".repeat(64)
        } } }
      ],
      mentionRanges: []
    });
    expect(mobileInputSummary(mobileComposerInput(draft))).toBe("[Image]\n[File]");

    expect(() => mobileComposerInput({
      ...draft,
      attachments: [{ ...draft.attachments[0]!, state: "local" }]
    })).toThrow(/Finish uploading every attachment/u);
  });

  it("recovers a rejected structured prefix without flattening newer references and removes only that exact prefix", () => {
    const first = insertMobileSessionMention(
      plainTextMobileComposerDraft("Review"),
      { start: 6, end: 6 },
      { sessionId: "source", displayText: "History" },
      "shared-occurrence"
    ).draft;
    const later = insertMobileWorkspaceMention(
      plainTextMobileComposerDraft("Then inspect"),
      { start: 12, end: 12 },
      { workspaceId: "workspace", relativePath: "src", displayText: "src", directory: true },
      "shared-occurrence"
    ).draft;

    const recovered = recoverMobileComposerDraft(first, later);

    expect(recovered.text).toBe("Review @History\n\nThen inspect @src/");
    expect(recovered.mentions).toMatchObject([
      { kind: "session", mentionId: "shared-occurrence", start: 7, end: 15 },
      { kind: "workspace", mentionId: "shared-occurrence-recovered-1", start: 30, end: 35 }
    ]);
    expect(recoverMobileComposerDraft(first, recovered)).toEqual(recovered);
    expect(mobileComposerDraftWithoutPrefix(first, recovered)).toEqual({
      text: later.text,
      mentions: [{ ...later.mentions[0]!, mentionId: "shared-occurrence-recovered-1" }],
      atoms: [],
      slashCommands: [],
      attachments: []
    });
    expect(mobileComposerDraftWithoutPrefix(first, plainTextMobileComposerDraft("Newer unrelated draft"))).toBeUndefined();
  });

  it("keeps a newer attachment while recognizing and removing an exact submitted attachment prefix", () => {
    const submitted = normalizeMobileComposerDraft({
      text: "Send the proof",
      mentions: [],
      atoms: [],
      slashCommands: [],
      attachments: [{
        state: "uploaded",
        attachmentId: "submitted-file",
        kind: "file",
        fileName: "submitted.pdf",
        mediaType: "application/pdf",
        byteSize: 7,
        sha256Hex: "a".repeat(64),
        capturedAtUnixMs: 100,
        blobId: "blob-submitted"
      }]
    });
    const newer = normalizeMobileComposerDraft({
      ...submitted,
      attachments: [...submitted.attachments, {
        state: "uploaded",
        attachmentId: "newer-file",
        kind: "file",
        fileName: "newer.txt",
        mediaType: "text/plain",
        byteSize: 5,
        sha256Hex: "b".repeat(64),
        capturedAtUnixMs: 101,
        blobId: "blob-newer"
      }]
    });

    expect(recoverMobileComposerDraft(submitted, newer)).toEqual(newer);
    expect(mobileComposerDraftWithoutPrefix(submitted, newer)).toEqual({
      text: "",
      mentions: [],
      atoms: [],
      slashCommands: [],
      attachments: [newer.attachments[1]]
    });
  });

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

  it("serializes Workspace files, directories, and line ranges without folding authority into the path", () => {
    const file = insertMobileWorkspaceMention(
      plainTextMobileComposerDraft("Inspect 😀 "),
      { start: 11, end: 11 },
      {
        workspaceId: "workspace",
        relativePath: "src/main.ts",
        displayText: "main.ts",
        directory: false,
        lineRange: { startLine: 7, endLine: 12 }
      },
      "workspace-one"
    );
    const directory = insertMobileWorkspaceMention(
      file.draft,
      file.selection,
      { workspaceId: "workspace", relativePath: "src", displayText: "src", directory: true },
      "workspace-two"
    );

    expect(directory.draft.text).toBe("Inspect 😀 @main.ts:7–12 @src/");
    expect(directory.draft.mentions).toMatchObject([
      {
        kind: "workspace", mentionId: "workspace-one", workspaceId: "workspace",
        relativePath: "src/main.ts", directory: false, lineRange: { startLine: 7, endLine: 12 },
        start: 11, end: 24
      },
      {
        kind: "workspace", mentionId: "workspace-two", workspaceId: "workspace",
        relativePath: "src", directory: true, start: 25, end: 30
      }
    ]);
    expect(mobileComposerInput(directory.draft)).toMatchObject({
      parts: [
        { content: { case: "text", value: directory.draft.text } },
        { content: { case: "workspaceMention", value: {
          workspaceId: "workspace", relativePath: "src/main.ts", displayText: "main.ts", directory: false,
          lineRange: { startLine: 7, endLine: 12 }
        } } },
        { content: { case: "workspaceMention", value: {
          workspaceId: "workspace", relativePath: "src", displayText: "src", directory: true
        } } }
      ],
      mentionRanges: [
        { start: 11, end: 24, mentionIndex: 0 },
        { start: 25, end: 30, mentionIndex: 1 }
      ]
    });
  });

  it("rejects non-canonical Workspace paths and invalid file/directory line semantics", () => {
    const invalid = (overrides: Record<string, unknown> = {}) => normalizeMobileComposerDraft({
      text: "@src/",
      mentions: [{
        kind: "workspace", mentionId: "workspace", workspaceId: "workspace", relativePath: "src",
        displayText: "src", directory: true, start: 0, end: 5,
        ...overrides
      }],
      atoms: [],
      slashCommands: [],
      attachments: []
    });

    expect(() => invalid({ relativePath: "src/../secret" })).toThrow(/path/u);
    expect(() => invalid({ lineRange: { startLine: 1, endLine: 2 } })).toThrow(/requires a file/u);
    expect(() => invalid({ directory: false, lineRange: { startLine: 0, endLine: 2 } })).toThrow(/one-based/u);
    expect(() => invalid({ directory: false, lineRange: { startLine: 1 } })).toThrow(/paired/u);
    expect(() => invalid({ directory: false, lineRange: { startLine: 4, endLine: 2 } })).toThrow(/ordered/u);
    expect(() => invalid({ directory: false, lineRange: { startLine: 1, endLine: 0x1_0000_0000 } })).toThrow(/one-based/u);
  });

  it("serializes exact Resource and source-task Artifact authorities for equal display labels", () => {
    const resource = insertMobileResourceMention(
      plainTextMobileComposerDraft("Use "),
      { start: 4, end: 4 },
      {
        resourceId: "resource-one",
        displayText: "Release",
        discoveredRevision: "sha256:resource-one",
        resourceVersion: "7",
        runtimeGeneration: "9"
      },
      "resource-occurrence"
    );
    const artifact = insertMobileArtifactMention(
      resource.draft,
      resource.selection,
      { artifactId: "artifact-one", sourceSessionId: "source-task", displayText: "Release" },
      "artifact-occurrence"
    );

    expect(artifact.draft.text).toBe("Use @Release @Release");
    expect(artifact.draft.mentions).toEqual([
      {
        kind: "resource", mentionId: "resource-occurrence", resourceId: "resource-one", displayText: "Release",
        discoveredRevision: "sha256:resource-one", resourceVersion: "7", runtimeGeneration: "9", start: 4, end: 12
      },
      {
        kind: "artifact", mentionId: "artifact-occurrence", artifactId: "artifact-one", sourceSessionId: "source-task",
        displayText: "Release", start: 13, end: 21
      }
    ]);
    expect(mobileComposerInput(artifact.draft)).toMatchObject({
      parts: [
        { content: { case: "text", value: artifact.draft.text } },
        { content: { case: "resourceMention", value: {
          resourceId: "resource-one", displayText: "Release", discoveredRevision: "sha256:resource-one",
          resourceVersion: 7n, runtimeGeneration: 9n
        } } },
        { content: { case: "artifactMention", value: {
          artifactId: "artifact-one", sourceSessionId: "source-task", displayText: "Release"
        } } }
      ],
      mentionRanges: [
        { start: 4, end: 12, mentionIndex: 0 },
        { start: 13, end: 21, mentionIndex: 1 }
      ]
    });
  });

  it("rejects incomplete, non-canonical, and out-of-range catalog authorities", () => {
    const resource = (overrides: Record<string, unknown> = {}) => normalizeMobileComposerDraft({
      text: "@Resource",
      mentions: [{
        kind: "resource", mentionId: "mention", resourceId: "resource", displayText: "Resource",
        discoveredRevision: "revision", resourceVersion: "1", runtimeGeneration: "2", start: 0, end: 9,
        ...overrides
      }],
      atoms: [],
      slashCommands: [],
      attachments: []
    });
    const artifact = (overrides: Record<string, unknown> = {}) => normalizeMobileComposerDraft({
      text: "@Artifact",
      mentions: [{
        kind: "artifact", mentionId: "mention", artifactId: "artifact", sourceSessionId: "source",
        displayText: "Artifact", start: 0, end: 9, ...overrides
      }],
      atoms: [],
      slashCommands: [],
      attachments: []
    });

    expect(() => resource({ discoveredRevision: "" })).toThrow(/resource revision/u);
    expect(() => resource({ resourceVersion: "0" })).toThrow(/resource version/u);
    expect(() => resource({ runtimeGeneration: "01" })).toThrow(/runtime generation/u);
    expect(() => resource({ resourceVersion: "18446744073709551616" })).toThrow(/resource version/u);
    expect(() => resource({ resourceId: " resource" })).toThrow(/resource identity/u);
    expect(() => artifact({ sourceSessionId: "" })).toThrow(/source task/u);
    expect(() => artifact({ artifactId: "artifact\n" })).toThrow(/Artifact identity/u);
  });

  it("reconciles emoji substitutions without splitting a UTF-16 surrogate pair", () => {
    const changed = reconcileMobileComposerText(plainTextMobileComposerDraft("A 👋 B"), "A 👊 B");

    expect(changed.draft).toEqual(plainTextMobileComposerDraft("A 👊 B"));
    expect(changed.selection).toEqual({ start: 4, end: 4 });
  });

  it("stores quote and long-paste atoms compactly while serializing exact wire order and remapped ranges", () => {
    const payload = "p".repeat(4_000);
    const pasted = insertMobilePastedText(
      plainTextMobileComposerDraft("Before "),
      { start: 7, end: 7 },
      payload,
      "paste-one"
    );
    const mentioned = insertMobileSessionMention(
      pasted.draft,
      pasted.selection,
      { sessionId: "other-task", displayText: "Task" },
      "mention-one"
    );
    const quoted = appendMobileSelectionQuote(mentioned.draft, {
      sourceSessionId: "current-task",
      sourceMessageId: "assistant-message",
      sourceEventId: "assistant-complete",
      sourceRole: "assistant",
      text: "quoted line\n\nnext"
    }, "quote-one");

    expect(quoted.draft.text).toBe("Before ⟦Pasted text (1 line)⟧ @Task\n\n⟦Quote from Assistant⟧");
    const input = mobileComposerInput(quoted.draft);
    const text = input.parts[0]?.content.case === "text" ? input.parts[0].content.value : "";
    expect(text).toBe(`Before ${payload} @Task\n\n${mobileSelectionQuoteMarkerLine}\n> quoted line\n>\n> next`);
    expect(input.quotesEncoded).toBe(true);
    expect(input.pastedTextRanges).toEqual([{
      start: 7,
      end: 4_007,
      display: "Pasted text (1 line)",
      $typeName: "joko.v1.InlineTextRange"
    }]);
    expect(text.slice(input.pastedTextRanges[0]!.start, input.pastedTextRanges[0]!.end)).toBe(payload);
    expect(input.mentionRanges).toMatchObject([{ start: 4_008, end: 4_013, mentionIndex: 0 }]);
    expect(text.slice(input.mentionRanges[0]!.start, input.mentionRanges[0]!.end)).toBe("@Task");
    expect(mobileInputSummary(input)).not.toContain(mobileSelectionQuoteMarkerLine);
    expect(mobileInputSummary(input)).toContain("> quoted line");
  });

  it("edits and removes whole paste/quote atoms and atomizes native long insertions", () => {
    const lines = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`).join("\n");
    const automatic = reconcileMobileComposerText(plainTextMobileComposerDraft("prefix "), `prefix ${lines}`, "auto-paste");
    expect(automatic.draft.atoms).toMatchObject([{ kind: "pasted-text", atomId: "auto-paste", text: lines }]);
    expect(automatic.draft.text).toBe("prefix ⟦Pasted text (24 lines)⟧");

    const edited = updateMobilePastedTextAtom(automatic.draft, "auto-paste", "short\ntext");
    expect(edited.draft.text).toBe("prefix ⟦Pasted text (2 lines)⟧");
    expect(mobileComposerInput(edited.draft).pastedTextRanges).toMatchObject([{
      start: 7,
      end: 17,
      display: "Pasted text (2 lines)"
    }]);
    const damaged = reconcileMobileComposerText(
      edited.draft,
      edited.draft.text.replace("text (2", "tex (2")
    );
    expect(damaged.draft).toEqual(plainTextMobileComposerDraft("prefix "));

    const quoted = appendMobileSelectionQuote(plainTextMobileComposerDraft(""), {
      sourceSessionId: "task",
      sourceMessageId: "message",
      sourceEventId: "event",
      sourceRole: "assistant",
      text: "answer"
    }, "quote");
    const afterQuote = reconcileMobileComposerText(quoted.draft, `${quoted.draft.text}Follow up`, "paste-after-quote");
    expect(afterQuote.draft.text).toBe("⟦Quote from Assistant⟧\n\nFollow up");
    expect(afterQuote.draft.atoms).toHaveLength(1);
    expect(removeMobileComposerAtom(quoted.draft, "quote").draft).toEqual(emptyMobileComposerDraft());
  });

  it("folds a native paste above the editable projection limit before applying that limit", () => {
    const pastedText = "x".repeat(1_000_001);
    const automatic = reconcileMobileComposerText(
      emptyMobileComposerDraft(),
      pastedText,
      "large-native-paste"
    );

    expect(automatic.draft.text).toBe("⟦Pasted text (1 line)⟧");
    expect(automatic.draft.atoms).toMatchObject([{
      kind: "pasted-text",
      atomId: "large-native-paste",
      text: pastedText
    }]);
    expect(mobileComposerInput(automatic.draft).pastedTextRanges).toMatchObject([{
      start: 0,
      end: pastedText.length,
      display: "Pasted text (1 line)"
    }]);
  });

  it("enforces paste budgets and preserves marker-like pasted text in normal summaries", () => {
    expect(() => insertMobileClipboardText(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      "x".repeat(mobileLongPasteMaximumCharacters + 1),
      "too-large"
    )).toThrow(/at most 2,000,000/u);

    const wire = `${mobileSelectionQuoteMarkerLine}\nplain paste\n\n${mobileSelectionQuoteMarkerLine}\n> actual quote`;
    const input = create(InputContentSchema, {
      parts: [create(InputPartSchema, { content: { case: "text", value: wire } })],
      quotesEncoded: true,
      pastedTextRanges: [create(InlineTextRangeSchema, {
        start: 0,
        end: mobileSelectionQuoteMarkerLine.length + "\nplain paste".length,
        display: "Pasted text (2 lines)"
      })]
    });
    expect(mobileInputSummary(input)).toBe("Pasted text (2 lines)\n\n> actual quote");
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
      mentions: [{ kind: "session", mentionId: "mention", sessionId: "source", displayText: "Task", start: 1, end: 8 }],
      atoms: [],
      slashCommands: [],
      attachments: []
    })).toThrow(/range/);
    expect(() => normalizeMobileComposerDraft({
      text: "@Task @Task",
      mentions: [
        { kind: "session", mentionId: "same", sessionId: "one", displayText: "Task", start: 0, end: 5 },
        { kind: "session", mentionId: "same", sessionId: "two", displayText: "Task", start: 6, end: 11 }
      ],
      atoms: [],
      slashCommands: [],
      attachments: []
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

    const workspace = create(InputContentSchema, {
      parts: [
        create(InputPartSchema, { content: { case: "text", value: "Inspect @main.ts:7–12" } }),
        create(InputPartSchema, { content: { case: "workspaceMention", value: create(WorkspaceMentionSchema, {
          workspaceId: "workspace", relativePath: "src/main.ts", displayText: "main.ts", directory: false,
          lineRange: create(WorkspaceLineRangeSchema, { startLine: 7, endLine: 12 })
        }) } })
      ],
      mentionRanges: [create(InputMentionRangeSchema, { start: 8, end: 21, mentionIndex: 0 })]
    });
    expect(mobileInputSummary(workspace)).toBe("Inspect @main.ts:7–12");

    const invalidWorkspace = create(InputContentSchema, {
      parts: [
        workspace.parts[0]!,
        create(InputPartSchema, { content: { case: "workspaceMention", value: create(WorkspaceMentionSchema, {
          workspaceId: "workspace", relativePath: "src", displayText: "src", directory: true,
          lineRange: create(WorkspaceLineRangeSchema, { startLine: 1, endLine: 2 })
        }) } })
      ],
      mentionRanges: workspace.mentionRanges
    });
    expect(mobileInputSummary(invalidWorkspace)).toBe("Inspect @main.ts:7–12\n[Invalid reference metadata]");

    const invalidResource = create(InputContentSchema, {
      parts: [
        create(InputPartSchema, { content: { case: "text", value: "Use @Resource" } }),
        create(InputPartSchema, { content: { case: "resourceMention", value: create(ResourceMentionSchema, {
          resourceId: "resource", displayText: "Resource", discoveredRevision: "", resourceVersion: 0n,
          runtimeGeneration: 0n
        }) } })
      ],
      mentionRanges: [create(InputMentionRangeSchema, { start: 4, end: 13, mentionIndex: 0 })]
    });
    expect(mobileInputSummary(invalidResource)).toBe("Use @Resource\n[Invalid reference metadata]");

    const invalidArtifact = create(InputContentSchema, {
      parts: [
        create(InputPartSchema, { content: { case: "text", value: "Use @Artifact" } }),
        create(InputPartSchema, { content: { case: "artifactMention", value: create(ArtifactMentionSchema, {
          artifactId: "artifact", sourceSessionId: "", displayText: "Artifact"
        }) } })
      ],
      mentionRanges: [create(InputMentionRangeSchema, { start: 4, end: 13, mentionIndex: 0 })]
    });
    expect(mobileInputSummary(invalidArtifact)).toBe("Use @Artifact\n[Invalid reference metadata]");
  });

  it("inserts, enriches, serializes, and removes mixed task/project link atoms without typed authority", () => {
    const segments = segmentMobileComposerRoutePaste(
      "See #/tasks/session-one and [Second](#/tasks/session-two?message=message-two) in #/projects/project-one."
    )!;
    const inserted = insertMobileRouteReferencePaste(
      plainTextMobileComposerDraft("Before "),
      { start: 7, end: 7 },
      segments,
      (index) => `route-${index}`
    );
    expect(inserted.insertedAtomIds).toEqual(["route-0", "route-1", "route-2"]);
    expect(inserted.draft.text).toBe("Before See #/tasks/session-one and #/tasks/session-two?message=message-two in #/projects/project-one.");
    expect(inserted.draft.atoms).toMatchObject([
      {
        kind: "route-reference",
        routeKind: "session",
        atomId: "route-0",
        href: "#/tasks/session-one",
        serialized: "#/tasks/session-one",
        sessionId: "session-one",
        displayText: "session-one"
      },
      {
        kind: "route-reference",
        routeKind: "session",
        atomId: "route-1",
        href: "#/tasks/session-two?message=message-two",
        serialized: "#/tasks/session-two?message=message-two",
        sessionId: "session-two",
        messageId: "message-two",
        displayText: "message-two"
      },
      {
        kind: "route-reference",
        routeKind: "project",
        atomId: "route-2",
        href: "#/projects/project-one",
        serialized: "#/projects/project-one",
        projectId: "project-one",
        displayText: "project-one"
      }
    ]);
    expect(mobileComposerInput(inserted.draft)).toMatchObject({
      parts: [{ content: { case: "text", value: inserted.draft.text } }],
      mentionRanges: [],
      pastedTextRanges: [],
      quotesEncoded: false
    });

    const first = inserted.draft.atoms[0]!;
    expect(first.kind).toBe("route-reference");
    if (first.kind !== "route-reference") throw new Error("expected task link");
    const titled = updateMobileRouteReferenceAtom(inserted.draft, first, "Roadmap @ team")!;
    expect(titled.draft.text).toContain("[Roadmap ＠ team](#/tasks/session-one)");
    expect(titled.draft.mentions).toEqual([]);
    const second = titled.draft.atoms.find((atom) => atom.atomId === "route-1")!;
    if (second.kind !== "route-reference") throw new Error("expected message link");
    const resolved = updateMobileRouteReferenceAtom(titled.draft, second, "  Message\nbody  ")!;
    expect(resolved.draft.text).toContain("#/tasks/session-two?message=message-two");
    expect(resolved.draft.atoms.find((atom) => atom.atomId === "route-1")).toMatchObject({
      displayText: "Message body",
      serialized: "#/tasks/session-two?message=message-two"
    });
    const project = resolved.draft.atoms.find((atom) => atom.atomId === "route-2")!;
    if (project.kind !== "route-reference") throw new Error("expected project link");
    const projectTitled = updateMobileRouteReferenceAtom(resolved.draft, project, "Mobile Project")!;
    expect(projectTitled.draft.text).toContain("[Mobile Project](#/projects/project-one)");
    expect(updateMobileRouteReferenceAtom(resolved.draft, second, "stale")).toBeUndefined();
    expect(removeMobileComposerAtom(projectTitled.draft, "route-1").draft.atoms.map((atom) => atom.atomId))
      .toEqual(["route-0", "route-2"]);
  });

  it("rejects forged task-link authority and never retains credential-bearing hrefs", () => {
    expect(() => normalizeMobileComposerDraft({
      text: "#/tasks/session",
      mentions: [],
      atoms: [{
        kind: "route-reference",
        routeKind: "session",
        atomId: "route",
        href: "https://user:pass@example.test/?token=secret#/tasks/session",
        serialized: "#/tasks/session",
        sessionId: "session",
        displayText: "session",
        start: 0,
        end: 16
      }],
      slashCommands: [],
      attachments: []
    })).toThrow(/target|range/u);
  });

  it("stores a validated absolute Workspace path only as an atomic relative wire item", () => {
    const result = insertMobileStructuredClipboardText(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      "Open D:\\repo\\src\\main.ts and #/projects/mobile",
      (index) => `route-${index}`,
      { workspacePath: {
        workspaceId: "workspace-one",
        serverPathDisplay: "D:\\repo",
        resolutions: [{
          candidateRelativePath: "src/main.ts",
          relativePath: "src/main.ts",
          directory: false
        }]
      } }
    );
    expect(result.draft.text).toBe("Open @src/main.ts and #/projects/mobile");
    expect(result.draft.atoms).toMatchObject([{
      kind: "route-reference",
      routeKind: "path",
      atomId: "route-0",
      workspaceId: "workspace-one",
      relativePath: "src/main.ts",
      directory: false,
      serialized: "@src/main.ts",
      displayText: "src/main.ts"
    }, {
      kind: "route-reference",
      routeKind: "project",
      atomId: "route-1"
    }]);
    expect(JSON.stringify(result.draft)).not.toContain("D:\\\\repo");
    expect(mobileComposerInput(result.draft)).toMatchObject({
      parts: [{ content: { case: "text", value: "Open @src/main.ts and #/projects/mobile" } }],
      mentionRanges: [],
      pastedTextRanges: []
    });
    const path = result.draft.atoms[0]!;
    if (path.kind !== "route-reference") throw new Error("expected Workspace path");
    expect(updateMobileRouteReferenceAtom(result.draft, path, "forged title")).toBeUndefined();
    expect(removeMobileComposerAtom(result.draft, path.atomId).draft.text).toBe("Open  and #/projects/mobile");
  });

  it("rejects forged Workspace path atom identities and wire text", () => {
    expect(() => normalizeMobileComposerDraft({
      text: "D:\\repo\\src\\main.ts",
      mentions: [],
      atoms: [{
        kind: "route-reference",
        routeKind: "path",
        atomId: "path",
        workspaceId: "workspace-one",
        relativePath: "src/main.ts",
        directory: false,
        serialized: "D:\\repo\\src\\main.ts",
        displayText: "src/main.ts",
        start: 0,
        end: 23
      }],
      slashCommands: [],
      attachments: []
    })).toThrow(/Workspace path|range/u);
  });

  it("gives long-paste compaction precedence over task-link and Workspace-path recognition", () => {
    const text = `${"x".repeat(4_000)} #/tasks/session D:\\repo\\src\\main.ts`;
    const result = insertMobileStructuredClipboardText(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      text,
      (index) => `atom-${index}`,
      { workspacePath: {
        workspaceId: "workspace-one",
        serverPathDisplay: "D:\\repo",
        resolutions: [{
          candidateRelativePath: "src/main.ts",
          relativePath: "src/main.ts",
          directory: false
        }]
      } }
    );
    expect(result.insertedAtomIds).toEqual([]);
    expect(result.draft.atoms).toMatchObject([{ kind: "pasted-text", atomId: "atom-0", text }]);
  });
});
