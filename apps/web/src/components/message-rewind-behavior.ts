import type { TimelineItemView, WorkspaceChangeSetView } from "../model.js";

export function lastVisibleUserMessage(items: readonly TimelineItemView[]): TimelineItemView | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user") return item;
  }
  return undefined;
}

export function canEditVisibleUserMessage(item: TimelineItemView | undefined): item is TimelineItemView {
  return item?.kind === "user"
    && item.nativeParentEntryId !== undefined
    && item.nativeParentEntryId.length > 0
    && (item.text?.trim().length ?? 0) > 0;
}

export function messageDialogueRewindTarget(item: TimelineItemView): string | undefined {
  if (item.kind !== "user") return undefined;
  const target = item.nativeParentEntryId?.trim();
  return target === undefined || target.length === 0 ? undefined : target;
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
