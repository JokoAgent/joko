import type { AppController } from "./controller.js";
import type { ComposerDraft, NewSessionDraft, NewSessionDraftSelection } from "./model.js";

type NewSessionFlowApi = Pick<AppController, "createSession" | "send">;
type ManagedDialogueFlowApi = Pick<AppController, "createTarget" | "createSession" | "send" | "refresh">;

export interface DelayedNewSessionDraft extends Omit<NewSessionDraft, "targetId"> {
  readonly selection: NewSessionDraftSelection;
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
  const sessionId = await api.createSession(session);
  await onCreated(sessionId);
  await api.send(sessionId, input);
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
