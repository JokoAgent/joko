import type { TimelineItemView } from "../model.js";

export interface ActiveCompactionProjection {
  readonly itemId: string;
  readonly compactionId: string;
  readonly reason: NonNullable<TimelineItemView["compaction"]>["reason"];
  readonly automatic: boolean;
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
