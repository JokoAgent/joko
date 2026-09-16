import type { ComposerDraft } from "./model.js";
import { composerDocumentPlainText, joinComposerDocuments, normalizeComposerDocument } from "./composer-quote-document.js";
import { restoreComposerInlineMentionRanges } from "./components/composer-inline-mention.js";

const MAXIMUM_DRAFT_RECOVERY_ATTEMPTS = 8;

export interface RecoveredComposerDraft {
  readonly draft: ComposerDraft;
  readonly revision: number;
}

export function mergeRejectedComposerDraft(input: ComposerDraft, current: ComposerDraft | undefined): ComposerDraft {
  const sourceDocument = normalizeComposerDocument(input.editorDocument, input.text);
  const sourceText = composerDocumentPlainText(sourceDocument);
  const sourceRanges = restoreComposerInlineMentionRanges(sourceText, input.mentions, input.inlineMentionRanges);
  const currentDocument = normalizeComposerDocument(current?.editorDocument, current?.text ?? "");
  const currentText = composerDocumentPlainText(currentDocument);
  const restoredDocument = joinComposerDocuments(sourceDocument, currentDocument);
  const restoredText = composerDocumentPlainText(restoredDocument);
  const mentions = mergeDraftItemsById(input.mentions, current?.mentions ?? []);
  const currentRanges = restoreComposerInlineMentionRanges(currentText, current?.mentions ?? [], current?.inlineMentionRanges);
  const currentOffset = restoredText.length - currentText.length;
  const inlineMentionRanges = restoreComposerInlineMentionRanges(restoredText, mentions, [
    ...sourceRanges,
    ...currentRanges.map((range) => ({ ...range, from: range.from + currentOffset, to: range.to + currentOffset }))
  ]);
  return {
    text: restoredText,
    editorDocument: restoredDocument,
    deliveryMode: current?.deliveryMode ?? input.deliveryMode,
    mentions,
    inlineMentionRanges,
    attachments: mergeDraftItemsById(input.attachments, current?.attachments ?? []),
    browserComments: mergeDraftItemsById(input.browserComments ?? [], current?.browserComments ?? []),
    ...((current?.extraDirectoryIds ?? input.extraDirectoryIds) === undefined
      ? {}
      : { extraDirectoryIds: current?.extraDirectoryIds ?? input.extraDirectoryIds })
  };
}

export async function restoreRejectedComposerDraft(
  api: {
    readDraftSnapshot(sessionId: string): Promise<{ readonly revision: number; readonly draft?: ComposerDraft }>;
    saveDraftIfRevision(sessionId: string, draft: ComposerDraft, expectedRevision: number): Promise<number | undefined>;
  },
  sessionId: string,
  input: ComposerDraft
): Promise<RecoveredComposerDraft> {
  for (let attempt = 0; attempt < MAXIMUM_DRAFT_RECOVERY_ATTEMPTS; attempt += 1) {
    const snapshot = await api.readDraftSnapshot(sessionId);
    const draft = mergeRejectedComposerDraft(input, snapshot.draft);
    const revision = await api.saveDraftIfRevision(sessionId, draft, snapshot.revision);
    if (revision !== undefined) return { draft, revision };
  }
  throw new Error("The created task draft kept changing while the first input was being restored.");
}

function mergeDraftItemsById<T extends { readonly id: string }>(first: readonly T[], second: readonly T[]): readonly T[] {
  const merged = new Map<string, T>();
  for (const item of [...first, ...second]) merged.set(item.id, item);
  return [...merged.values()];
}
