import type { PersistedEvent } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { createRuntimeActivityTracker } from "./runtime-activity-tracker.js";

describe("Runtime activity quiet-period tracker", () => {
  it("retains committed short-task boundaries without retaining event content", () => {
    let subscriber: ((event: PersistedEvent) => unknown) | undefined;
    let now = 1_000;
    const unsubscribe = vi.fn();
    const tracker = createRuntimeActivityTracker({
      subscribe: (next) => {
        subscriber = next;
        return unsubscribe;
      }
    }, () => now);

    expect(tracker.lastBlockingActivityAt()).toBe(1_000);
    subscriber?.({ payload: { type: "status", key: "short-task" } } as PersistedEvent);
    expect(tracker.lastBlockingActivityAt()).toBe(1_000);

    // A backwards wall-clock adjustment must not shorten the safety fence.
    now = 900;
    tracker.markBlockingActivity();
    expect(tracker.lastBlockingActivityAt()).toBe(1_000);

    now = 2_000;
    tracker.markBlockingActivity();
    expect(tracker.lastBlockingActivityAt()).toBe(2_000);

    tracker.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    now = 3_000;
    subscriber?.({ payload: { type: "done", outcome: "completed" } } as PersistedEvent);
    expect(tracker.lastBlockingActivityAt()).toBe(2_000);
  });

  it("ignores unreadable clocks without weakening an existing fence", () => {
    let now = Number.NaN;
    const tracker = createRuntimeActivityTracker({ subscribe: () => () => undefined }, () => now);
    tracker.markBlockingActivity();
    expect(tracker.lastBlockingActivityAt()).toBeUndefined();
    now = 4_000;
    tracker.markBlockingActivity();
    expect(tracker.lastBlockingActivityAt()).toBe(4_000);
    now = Number.POSITIVE_INFINITY;
    tracker.markBlockingActivity();
    expect(tracker.lastBlockingActivityAt()).toBe(4_000);
  });
});
