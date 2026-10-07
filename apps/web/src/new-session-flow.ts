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
  /** Validate an authored command against the newly created runtime, before
   * the first input can be accepted. A pre-existing task is not required. */
  readonly beforeFirstInput?: (sessionId: string) => Promise<void>;
  readonly onFirstInputAccepted?: () => void;
}

export interface FirstInputLifecycle {
  readonly beforeFirstInput?: (sessionId: string) => Promise<void>;
  readonly onAccepted?: () => void;
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
  onCreated: (sessionId: string) => void | Promise<void>,
  lifecycle?: FirstInputLifecycle
): Promise<string> {
  const { sessionId, generation } = await api.createSession(session);
  let presentationFailure: { readonly error: unknown } | undefined;
  try {
    await onCreated(sessionId);
  } catch (error) {
    presentationFailure = { error };
  }
  try {
    await lifecycle?.beforeFirstInput?.(sessionId);
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
  try { lifecycle?.onAccepted?.(); } catch { /* Local usage history cannot undo accepted input. */ }
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
  onManagedTargetCreated?: (targetId: string) => void,
  lifecycle?: FirstInputLifecycle
): Promise<string> {
  if (draft.selection.kind === "target") {
    if (draft.expectedTargetRevision === undefined || draft.expectedTargetRevision < 1n) {
      throw new Error("Project task creation requires the prepared Target revision.");
    }
    return createSessionFromFirstInput(api, {
      ...sessionDraft(draft),
      targetId: draft.selection.targetId,
      expectedTargetRevision: draft.expectedTargetRevision
    }, input, onCreated, lifecycle);
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
  return createSessionFromFirstInput(api, { ...sessionDraft(draft), targetId }, input, onCreated, lifecycle);
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
