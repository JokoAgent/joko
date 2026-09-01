import type { PersistedEvent } from "@joko/store";

export interface RuntimeActivityEventSource {
  readonly subscribe: (subscriber: (event: PersistedEvent) => void | Promise<void>) => () => void;
}

export interface RuntimeActivityTracker {
  /** Refresh the conservative post-activity quiet-period fence. */
  readonly markBlockingActivity: () => void;
  readonly lastBlockingActivityAt: () => number | undefined;
  readonly close: () => void;
}

/**
 * Process-authoritative, content-free memory for short activity windows.
 *
 * Point-in-time probes alone can miss a task that starts and finishes between
 * two Desktop polls. Every product effect must persist an Event before it is
 * published, so observing committed Events records both durable task progress
 * and terminal boundaries. Independent volatile coordinators also call
 * markBlockingActivity directly at their transition boundaries.
 *
 * Marking every committed product Event is intentionally conservative: a
 * recoverable-only Event may postpone an unattended relaunch, but it can never
 * make an unsafe relaunch eligible. No Event content is retained.
 */
export function createRuntimeActivityTracker(
  source: RuntimeActivityEventSource,
  now: () => number = Date.now
): RuntimeActivityTracker {
  const startedAt = now();
  // Process startup is itself a conservative authority boundary, so the quiet
  // period always begins at the current Orchestrator process lifetime boundary.
  let lastBlockingActivityAt: number | undefined = Number.isFinite(startedAt) ? startedAt : undefined;
  let closed = false;

  const markBlockingActivity = (): void => {
    if (closed) return;
    const observedAt = now();
    if (!Number.isFinite(observedAt)) return;
    lastBlockingActivityAt = lastBlockingActivityAt === undefined
      ? observedAt
      : Math.max(lastBlockingActivityAt, observedAt);
  };
  const unsubscribe = source.subscribe(() => markBlockingActivity());

  return Object.freeze({
    markBlockingActivity,
    lastBlockingActivityAt: () => lastBlockingActivityAt,
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
    }
  });
}
