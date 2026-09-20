import { create } from "@bufbuild/protobuf";
import {
  ArtifactMentionSchema,
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
  appendPlainTextToMobileComposer,
  insertMobileArtifactMention,
  insertMobileResourceMention,
  insertMobileSessionMention,
  insertMobileWorkspaceMention,
  mobileComposerInput,
  mobileComposerDraftWithoutPrefix,
  mobileInputSummary,
  normalizeMobileComposerDraft,
  plainTextMobileComposerDraft,
  recoverMobileComposerDraft,
  reconcileMobileComposerText,
  removeMobileComposerMention
} from "./mobile-composer-document";

describe("mobile structured composer document", () => {
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
      mentions: [{ ...later.mentions[0]!, mentionId: "shared-occurrence-recovered-1" }]
    });
    expect(mobileComposerDraftWithoutPrefix(first, plainTextMobileComposerDraft("Newer unrelated draft"))).toBeUndefined();
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
      }]
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
      }]
    });
    const artifact = (overrides: Record<string, unknown> = {}) => normalizeMobileComposerDraft({
      text: "@Artifact",
      mentions: [{
        kind: "artifact", mentionId: "mention", artifactId: "artifact", sourceSessionId: "source",
        displayText: "Artifact", start: 0, end: 9, ...overrides
      }]
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
});
