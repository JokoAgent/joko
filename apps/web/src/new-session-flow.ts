import type { AppController } from "./controller.js";
import type { ComposerDraft, NewSessionDraft, NewSessionDraftSelection } from "./model.js";
import { runtimeCommandOwnsApplicationCommand } from "./components/composer-palette.js";
import { requireStartedSkillLearningRun, type StartedSkillLearningRunView } from "./skill-learning-command.js";

type NewSessionFlowApi = Pick<AppController, "createSession" | "send" | "restoreFirstInputDraft">
  & Partial<Pick<AppController, "listCommands" | "startSkillLearning">>;
type ManagedDialogueFlowApi = Pick<AppController, "createTarget" | "createSession" | "send" | "refresh" | "restoreFirstInputDraft">
  & Partial<Pick<AppController, "listCommands" | "startSkillLearning">>;

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
  /** A typed application-owned command candidate. Runtime ownership is still
   * refreshed after Session creation before this disposition is accepted. */
  readonly firstInputDisposition?: FirstInputDisposition;
  readonly onFirstInputAccepted?: (acceptance?: FirstInputAcceptance) => void;
}

export interface FirstInputLifecycle {
  readonly beforeFirstInput?: (sessionId: string) => Promise<void>;
  readonly disposition?: FirstInputDisposition;
  readonly signal?: AbortSignal;
  readonly onAccepted?: (acceptance: FirstInputAcceptance) => void;
}

/** The durable first input is either sent to the newly created runtime or
 * accepted locally as Skill learning. The full ComposerDraft remains the
 * single recovery payload for both paths. */
export type FirstInputDisposition =
  | { readonly kind: "send" }
  | {
      readonly kind: "learn";
      readonly requestId: string;
      readonly backendId: string;
      readonly instruction: string;
      readonly evidence: "createdSession" | "freeText";
      readonly application: { readonly kind: "eligible" }
        | { readonly kind: "rejected"; readonly reason: "hub" | "structured" };
    };

export type FirstInputAcceptance =
  | { readonly kind: "sent"; readonly sessionId: string }
  | {
      readonly kind: "learned";
      readonly sessionId: string;
      readonly run: StartedSkillLearningRunView;
    };

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
  const disposition = lifecycle?.disposition ?? { kind: "send" };
  assertFirstInputDisposition(api, disposition);
  const { sessionId, generation } = await api.createSession(session);
  let presentationFailure: { readonly error: unknown } | undefined;
  try {
    await onCreated(sessionId);
  } catch (error) {
    presentationFailure = { error };
  }
  try {
    await lifecycle?.beforeFirstInput?.(sessionId);
    const acceptance = await acceptFirstInput(api, session, sessionId, generation, input, disposition, lifecycle?.signal);
    try { lifecycle?.onAccepted?.(acceptance); } catch { /* Local presentation/history cannot undo accepted input. */ }
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
  onManagedTargetCreated?: (targetId: string) => void,
  lifecycle?: FirstInputLifecycle
): Promise<string> {
  if (draft.selection.kind !== "target" && lifecycle?.disposition?.kind === "learn") {
    throw new Error("Skill learning requires a selected task environment.");
  }
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

function assertFirstInputDisposition(api: NewSessionFlowApi, disposition: FirstInputDisposition): void {
  if (disposition.kind === "send") return;
  if (typeof api.listCommands !== "function" || typeof api.startSkillLearning !== "function") {
    throw new Error("Skill learning is unavailable on this connection.");
  }
  if (disposition.requestId.trim() === "") throw new Error("Skill learning requires an invocation identity.");
  if (disposition.backendId.trim() === "") throw new Error("Skill learning requires a Backend identity.");
  if (disposition.evidence === "createdSession" && disposition.instruction !== ""
    || disposition.evidence === "freeText" && disposition.instruction.trim() === "") {
    throw new Error("The Skill learning input is invalid.");
  }
}

async function acceptFirstInput(
  api: NewSessionFlowApi,
  session: NewSessionDraft,
  sessionId: string,
  generation: bigint,
  input: ComposerDraft,
  disposition: FirstInputDisposition,
  signal?: AbortSignal
): Promise<FirstInputAcceptance> {
  if (disposition.kind === "send") {
    await api.send(sessionId, input, { expectedGeneration: generation });
    return { kind: "sent", sessionId };
  }

  // The newly-created runtime is the only command authority. A loaded native
  // command wins even when the draft-route catalog advertised the app command.
  signal?.throwIfAborted();
  const commands = await api.listCommands!(sessionId, signal);
  signal?.throwIfAborted();
  if (runtimeCommandOwnsApplicationCommand(commands, "learn")) {
    await api.send(sessionId, input, { expectedGeneration: generation });
    return { kind: "sent", sessionId };
  }
  if (disposition.application.kind === "rejected") {
    throw new Error(disposition.application.reason === "hub"
      ? "Catalog Skill identifiers are not supported by /learn; describe what should be learned instead."
      : "The /learn command accepts text only; remove attachments and references before retrying.");
  }

  const run = requireStartedSkillLearningRun(await api.startSkillLearning!({
    requestId: disposition.requestId,
    targetId: session.targetId,
    instruction: disposition.instruction,
    ...(disposition.evidence === "createdSession" ? { sourceSessionId: sessionId } : {})
  }, signal), {
    backendId: disposition.backendId,
    targetId: session.targetId,
    source: disposition.evidence === "createdSession"
      ? { kind: "session", sessionId }
      : { kind: "text" }
  });
  signal?.throwIfAborted();
  return { kind: "learned", sessionId, run };
}
