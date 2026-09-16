import { describe, expect, it, vi } from "vitest";

import { plainTextToComposerDocument } from "./composer-quote-document.js";
import { mergeRejectedComposerDraft, restoreRejectedComposerDraft } from "./composer-draft-recovery.js";
import type { BrowserCommentDraftItem, ComposerDraft } from "./model.js";

describe("rejected composer draft recovery", () => {
  it("prefixes the rejected structured input while preserving newer text and identity-owned media", () => {
    const firstMention = { id: "workspace:first", kind: "workspace" as const, reference: "first.ts", label: "first.ts", token: "@first", workspaceId: "workspace" };
    const laterMention = { id: "workspace:later", kind: "workspace" as const, reference: "later.ts", label: "later.ts", token: "@later", workspaceId: "workspace" };
    const firstAttachment = { id: "attachment-first", kind: "file" as const, file: new File(["first"], "first.txt") };
    const laterAttachment = { id: "attachment-later", kind: "file" as const, file: new File(["later"], "later.txt") };
    const firstComment = browserComment("comment-first", 1);
    const laterComment = browserComment("comment-later", 2);
    const input: ComposerDraft = {
      text: "Review @first",
      editorDocument: plainTextToComposerDocument("Review @first"),
      mentions: [firstMention],
      inlineMentionRanges: [{ mentionId: firstMention.id, from: 7, to: 13 }],
      attachments: [firstAttachment],
      browserComments: [firstComment],
      deliveryMode: "prompt",
      extraDirectoryIds: ["source-directory"]
    };
    const current: ComposerDraft = {
      text: "Then @later",
      editorDocument: plainTextToComposerDocument("Then @later"),
      mentions: [laterMention],
      inlineMentionRanges: [{ mentionId: laterMention.id, from: 5, to: 11 }],
      attachments: [laterAttachment],
      browserComments: [laterComment],
      deliveryMode: "followUp",
      extraDirectoryIds: ["later-directory"]
    };

    expect(mergeRejectedComposerDraft(input, current)).toEqual({
      text: "Review @first\n\nThen @later",
      editorDocument: expect.anything(),
      deliveryMode: "followUp",
      mentions: [firstMention, laterMention],
      inlineMentionRanges: [
        { mentionId: firstMention.id, from: 7, to: 13 },
        { mentionId: laterMention.id, from: 20, to: 26 }
      ],
      attachments: [firstAttachment, laterAttachment],
      browserComments: [firstComment, laterComment],
      extraDirectoryIds: ["later-directory"]
    });
  });

  it("retries a stale revision and returns the exact committed recovery revision", async () => {
    const input: ComposerDraft = { text: "Rejected", editorDocument: plainTextToComposerDocument("Rejected"), mentions: [], attachments: [], deliveryMode: "prompt" };
    const first = { text: "Earlier", editorDocument: plainTextToComposerDocument("Earlier"), mentions: [], attachments: [], deliveryMode: "prompt" as const };
    const latest = { ...first, text: "Latest", editorDocument: plainTextToComposerDocument("Latest") };
    const readDraftSnapshot = vi.fn()
      .mockResolvedValueOnce({ revision: 4, draft: first })
      .mockResolvedValueOnce({ revision: 5, draft: latest });
    const saveDraftIfRevision = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(6);

    const recovered = await restoreRejectedComposerDraft({ readDraftSnapshot, saveDraftIfRevision }, "created", input);

    expect(readDraftSnapshot).toHaveBeenCalledTimes(2);
    expect(saveDraftIfRevision.mock.calls.map((call) => call[2])).toEqual([4, 5]);
    expect(recovered.revision).toBe(6);
    expect(recovered.draft.text).toBe("Rejected\n\nLatest");
  });
});

function browserComment(id: string, markerNumber: number): BrowserCommentDraftItem {
  return {
    id,
    markerNumber,
    pageUrl: "https://example.com/",
    target: { kind: "element", point: { x: 10, y: 20 }, viewport: { width: 800, height: 600 } },
    comment: id,
    screenshot: { id: `${id}-screenshot`, kind: "image", file: new File([id], `${id}.png`, { type: "image/png" }) }
  };
}
