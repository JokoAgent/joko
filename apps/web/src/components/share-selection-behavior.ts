import type { TimelineItemView } from "../model.js";

export interface ShareSelectionUpdate {
  readonly selectedIds: ReadonlySet<string>;
  readonly anchorId?: string;
}

export function shareableTimelineMessages(items: readonly TimelineItemView[]): readonly TimelineItemView[] {
  return items.filter((item) => (
    (item.kind === "user" || item.kind === "assistant")
    && item.streaming !== true
    && ((item.text?.trim().length ?? 0) > 0 || (item.attachments?.length ?? 0) > 0)
  ));
}

export function orderedSelectedShareMessages(
  items: readonly TimelineItemView[],
  selectedIds: ReadonlySet<string>
): readonly TimelineItemView[] {
  return shareableTimelineMessages(items).filter((item) => selectedIds.has(item.id));
}

export function toggleShareMessageSelection(
  orderedIds: readonly string[],
  current: ReadonlySet<string>,
  itemId: string,
  extendRange: boolean,
  anchorId?: string
): ShareSelectionUpdate {
  if (!orderedIds.includes(itemId)) return { selectedIds: current, ...(anchorId === undefined ? {} : { anchorId }) };
  const selectedIds = new Set(current);
  if (extendRange && anchorId !== undefined) {
    const anchorIndex = orderedIds.indexOf(anchorId);
    const itemIndex = orderedIds.indexOf(itemId);
    if (anchorIndex >= 0 && itemIndex >= 0) {
      const range = orderedIds.slice(Math.min(anchorIndex, itemIndex), Math.max(anchorIndex, itemIndex) + 1);
      const removeRange = range.every((id) => selectedIds.has(id));
      for (const id of range) {
        if (removeRange) selectedIds.delete(id);
        else selectedIds.add(id);
      }
      return { selectedIds, anchorId };
    }
  }
  if (selectedIds.has(itemId)) selectedIds.delete(itemId);
  else selectedIds.add(itemId);
  return { selectedIds, anchorId: itemId };
}

export function reconcileShareSelection(
  orderedIds: readonly string[],
  current: ReadonlySet<string>,
  anchorId?: string
): ShareSelectionUpdate {
  const available = new Set(orderedIds);
  const selectedIds = new Set([...current].filter((id) => available.has(id)));
  return {
    selectedIds,
    ...(anchorId !== undefined && available.has(anchorId) ? { anchorId } : {})
  };
}
