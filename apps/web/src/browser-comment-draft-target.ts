import type { AppController } from "./controller.js";
import type { AppSnapshot, BrowserCommentDraftItem, ComposerDraft, NewSessionLocalDraft, SessionView } from "./model.js";
import { resolveComposerAttachmentPolicy } from "./components/composer-behavior.js";

const NEW_SESSION_TARGET_KEY = JSON.stringify(["newSession"]);
const MAXIMUM_APPEND_ATTEMPTS = 8;

export type BrowserCommentDraftTarget =
  | {
      readonly key: string;
      readonly kind: "session";
      readonly sessionId: string;
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "newSession";
      readonly label: string;
    };

export function sessionBrowserCommentDraftTarget(session: SessionView, label: string): BrowserCommentDraftTarget {
  return { key: JSON.stringify(["session", session.id]), kind: "session", sessionId: session.id, label };
}

export function newSessionBrowserCommentDraftTarget(
  draft: NewSessionLocalDraft | undefined,
  snapshot: AppSnapshot,
  label: string
): BrowserCommentDraftTarget | undefined {
  if (draft === undefined) return undefined;
  const selectedTargetId = draft.selection.kind === "target" ? draft.selection.targetId : undefined;
  const target = selectedTargetId === undefined
    ? undefined
    : snapshot.targets.find((candidate) => candidate.id === selectedTargetId && !candidate.archived);
  const backendId = draft.selection.kind === "target" ? target?.backendId : draft.selection.backendId;
  const backend = snapshot.backends.find((candidate) => candidate.id === backendId);
  const model = snapshot.models.find((candidate) => candidate.backendId === backend?.id
    && candidate.providerId === draft.providerId
    && candidate.modelId === draft.modelId);
  if (!resolveComposerAttachmentPolicy(backend, model?.supportsImages).images) return undefined;
  return { key: NEW_SESSION_TARGET_KEY, kind: "newSession", label };
}

export async function readBrowserCommentDraftTarget(
  controller: AppController,
  target: BrowserCommentDraftTarget
): Promise<Pick<ComposerDraft, "browserComments"> | Pick<NewSessionLocalDraft, "browserComments"> | undefined> {
  return target.kind === "session"
    ? controller.readDraft(target.sessionId)
    : controller.readNewSessionDraft();
}

export async function appendBrowserCommentDraftTarget(
  controller: AppController,
  target: BrowserCommentDraftTarget,
  item: BrowserCommentDraftItem
): Promise<void> {
  if (target.kind === "newSession") {
    const current = await controller.readNewSessionDraft();
    if (current === undefined) throw new Error("The new-task draft is no longer available.");
    assertMarkerAvailable(current.browserComments, item);
    await controller.saveNewSessionDraft({
      ...current,
      browserComments: [...(current.browserComments ?? []), item]
    });
    return;
  }

  for (let attempt = 0; attempt < MAXIMUM_APPEND_ATTEMPTS; attempt += 1) {
    const current = await controller.readDraftSnapshot(target.sessionId);
    assertMarkerAvailable(current.draft?.browserComments, item);
    const next: ComposerDraft = {
      text: current.draft?.text ?? "",
      attachments: current.draft?.attachments ?? [],
      mentions: current.draft?.mentions ?? [],
      deliveryMode: current.draft?.deliveryMode ?? "prompt",
      ...(current.draft?.editorDocument === undefined ? {} : { editorDocument: current.draft.editorDocument }),
      ...(current.draft?.inlineMentionRanges === undefined ? {} : { inlineMentionRanges: current.draft.inlineMentionRanges }),
      ...(current.draft?.extraDirectoryIds === undefined ? {} : { extraDirectoryIds: current.draft.extraDirectoryIds }),
      browserComments: [...(current.draft?.browserComments ?? []), item]
    };
    if (await controller.saveDraftIfRevision(target.sessionId, next, current.revision) !== undefined) return;
  }
  throw new Error("The task draft changed while the Browser annotation was being saved. Try again.");
}

function assertMarkerAvailable(
  items: readonly BrowserCommentDraftItem[] | undefined,
  candidate: BrowserCommentDraftItem
): void {
  if ((items ?? []).some((item) => item.id === candidate.id || item.markerNumber === candidate.markerNumber)) {
    throw new Error("The Browser annotation draft changed. Select the page target again.");
  }
}
