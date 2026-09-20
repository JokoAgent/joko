import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  emptyMobileComposerDraft,
  insertMobileClipboardText,
  insertMobileRouteReferencePaste,
  insertMobileSessionMention,
  insertMobileStructuredClipboardText,
  markMobileComposerSlashCommand,
  plainTextMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";
import { segmentMobileComposerRoutePaste } from "./mobile-composer-route-links";
import {
  mobileComposerAtomOccurrenceKey,
  mobileComposerMentionOccurrenceKey,
  mobileComposerRichDocument,
  reconcileMobileComposerRichDocument
} from "./mobile-composer-rich-document";

function structuredDraft(): MobileComposerDraft {
  const mentioned = insertMobileSessionMention(
    emptyMobileComposerDraft(),
    { start: 0, end: 0 },
    { sessionId: "session-source", displayText: "Source task" },
    "mention-1"
  );
  const pasted = insertMobileClipboardText(
    mentioned.draft,
    mentioned.selection,
    "p".repeat(4_000),
    "paste-1"
  );
  return appendMobileSelectionQuote(pasted.draft, {
    sourceSessionId: "session-current",
    sourceMessageId: "message-1",
    sourceEventId: "event-1",
    sourceRole: "assistant",
    text: "quoted source payload"
  }, "quote-1").draft;
}

