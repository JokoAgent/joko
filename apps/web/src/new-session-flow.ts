import type { AppController } from "./controller.js";
import type { ComposerDraft, NewSessionDraft, NewSessionDraftSelection } from "./model.js";

type NewSessionFlowApi = Pick<AppController, "createSession" | "send" | "restoreFirstInputDraft">;
type ManagedDialogueFlowApi = Pick<AppController, "createTarget" | "createSession" | "send" | "refresh" | "restoreFirstInputDraft">;

export interface DelayedNewSessionDraft extends Omit<NewSessionDraft, "targetId"> {
  readonly selection: NewSessionDraftSelection;
}

/** The initiating draft activation; a later route with the same values is a new owner. */
export interface NewSessionSubmissionOwner {
  readonly ownerDocument: Document;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

/**
 * A draft route has no product session until its first real input. Once the
 * session exists, expose it before dispatching the durable input so a failed
 * dispatch can never strand an invisible, newly-created task.
 */
export async function createSessionFromFirstInput(
  api: NewSessionFlowApi,
  session: NewSessionDraft,
  input: ComposerDraft,
  onCreated: (sessionId: string) => void | Promise<void>
): Promise<string> {
  const { sessionId, generation } = await api.createSession(session);
  let presentationFailure: { readonly error: unknown } | undefined;
  try {
    await onCreated(sessionId);
  } catch (error) {
    presentationFailure = { error };
  }
  try {
    await api.send(sessionId, input, { expectedGeneration: generation });
  } catch (error) {
    try {
      await api.restoreFirstInputDraft(sessionId, input);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "The first input was not accepted and could not be restored to the created task draft."
      );
    }
    throw error;
  }
  if (presentationFailure !== undefined) throw presentationFailure.error;
  return sessionId;
}

/**
 * Managed dialogue creation is an explicit durable two-step operation. The
 * target is refreshed into the owner snapshot before Session creation, so a
 * second-step failure leaves a visible, recoverable target instead of a hidden
 * orphan or a fabricated project fallback.
 */
export async function createDelayedSessionFromFirstInput(
  api: ManagedDialogueFlowApi,
  draft: DelayedNewSessionDraft,
  input: ComposerDraft,
  onCreated: (sessionId: string) => void | Promise<void>,
  onManagedTargetCreated?: (targetId: string) => void
): Promise<string> {
  if (draft.selection.kind === "target") {
    return createSessionFromFirstInput(api, { ...sessionDraft(draft), targetId: draft.selection.targetId }, input, onCreated);
  }
  const targetId = await api.createTarget({
    backendId: draft.selection.backendId,
    name: draft.name,
    workspaceKind: "managedDialogue",
    serverPath: "",
    createIfMissing: true
  });
  await api.refresh();
  onManagedTargetCreated?.(targetId);
  return createSessionFromFirstInput(api, { ...sessionDraft(draft), targetId }, input, onCreated);
}

function sessionDraft(draft: DelayedNewSessionDraft): Omit<NewSessionDraft, "targetId"> {
  return {
    name: draft.name,
    nativeStart: draft.nativeStart,
    providerId: draft.providerId,
    modelId: draft.modelId,
    ...(draft.effort === undefined ? {} : { effort: draft.effort }),
    fastMode: draft.fastMode,
    permissionMode: draft.permissionMode,
    planMode: draft.planMode,
    ...(draft.worktree === undefined ? {} : { worktree: draft.worktree })
  };
}
