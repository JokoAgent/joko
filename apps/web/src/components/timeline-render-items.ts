import type { SessionView, TimelineItemView } from "../model.js";

/** History-window guard: a larger interval is treated as missing history. */
export const TIMELINE_WORK_HISTORY_GAP_MS = 30 * 60 * 1_000;

/** A running work block exposes only its most recent activity rows by default. */
export const MAX_RUNNING_WORK_CHILDREN = 5;

export interface TimelineHistoryGap {
  readonly previousItemId: string;
  readonly nextItemId: string;
  readonly durationMs: number;
}

interface TimelineRenderItemBase {
  /** Stable virtual-row key. Work rows are anchored to their first child id. */
  readonly key: string;
  /** Every durable timeline id covered by this row, for search and viewport recovery. */
  readonly childIds: readonly string[];
  /** Present when a discontinuous history window starts immediately before this row. */
  readonly historyGapBefore?: TimelineHistoryGap;
}

export interface TimelineLeafRenderItem extends TimelineRenderItemBase {
  readonly type: "item";
  readonly item: TimelineItemView;
}

export interface TimelineWorkRenderItem extends TimelineRenderItemBase {
  readonly type: "work";
  readonly firstChildId: string;
  readonly lastChildId: string;
  /** Complete, source-ordered activity history for explicit expansion. */
  readonly children: readonly TimelineItemView[];
  /** Initial child projection: latest five while running, empty while collapsed. */
  readonly visibleChildren: readonly TimelineItemView[];
  readonly hiddenChildCount: number;
  readonly running: boolean;
  readonly defaultCollapsed: boolean;
}

export interface TimelineDerivationOriginRenderItem extends TimelineRenderItemBase {
  readonly type: "derivationOrigin";
  readonly origin: NonNullable<SessionView["derivationOrigin"]>;
  readonly createdAt: number;
}

export type TimelineRenderItem = TimelineLeafRenderItem | TimelineWorkRenderItem | TimelineDerivationOriginRenderItem;

export interface TimelineRenderProjectionOptions {
  /** True while the owning session is running, waiting, or retrying. */
  readonly sessionActive?: boolean;
  readonly historyGapMs?: number;
}

/**
 * Keep activity classification structural. In particular, streamed status rows
 * always carry `streaming` (including `false` on their terminal update), while
 * run-complete / stopped / retry notices omit it and remain visible boundaries.
 */
export function isTimelineWorkActivity(item: TimelineItemView): boolean {
  return item.inlinePlan === undefined && (item.kind === "tool"
    || item.kind === "toolResult"
    || item.kind === "thinking"
    || (item.kind === "status" && item.streaming !== undefined));
}

/**
 * Project the durable flat timeline into structured work rows.
 *
 * User messages delimit turns. Every non-activity row is a hard boundary, so
 * assistant prose, media, artifacts, diffs, errors, interactions, background
 * tasks, compaction notices, and lifecycle statuses never disappear into work.
 * The function preserves source order and objects and never mutates its input.
 */
