import type { ContextView, TimelineItemView } from "../model.js";

export interface ActiveCompactionProjection {
  readonly itemId: string;
  readonly compactionId: string;
  readonly reason: NonNullable<TimelineItemView["compaction"]>["reason"];
  readonly automatic: boolean;
}

export function hasContextToCompact(context: ContextView | undefined, items: readonly TimelineItemView[]): boolean {
  if (context !== undefined) return context.usedTokens > 0;
  // A completed native compaction leaves context even when current usage is
  // unknown. The original backend decides whether another compaction is a no-op.
  return items.some(item => item.compaction?.piContextBoundary === true);
}

export function resolveActiveCompaction(
  items: readonly TimelineItemView[],
  authoritativeCompacting?: boolean
): ActiveCompactionProjection | undefined {
  let latest: TimelineItemView | undefined;
  for (const item of items) {
    if (item.compaction === undefined) continue;
    if (
      latest === undefined ||
      item.sequence > latest.sequence ||
      (item.sequence === latest.sequence && item.createdAt > latest.createdAt)
    ) latest = item;
  }
  // Pi's session-state observation is authoritative across reconnects. In
  // particular, a snapshot with compacting=false closes a STARTED row whose
  // terminal event was missed before the client reconnected.
  if (authoritativeCompacting === false || (latest?.compaction?.state !== "started" && authoritativeCompacting !== true)) return undefined;
  if (latest?.compaction?.state !== "started") {
    return {
      itemId: "authoritative-compaction",
      compactionId: "authoritative-compaction",
      reason: "unknown",
      automatic: false
    };
  }
  return {
    itemId: latest.id,
    compactionId: latest.compaction.id,
    reason: latest.compaction.reason,
    automatic: latest.compaction.automatic
  };
}