describe("mobile composer rich document", () => {
  it("projects only editable text and bounded occurrence presentation", () => {
    const rich = mobileComposerRichDocument(structuredDraft());
    expect(rich.version).toBe(1);
    expect(rich.nodes).toEqual([
      { type: "occurrence", occurrenceKey: "mention:mention-1", kind: "session", token: "@Source task",
        label: "@Source task", accessibilityLabel: "Task reference Source task", block: false },
      { type: "occurrence", occurrenceKey: "atom:paste-1", kind: "pasted-text",
        token: "⟦Pasted text (1 line)⟧", label: "Pasted text (1 line)",
        accessibilityLabel: "Pasted text (1 line)", block: false },
      { type: "text", text: "\n\n" },
      { type: "occurrence", occurrenceKey: "atom:quote-1", kind: "quote",
        token: "⟦Quote from Assistant⟧", label: "Quote from Assistant",
        accessibilityLabel: "Quote from Assistant", block: true }
    ]);
    expect(JSON.stringify(rich)).not.toContain("quoted source payload");
    expect(JSON.stringify(rich)).not.toContain("pppppppppp");
    expect(mobileComposerMentionOccurrenceKey("mention-1")).toBe("mention:mention-1");
    expect(mobileComposerAtomOccurrenceKey("paste-1")).toBe("atom:paste-1");
  });

  it("rebuilds ranges while retaining exact native authority", () => {
    const original = structuredDraft();
    const result = reconcileMobileComposerRichDocument(original, [
      { type: "text", text: "Before " },
      { type: "occurrence", occurrenceKey: "mention:mention-1" },
      { type: "text", text: " after " },
      { type: "occurrence", occurrenceKey: "atom:paste-1" },
      { type: "text", text: "\n\n" },
      { type: "occurrence", occurrenceKey: "atom:quote-1" }
    ], { start: 7, end: 7 });

    expect(result.draft.text).toBe("Before @Source task after ⟦Pasted text (1 line)⟧\n\n⟦Quote from Assistant⟧");
    expect(result.draft.mentions[0]).toMatchObject({
      mentionId: "mention-1",
      sessionId: "session-source",
      start: 7,
      end: 19
    });
    expect(result.draft.atoms[0]).toMatchObject({
      atomId: "paste-1",
      text: "p".repeat(4_000),
      start: 26
    });
    expect(result.draft.atoms[1]).toMatchObject({
      atomId: "quote-1",
      sourceSessionId: "session-current",
      sourceMessageId: "message-1",
      sourceEventId: "event-1",
      text: "quoted source payload"
    });
    expect(result.selection).toEqual({ start: 7, end: 7 });
  });

  it("permits atomic deletion but rejects forged, duplicated, or reordered authority", () => {
    const original = structuredDraft();
    const removed = reconcileMobileComposerRichDocument(original, [
      { type: "occurrence", occurrenceKey: "mention:mention-1" },
      { type: "text", text: "\n\n" },
      { type: "occurrence", occurrenceKey: "atom:quote-1" }
    ], { start: 12, end: 12 });
    expect(removed.draft.atoms.map((atom) => atom.atomId)).toEqual(["quote-1"]);

    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "occurrence", occurrenceKey: "atom:forged" }
    ], { start: 0, end: 0 })).toThrow(/occurrence order/u);
    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "occurrence", occurrenceKey: "mention:mention-1" },
      { type: "occurrence", occurrenceKey: "mention:mention-1" }
    ], { start: 0, end: 0 })).toThrow(/occurrence order/u);
    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "occurrence", occurrenceKey: "atom:paste-1" },
      { type: "occurrence", occurrenceKey: "mention:mention-1" }
    ], { start: 0, end: 0 })).toThrow(/occurrence order/u);
  });

  it("fails closed when an edit breaks quote isolation or a selection splits authority", () => {
    const original = structuredDraft();
    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "occurrence", occurrenceKey: "mention:mention-1" },
      { type: "occurrence", occurrenceKey: "atom:paste-1" },
      { type: "occurrence", occurrenceKey: "atom:quote-1" }
    ], { start: 0, end: 0 })).toThrow(/separate composer block/u);

    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "occurrence", occurrenceKey: "mention:mention-1" },
      { type: "occurrence", occurrenceKey: "atom:paste-1" },
      { type: "text", text: "\n\n" },
      { type: "occurrence", occurrenceKey: "atom:quote-1" }
    ], { start: 1, end: 1 })).toThrow(/splits a structured occurrence/u);
  });

  it("rejects adjacent text segments and Unicode-splitting selections", () => {
    const original = emptyMobileComposerDraft();
    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "text", text: "a" },
      { type: "text", text: "b" }
    ], { start: 2, end: 2 })).toThrow(/segments|text segment/u);
    expect(() => reconcileMobileComposerRichDocument(original, [
      { type: "text", text: "😀" }
    ], { start: 1, end: 1 })).toThrow(/selection/u);
  });

  it("retains only exact native-owned editable slash marks across rich edits", () => {
    const selected = markMobileComposerSlashCommand(
      plainTextMobileComposerDraft("Before /review after"),
      7,
      "/review"
    );
    expect(mobileComposerRichDocument(selected).nodes).toEqual([
      { type: "text", text: "Before " },
      { type: "text", text: "/review", slashCommand: "/review" },
      { type: "text", text: " after" }
    ]);

    const shifted = reconcileMobileComposerRichDocument(selected, [
      { type: "text", text: "😀 Before " },
      { type: "text", text: "/review", slashCommand: "/review" },
      { type: "text", text: " after" }
    ], { start: 3, end: 3 });
    expect(shifted.draft.slashCommands).toEqual([{ text: "/review", start: 10, end: 17 }]);

    const edited = reconcileMobileComposerRichDocument(selected, [
      { type: "text", text: "Before /revise after" }
    ], { start: 14, end: 14 });
    expect(edited.draft.slashCommands).toEqual([]);

    const manuallyTyped = plainTextMobileComposerDraft("/review");
    const forgedPresentation = reconcileMobileComposerRichDocument(manuallyTyped, [
      { type: "text", text: "/review", slashCommand: "/review" }
    ], { start: 7, end: 7 });
    expect(forgedPresentation.draft.slashCommands).toEqual([]);
  });

  it("projects task links as atomic accessible occurrences and permits whole-node deletion", () => {
    const inserted = insertMobileRouteReferencePaste(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      segmentMobileComposerRoutePaste("Open #/tasks/session-one now")!,
      () => "route-1"
    );
    expect(mobileComposerRichDocument(inserted.draft).nodes).toEqual([
      { type: "text", text: "Open " },
      {
        type: "occurrence",
        occurrenceKey: "atom:route-1",
        kind: "route-reference",
        token: "#/tasks/session-one",
        label: "session-one",
        accessibilityLabel: "Task link session-one",
        block: false
      },
      { type: "text", text: " now" }
    ]);
    const removed = reconcileMobileComposerRichDocument(inserted.draft, [
      { type: "text", text: "Open  now" }
    ], { start: 5, end: 5 });
    expect(removed.draft.atoms).toEqual([]);
    expect(removed.draft.text).toBe("Open  now");
    expect(() => reconcileMobileComposerRichDocument(inserted.draft, [
      { type: "text", text: "Open " },
      { type: "occurrence", occurrenceKey: "atom:route-1" },
      { type: "text", text: " now" }
    ], { start: 6, end: 6 })).toThrow(/splits a structured occurrence/u);
  });

  it("projects project links with distinct accessible semantics", () => {
    const inserted = insertMobileRouteReferencePaste(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      segmentMobileComposerRoutePaste("#/projects/project-one")!,
      () => "project-route"
    );
    expect(mobileComposerRichDocument(inserted.draft).nodes).toEqual([{
      type: "occurrence",
      occurrenceKey: "atom:project-route",
      kind: "route-reference",
      token: "#/projects/project-one",
      label: "project-one",
      accessibilityLabel: "Project link project-one",
      block: false
    }]);
  });

  it("projects and atomically removes a validated Workspace path", () => {
    const inserted = insertMobileStructuredClipboardText(
      emptyMobileComposerDraft(),
      { start: 0, end: 0 },
      "Open D:\\repo\\src\\main.ts now",
      () => "path-route",
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
    expect(mobileComposerRichDocument(inserted.draft).nodes).toEqual([
      { type: "text", text: "Open " },
      {
        type: "occurrence",
        occurrenceKey: "atom:path-route",
        kind: "route-reference",
        token: "@src/main.ts",
        label: "src/main.ts",
        accessibilityLabel: "Workspace path src/main.ts",
        block: false
      },
      { type: "text", text: " now" }
    ]);
    const removed = reconcileMobileComposerRichDocument(inserted.draft, [
      { type: "text", text: "Open  now" }
    ], { start: 5, end: 5 });
    expect(removed.draft).toEqual({
      text: "Open  now", mentions: [], atoms: [], slashCommands: [], attachments: []
    });
  });
});
