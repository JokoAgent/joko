import type { CapabilityView, NativeNavigationTargetView, TargetView, TimelineItemView, WorkspaceChangeSetView } from "../model.js";
import { isInternalContinuationTimelineItem } from "../runtime-recovery.js";
import { sameMessageAttachments } from "./message-attachment-roundtrip.js";

export function sessionCapabilitySupportsTarget(capability: CapabilityView | undefined, target: TargetView | undefined): boolean {
  if (capability?.supported !== true) return false;
  if (capability.options.length === 0) return true;
  return capability.options.length === 1 && capability.options[0] === "service_node_only"
    && target !== undefined && target.remoteWorkspace === undefined;
}

export function lastVisibleUserMessage(items: readonly TimelineItemView[]): TimelineItemView | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user" && !isInternalContinuationTimelineItem(item)) return item;
  }
  return undefined;
}

export function canEditVisibleUserMessage(item: TimelineItemView | undefined, allowStart = false): item is TimelineItemView {
  return item?.kind === "user"
    && !isInternalContinuationTimelineItem(item)
    && messageDialogueRewindTarget(item, allowStart) !== undefined
    && (item.text?.trim().length ?? 0) > 0;
}

export function messageDialogueRewindTarget(item: TimelineItemView, allowStart = false): NativeNavigationTargetView | undefined {
  if (item.kind !== "user" || isInternalContinuationTimelineItem(item)) return undefined;
  const target = item.nativeRewindBefore;
  if (target?.kind === "session_start") return allowStart ? target : undefined;
  return target?.kind === "native_entry" && target.entryId.length > 0 ? target : undefined;
}

export function sameNativeNavigationTarget(left: NativeNavigationTargetView | undefined, right: NativeNavigationTargetView | undefined): boolean {
  return left !== undefined && right !== undefined && left.kind === right.kind
    && (left.kind === "session_start" || (right.kind === "native_entry" && left.entryId === right.entryId));
}

/** A native history read may replace the live receipt for the input whose Run was stopped. */
export function isPersistedStopEditSource(original: TimelineItemView, current: TimelineItemView): boolean {
  return original.kind === "user" && current.kind === "user" && original.id === current.id
    && original.userInputAccepted === true && current.userInputAccepted === true
    && original.nativeEntryId !== undefined && current.nativeEntryId === original.nativeEntryId
    && original.nativeParentEntryId === current.nativeParentEntryId
    && original.runId !== undefined && current.runId === original.runId
    && original.inputOperationId !== undefined && current.inputOperationId === original.inputOperationId
    && current.sourceEventId !== undefined && /^native-event-[a-f0-9]{64}$/u.test(current.sourceEventId)
    && original.completionCursor !== undefined && current.completionCursor !== undefined && current.completionCursor > original.completionCursor
    && original.text === current.text && original.quotesEncoded === current.quotesEncoded
    && sameMessageAttachments(original.attachments, current.attachments)
    && sameNativeNavigationTarget(messageDialogueRewindTarget(original), messageDialogueRewindTarget(current));
}

export function messageRoundRunId(items: readonly TimelineItemView[], userMessageId: string): string | undefined {
  const start = items.findIndex((item) => item.id === userMessageId && item.kind === "user" && !isInternalContinuationTimelineItem(item));
  if (start < 0) return undefined;
  const userRunId = items[start]?.runId;
  if (userRunId !== undefined && userRunId.length > 0) return userRunId;
  for (let index = start + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined || item.kind === "user" && !isInternalContinuationTimelineItem(item)) break;
    if (item.runId !== undefined && item.runId.length > 0) return item.runId;
  }
  return undefined;
}

export function changeSetForMessageRound(
  changeSets: readonly WorkspaceChangeSetView[],
  runId: string | undefined
): WorkspaceChangeSetView | undefined {
  if (runId === undefined) return undefined;
  return [...changeSets]
    .filter((changeSet) => changeSet.runId === runId)
    .sort((left, right) => right.capturedAt - left.capturedAt)[0];
}