export function projectTimelineRenderItems(
  sourceItems: readonly TimelineItemView[],
  options: TimelineRenderProjectionOptions = {}
): readonly TimelineRenderItem[] {
  const historyGapMs = validHistoryGap(options.historyGapMs);
  const projected: TimelineRenderItem[] = [];
  let workChildren: TimelineItemView[] = [];
  let workGapBefore: TimelineHistoryGap | undefined;
  let pendingGapBefore: TimelineHistoryGap | undefined;
  let previousTimestamp: number | undefined;
  let previousTimestampItemId: string | undefined;

  const flushWork = (): void => {
    const first = workChildren[0];
    const last = workChildren.at(-1);
    if (first === undefined || last === undefined) return;
    const childIds = workChildren.map((child) => child.id);
    projected.push({
      type: "work",
      key: first.id,
      firstChildId: first.id,
      lastChildId: last.id,
      childIds,
      children: workChildren.slice(),
      visibleChildren: [],
      hiddenChildCount: workChildren.length,
      running: false,
      defaultCollapsed: true,
      ...(workGapBefore === undefined ? {} : { historyGapBefore: workGapBefore })
    });
    workChildren = [];
    workGapBefore = undefined;
  };

  for (const item of sourceItems) {
    const timestamp = finiteTimestamp(item.createdAt);
    const userBoundary = item.kind === "user";
    if (!userBoundary
      && timestamp !== undefined
      && previousTimestamp !== undefined
      && previousTimestampItemId !== undefined
      && timestamp - previousTimestamp > historyGapMs) {
      flushWork();
      pendingGapBefore = {
        previousItemId: previousTimestampItemId,
        nextItemId: item.id,
        durationMs: timestamp - previousTimestamp
      };
    }

    if (isTimelineWorkActivity(item)) {
      if (workChildren.length === 0) {
        workGapBefore = pendingGapBefore;
        pendingGapBefore = undefined;
      }
      workChildren.push(item);
    } else {
      flushWork();
      projected.push({
        type: "item",
        key: item.id,
        childIds: item.inlinePlan?.sourceItemIds ?? [item.id],
        item,
        ...(pendingGapBefore === undefined ? {} : { historyGapBefore: pendingGapBefore })
      });
      pendingGapBefore = undefined;
    }

    if (timestamp !== undefined) {
      // Preserve the latest known wall-clock anchor when provider events settle
      // out of order; otherwise a later row can manufacture a false gap.
      if (previousTimestamp === undefined || timestamp >= previousTimestamp || userBoundary) {
        previousTimestamp = timestamp;
        previousTimestampItemId = item.id;
      }
    }
  }
  flushWork();

  if (options.sessionActive !== true) return projected;
  const tail = projected.at(-1);
  if (tail?.type !== "work") return projected;

  const visibleChildren = tail.children.slice(-MAX_RUNNING_WORK_CHILDREN);
  projected[projected.length - 1] = {
    ...tail,
    visibleChildren,
    hiddenChildCount: tail.children.length - visibleChildren.length,
    running: true,
    defaultCollapsed: false
  };
  return projected;
}

/** Inserts immutable task lineage at its creation boundary without fabricating a timeline event. */
export function insertTimelineDerivationOrigin(
  items: readonly TimelineRenderItem[],
  origin: NonNullable<SessionView["derivationOrigin"]> | undefined,
  createdAt: number | undefined
): readonly TimelineRenderItem[] {
  if (origin === undefined || createdAt === undefined || !Number.isFinite(createdAt)) return items;
  const marker: TimelineDerivationOriginRenderItem = {
    type: "derivationOrigin",
    key: `derivation-origin:${origin.sourceSessionId}:${origin.sourceEventId ?? "task"}`,
    childIds: [],
    origin,
    createdAt
  };
  const firstNewerIndex = items.findIndex((item) => renderItemLastTimestamp(item) > createdAt);
  if (firstNewerIndex < 0) return [...items, marker];
  return [...items.slice(0, firstNewerIndex), marker, ...items.slice(firstNewerIndex)];
}

/**
 * Resolve either a render-row key or any covered durable child id. This is the
 * viewport/search fallback used when prepended history causes an older work row
 * to absorb earlier children and therefore acquire a new first-child key.
 */
export function findTimelineRenderItemIndex(
  items: readonly TimelineRenderItem[],
  keyOrChildId: string
): number {
  const exact = items.findIndex((item) => item.key === keyOrChildId);
  if (exact >= 0) return exact;
  return items.findIndex((item) => item.childIds.includes(keyOrChildId));
}

/** Build the immutable-by-contract child lookup once for virtualized consumers. */
export function timelineRenderChildIndex(
  items: readonly TimelineRenderItem[]
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  items.forEach((item, renderIndex) => {
    for (const childId of item.childIds) {
      if (!index.has(childId)) index.set(childId, renderIndex);
    }
  });
  return index;
}

function finiteTimestamp(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function renderItemLastTimestamp(item: TimelineRenderItem): number {
  if (item.type === "derivationOrigin") return item.createdAt;
  if (item.type === "item") return finiteTimestamp(item.item.createdAt) ?? Number.NEGATIVE_INFINITY;
  return item.children.reduce(
    (latest, child) => Math.max(latest, finiteTimestamp(child.createdAt) ?? Number.NEGATIVE_INFINITY),
    Number.NEGATIVE_INFINITY
  );
}

function validHistoryGap(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : TIMELINE_WORK_HISTORY_GAP_MS;
}
