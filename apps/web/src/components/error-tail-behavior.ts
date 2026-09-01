import type { QueueItemView, SessionAttentionView, TimelineHistoryCursorView, TimelineItemView } from "../model.js";

export type ErrorTailLocalDisposition = "none" | "inFlight" | "handled" | "dismissed";

export interface ErrorTailResolution {
  readonly item: TimelineItemView;
  readonly localKey: string;
  readonly bannerVisible: boolean;
  readonly hideFromTimeline: boolean;
  readonly queueContinuation: boolean;
}

const CONTINUATION_QUEUE_STATES = new Set<QueueItemView["state"]>([
  "accepted",
  "queued",
  "dispatching",
  "acceptedByBackend",
  "dispatchUnknown"
]);

/** The durable event sequence, rather than array position, owns the current tail. */
export function findDurableErrorTail(items: readonly TimelineItemView[]): TimelineItemView | undefined {
  let tail: TimelineItemView | undefined;
  for (const item of items) {
    // The Pi failure sequence ends with a typed Core done(outcome=failed)
    // lifecycle fact. Its current wire representation is an internal terminal
    // status marker; it must not displace the preceding user-facing terminal
    // error that owns SessionAttention.subjectCursor.
    if (isInternalFailedRunDone(item)) continue;
    if (tail === undefined || item.sequence >= tail.sequence) tail = item;
  }
  return tail?.kind === "error" ? tail : undefined;
}

export function isInternalFailedRunDone(item: TimelineItemView): boolean {
  return item.kind === "status"
    && item.id.startsWith("run:")
    && item.title === "run_done"
    && item.text === "failed"
    && item.streaming === false;
}

export function errorTailLocalKey(sessionId: string, itemId: string): string {
  return `${sessionId}\u0000${itemId}`;
}

/** Any non-terminal item for this task already owns the next queue continuation. */
export function hasErrorTailQueueContinuation(
  queue: readonly QueueItemView[],
  sessionId: string
): boolean {
  return queue.some((item) =>
    item.sessionId === sessionId
    && CONTINUATION_QUEUE_STATES.has(item.state)
  );
}

/**
 * Durable tail projection. A local dismissal returns the error to static history;
 * running/queued/handled states keep the stale tail out of both surfaces until activity advances it.
 */
export function resolveErrorTail(
  sessionId: string,
  items: readonly TimelineItemView[],
  queue: readonly QueueItemView[],
  sessionActive: boolean,
  disposition: ErrorTailLocalDisposition,
  attention?: SessionAttentionView
): ErrorTailResolution | undefined {
  const item = findDurableErrorTail(items);
  if (item === undefined) return undefined;
  const localKey = errorTailLocalKey(sessionId, item.id);
  const queueContinuation = hasErrorTailQueueContinuation(queue, sessionId);
  const durablyDismissed = attention !== undefined
    && attention.readThroughCursor.sequence >= item.sequence;
  if (disposition === "dismissed" || durablyDismissed) {
    return { item, localKey, bannerVisible: false, hideFromTimeline: false, queueContinuation };
  }
  const bannerVisible = !sessionActive && !queueContinuation && disposition === "none";
  return {
    item,
    localKey,
    bannerVisible,
    hideFromTimeline: bannerVisible || sessionActive || queueContinuation || disposition === "inFlight" || disposition === "handled",
    queueContinuation
  };
}

/** Exact source matching prevents an old error receipt from hiding a newer
 * tail that arrived before its own attention projection. */
export function explicitErrorAttentionCursor(
  attention: SessionAttentionView | undefined,
  item: TimelineItemView
): TimelineHistoryCursorView | undefined {
  return attention?.kind === "error"
    && attention.unread
    && attention.subjectCursor.sequence === item.sequence
    ? attention.attentionCursor
    : undefined;
}

/**
 * Bounded optimistic projection for in-flight actions. Durable error dismissal
 * is owned by SessionAttention; this store only prevents duplicate clicks and
 * retains the static-history presentation until the authoritative event lands.
 */
export class ErrorTailLocalProjectionStore {
  readonly #entries = new Map<string, Exclude<ErrorTailLocalDisposition, "none">>();
  readonly #maximumEntries: number;

  constructor(maximumEntries = 256) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) throw new Error("Error-tail projection capacity must be a positive integer.");
    this.#maximumEntries = maximumEntries;
  }

  read(key: string): ErrorTailLocalDisposition {
    return this.#entries.get(key) ?? "none";
  }

  begin(key: string): boolean {
    if (this.#entries.has(key)) return false;
    this.remember(key, "inFlight");
    return true;
  }

  succeed(key: string): void {
    if (this.#entries.get(key) === "inFlight") this.remember(key, "handled");
  }

  fail(key: string): void {
    if (this.#entries.get(key) === "inFlight") this.#entries.delete(key);
  }

  dismiss(key: string): void {
    this.remember(key, "dismissed");
  }

  get size(): number {
    return this.#entries.size;
  }

  private remember(key: string, disposition: Exclude<ErrorTailLocalDisposition, "none">): void {
    this.#entries.delete(key);
    this.#entries.set(key, disposition);
    while (this.#entries.size > this.#maximumEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
