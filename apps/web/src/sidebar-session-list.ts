export const SIDEBAR_SESSION_LIST_MINIMUM_VISIBLE = 5;
export const SIDEBAR_SESSION_LIST_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface SidebarSessionListViewInput<T> {
  readonly items: readonly T[];
  readonly showAll: boolean;
  readonly isCurrent: (item: T) => boolean;
  readonly hasAttention: (item: T) => boolean;
  readonly activityAt: (item: T) => number;
  readonly nowMs: number;
  readonly minimumVisible?: number;
  readonly recentWindowMs?: number;
}

export interface SidebarSessionListView<T> {
  readonly visibleItems: readonly T[];
  readonly totalCount: number;
  readonly hiddenCount: number;
  readonly overflowing: boolean;
}

/**
 * Keeps long task lists compact without hiding current, recent, or actionable
 * work. If the current task would otherwise be hidden, the complete list stays
 * visible so navigation never makes the selected row disappear.
 */
export function sidebarSessionListView<T>({
  items,
  showAll,
  isCurrent,
  hasAttention,
  activityAt,
  nowMs,
  minimumVisible = SIDEBAR_SESSION_LIST_MINIMUM_VISIBLE,
  recentWindowMs = SIDEBAR_SESSION_LIST_RECENT_WINDOW_MS
}: SidebarSessionListViewInput<T>): SidebarSessionListView<T> {
  const totalCount = items.length;
  const allVisible = (): SidebarSessionListView<T> => ({
    visibleItems: items,
    totalCount,
    hiddenCount: 0,
    overflowing: false
  });
  if (showAll) return allVisible();

  const headCount = Number.isFinite(minimumVisible)
    ? Math.max(0, Math.round(minimumVisible))
    : SIDEBAR_SESSION_LIST_MINIMUM_VISIBLE;
  const boundedWindow = Number.isFinite(recentWindowMs) ? Math.max(0, recentWindowMs) : 0;
  const recentSince = Number.isFinite(nowMs) ? nowMs - boundedWindow : Number.POSITIVE_INFINITY;
  const visibleAt = (item: T, index: number): boolean =>
    index < headCount || activityAt(item) >= recentSince || hasAttention(item);

  if (items.some((item, index) => isCurrent(item) && !visibleAt(item, index))) return allVisible();

  const visibleItems = items.filter(visibleAt);
  const hiddenCount = totalCount - visibleItems.length;
  return {
    visibleItems,
    totalCount,
    hiddenCount,
    overflowing: hiddenCount > 0
  };
}
