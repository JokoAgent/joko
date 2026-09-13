import type { NativeNavigationTargetView, TimelineItemView, WorkspaceChangeSetView } from "../model.js";

export function lastVisibleUserMessage(items: readonly TimelineItemView[]): TimelineItemView | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user") return item;
  }
  return undefined;
}

export function canEditVisibleUserMessage(item: TimelineItemView | undefined, allowStart = false): item is TimelineItemView {
  return item?.kind === "user"
    && messageDialogueRewindTarget(item, allowStart) !== undefined
    && (item.text?.trim().length ?? 0) > 0;
}

export function messageDialogueRewindTarget(item: TimelineItemView, allowStart = false): NativeNavigationTargetView | undefined {
  if (item.kind !== "user") return undefined;
  const target = item.nativeRewindBefore;
  if (target?.kind === "session_start") return allowStart ? target : undefined;
  return target?.kind === "native_entry" && target.entryId.length > 0 ? target : undefined;
}

export function sameNativeNavigationTarget(left: NativeNavigationTargetView | undefined, right: NativeNavigationTargetView | undefined): boolean {
  return left !== undefined && right !== undefined && left.kind === right.kind
    && (left.kind === "session_start" || (right.kind === "native_entry" && left.entryId === right.entryId));
}

export function messageRoundRunId(items: readonly TimelineItemView[], userMessageId: string): string | undefined {
  const start = items.findIndex((item) => item.id === userMessageId && item.kind === "user");
  if (start < 0) return undefined;
  const userRunId = items[start]?.runId;
  if (userRunId !== undefined && userRunId.length > 0) return userRunId;
  for (let index = start + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined || item.kind === "user") break;
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
