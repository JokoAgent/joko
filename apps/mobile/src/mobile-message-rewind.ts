import { clone, toBinary } from "@bufbuild/protobuf";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  BackgroundTaskState, CapabilitySupport, EventSchema, InteractionState, MessageRole, NativeNavigationTargetSchema,
  QueueItemState, RewindSafety, RunState, SessionState,
  type BackendDescriptor, type Event, type NativeNavigationTarget, type Session, type Snapshot, type Target,
  type WorkspaceChangeSet, type WorkspaceDescriptor, type WorkspaceRewindPreview
} from "@joko/contracts";
import { plainTextMobileComposerDraft, restoreMobileComposerInput, type MobileComposerDraft } from "./mobile-composer-document";
import { canonicalWorkspacePath } from "./workspace-files";

export interface MobileMessageRewindSource {
  readonly eventId: string; readonly messageId: string; readonly sourceKey: string;
  readonly target?: NativeNavigationTarget; readonly runId?: string; readonly draft: MobileComposerDraft;
}
export interface MobileMessageRewindControls {
  readonly authorityKey: string; readonly surfaceOwnerKey: string; readonly sessionId: string;
  readonly source: MobileMessageRewindSource; readonly workspace?: WorkspaceDescriptor;
  readonly canDialogue: boolean; readonly canFiles: boolean; readonly canRewind: boolean;
}
export interface MobileMessageRewindPreview {
  readonly controls: MobileMessageRewindControls;
  readonly files?: WorkspaceRewindPreview; readonly fileError?: boolean;
}
export type MobileMessageRewindResult = { readonly kind: "rewound"; readonly mode: "dialogue" | "files" }
  | { readonly kind: "unknown" | "rejected" | "retired" };

export function mobileRewindCapability(backend: BackendDescriptor, name: string): boolean {
  const matches = backend.capabilities?.capabilities.filter((value) => value.name === name) ?? [];
  return matches.length === 1 && matches[0]!.support === CapabilitySupport.SUPPORTED;
}

export function mobileRewindToStartSupported(backend: BackendDescriptor, target: Target): boolean {
  const matches = backend.capabilities?.capabilities.filter((value) => value.name === "session.rewind_to_start") ?? [];
  const capability = matches[0];
  if (matches.length !== 1 || capability?.support !== CapabilitySupport.SUPPORTED) return false;
  const options = capability.options?.kind;
  return options === undefined || options.case === undefined
    || options.case === "session" && (!options.value.serviceNodeOnly || target.location?.kind.case === "serviceNode");
}

export function mobileMessageRewindIdle(session: Session, detail: Snapshot): boolean {
  return session.state === SessionState.IDLE && !session.archived
    && !detail.reviewRuns.some((value) => value.reviewerSessionId === session.sessionId)
    && !detail.runs.some((value) => value.sessionId === session.sessionId && [RunState.ACCEPTED, RunState.QUEUED,
      RunState.DISPATCHING, RunState.DISPATCH_UNKNOWN, RunState.RUNNING, RunState.WAITING, RunState.RETRYING].includes(value.state))
    && !detail.queueItems.some((value) => value.sessionId === session.sessionId && [QueueItemState.ACCEPTED,
      QueueItemState.DISPATCHING, QueueItemState.BACKEND_ACCEPTED, QueueItemState.DISPATCH_UNKNOWN].includes(value.state))
    && !detail.interactions.some((value) => value.sessionId === session.sessionId && value.state === InteractionState.PENDING)
    && !detail.backgroundTasks.some((value) => value.sessionId === session.sessionId
      && [BackgroundTaskState.QUEUED, BackgroundTaskState.RUNNING, BackgroundTaskState.WAITING].includes(value.state));
}

