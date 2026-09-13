export const SUBAGENT_LIVE_EDGE_DISTANCE_PX = 100;
export const SUBAGENT_UP_NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "Home",
  "PageUp"
]);

export interface SubagentVirtualAnchor {
  readonly itemId: string;
  readonly index: number;
  readonly offset: number;
}

export function resolveSubagentFollowingOnScroll({
  distanceFromEnd,
  scrollDelta
}: {
  readonly distanceFromEnd: number;
  readonly scrollDelta: number;
}): boolean {
  if (scrollDelta < 0) return false;
  if (distanceFromEnd <= SUBAGENT_LIVE_EDGE_DISTANCE_PX) return true;
  return false;
}

export function resolveSubagentAnchorIndex(
  itemIds: readonly string[],
  anchor: SubagentVirtualAnchor,
  previousItemIds?: readonly string[]
): number | undefined {
  if (itemIds.length === 0) return undefined;
  const durableIndex = itemIds.indexOf(anchor.itemId);
  if (durableIndex >= 0) return durableIndex;
  if (previousItemIds !== undefined) {
    const previousIndex = previousItemIds.indexOf(anchor.itemId);
    const candidateIndex = previousIndex >= 0 ? previousIndex + 1 : Math.min(anchor.index + 1, previousItemIds.length);
    const currentIndexById = new Map(itemIds.map((itemId, index) => [itemId, index]));
    for (let index = candidateIndex; index < previousItemIds.length; index += 1) {
      const successorId = previousItemIds[index];
      if (successorId === undefined) continue;
      const successorIndex = currentIndexById.get(successorId);
      if (successorIndex !== undefined) return successorIndex;
    }
  }
  return Math.min(anchor.index, itemIds.length - 1);
}

export function countUnreadSubagentItems(
  knownItemIds: ReadonlySet<string>,
  itemIds: readonly string[],
  anchor: SubagentVirtualAnchor | undefined
): number {
  const anchorIndex = anchor === undefined ? 0 : resolveSubagentAnchorIndex(itemIds, anchor) ?? 0;
  let count = 0;
  for (let index = anchorIndex; index < itemIds.length; index += 1) {
    const itemId = itemIds[index];
    if (itemId !== undefined && !knownItemIds.has(itemId)) count += 1;
  }
  return count;
}

export function nextSubagentTabIndex(
  currentIndex: number,
  itemCount: number,
  key: string
): number | undefined {
  if (itemCount <= 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return (currentIndex - 1 + itemCount) % itemCount;
  if (key === "ArrowRight" || key === "ArrowDown") return (currentIndex + 1) % itemCount;
  return undefined;
}