/** Only a public rewind_before proves this user boundary. parent_entry_id is never a rewind substitute. */
export function resolveMobileMessageRewindSource(events: readonly Event[], sessionId: string, eventId: string,
  generation: bigint, allowStart: boolean): MobileMessageRewindSource | undefined {
  const exact = events.filter((event) => event.eventId === eventId);
  if (exact.length !== 1 || !validId(eventId) || !validId(sessionId)) return undefined;
  const event = exact[0]!; const payload = event.payload?.kind;
  if (event.identity?.sessionId !== sessionId || event.cursor?.generation !== generation
    || (payload?.case !== "messageStarted" && payload?.case !== "messageCompleted") || payload.value.role !== MessageRole.USER
    || !validId(payload.value.messageId) || payload.case === "messageStarted" && !payload.value.userInputAccepted) return undefined;
  const starts = events.filter((candidate) => candidate.identity?.sessionId === sessionId && candidate.cursor?.generation === generation
    && candidate.payload?.kind.case === "messageStarted" && candidate.payload.kind.value.messageId === payload.value.messageId);
  if (starts.length > 1) return undefined;
  const start = starts[0]; const started = start?.payload?.kind.case === "messageStarted" ? start.payload.kind.value : undefined;
  if (started && started.role !== MessageRole.USER) return undefined;
  const current = payload.value.nativeIdentity; const before = started?.nativeIdentity;
  if (current && before && ["entryId", "parentEntryId"].some((key) => {
    const field = key as "entryId" | "parentEntryId";
    return current[field] && before[field] && current[field] !== before[field];
  })) return undefined;
  const targets = [current?.rewindBefore, before?.rewindBefore].filter((value): value is NativeNavigationTarget => value !== undefined);
  if (targets.length === 2 && toBinary(NativeNavigationTargetSchema, targets[0]!).toString()
    !== toBinary(NativeNavigationTargetSchema, targets[1]!).toString()) return undefined;
  const candidate = targets[0]; const kind = candidate?.kind;
  const target = kind?.case === "nativeEntryId" && validId(kind.value) || kind?.case === "sessionStart" && allowStart ? candidate : undefined;
  const runId = event.identity?.runId || start?.identity?.runId;
  if (event.identity?.runId && start?.identity?.runId && event.identity.runId !== start.identity.runId) return undefined;
  try {
    const draft = started?.userInputAccepted && started.userInput
      ? restoreMobileComposerInput(started.userInput, { sessionId, messageId: payload.value.messageId, eventId: start!.eventId })
      : plainTextMobileComposerDraft(payload.case === "messageCompleted"
        ? payload.value.blocks.flatMap((block) => block.content.case === "text" ? [block.content.value] : []).join("\n") : "");
    return { eventId, messageId: payload.value.messageId, draft, ...(target ? { target: clone(NativeNavigationTargetSchema, target) } : {}),
      ...(runId && validId(runId) ? { runId } : {}), sourceKey: JSON.stringify([eventId,
        bytesToHex(sha256(toBinary(EventSchema, event))), start ? bytesToHex(sha256(toBinary(EventSchema, start))) : ""]) };
  } catch { return undefined; }
}

export function mobileMessageChangeSet(changeSets: readonly WorkspaceChangeSet[], workspaceId: string, sessionId: string,
  runId: string): WorkspaceChangeSet | undefined {
  const matches = changeSets.filter((value) => value.workspaceId === workspaceId && value.sessionId === sessionId && value.runId === runId);
  matches.sort((left, right) => {
    const a = left.capturedAt; const b = right.capturedAt;
    return a?.seconds !== b?.seconds ? (a?.seconds ?? 0n) < (b?.seconds ?? 0n) ? 1 : -1 : (b?.nanos ?? 0) - (a?.nanos ?? 0);
  });
  if (matches.length > 1 && matches[0]!.capturedAt?.seconds === matches[1]!.capturedAt?.seconds
    && matches[0]!.capturedAt?.nanos === matches[1]!.capturedAt?.nanos) throw new Error("The message round has ambiguous Workspace checkpoints.");
  return matches[0];
}

export function assertMobileWorkspaceRewindPreview(preview: WorkspaceRewindPreview, workspaceId: string, changeSetId: string): void {
  if (!validId(preview.previewId) || preview.workspaceId !== workspaceId || preview.changeSetId !== changeSetId
    || ![RewindSafety.SAFE, RewindSafety.REQUIRES_CONFIRMATION, RewindSafety.BLOCKED].includes(preview.safety)
    || !preview.expiresAt || preview.expiresAt.seconds <= 0n || preview.expiresAt.seconds > 253_402_300_799n
    || !Number.isInteger(preview.expiresAt.nanos) || preview.expiresAt.nanos < 0 || preview.expiresAt.nanos >= 1_000_000_000
    || preview.inverseChanges.length > 2_000 || preview.gaps.length > 2_000 || preview.conflicts.length > 2_000) {
    throw new Error("The Joko node returned an invalid Workspace rewind preview.");
  }
  for (const change of preview.inverseChanges) {
    canonicalWorkspacePath(change.relativePath);
    if (change.oldRelativePath) canonicalWorkspacePath(change.oldRelativePath);
  }
  for (const issue of [...preview.gaps, ...preview.conflicts]) {
    if (issue.relativePath) canonicalWorkspacePath(issue.relativePath);
    if (issue.explanation.length > 16_384) throw new Error("The Workspace rewind explanation is too large.");
  }
}

export function mobileWorkspaceRewindExpiresAt(preview: WorkspaceRewindPreview): number {
  return Number(preview.expiresAt!.seconds) * 1_000 + preview.expiresAt!.nanos / 1_000_000;
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}
