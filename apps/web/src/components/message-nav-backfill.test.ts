import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_NAV_BACKFILL_FALLBACK_DELAY_MS,
  MESSAGE_NAV_BACKFILL_IDLE_TIMEOUT_MS,
  MESSAGE_NAV_BACKFILL_MAX_ROUNDS,
  MESSAGE_NAV_BACKFILL_TARGET_ENTRIES,
  consumeMessageNavBackfillRound,
  resetMessageNavBackfillBudget,
  scheduleMessageNavBackfill,
  shouldBackfillMessageNav,
  type MessageNavBackfillScheduler
} from "./message-nav-backfill.js";

describe("message navigation idle history backfill", () => {
  it("loads only an enabled, undersized, healthy history window within budget", () => {
    const eligible = {
      enabled: true,
      entryCount: MESSAGE_NAV_BACKFILL_TARGET_ENTRIES - 1,
      hasEarlier: true,
      historyLoading: false,
      rounds: MESSAGE_NAV_BACKFILL_MAX_ROUNDS - 1
    };

    expect(shouldBackfillMessageNav(eligible)).toBe(true);
    expect(shouldBackfillMessageNav({ ...eligible, enabled: false })).toBe(false);
    expect(shouldBackfillMessageNav({ ...eligible, entryCount: MESSAGE_NAV_BACKFILL_TARGET_ENTRIES })).toBe(false);
    expect(shouldBackfillMessageNav({ ...eligible, hasEarlier: false })).toBe(false);
    expect(shouldBackfillMessageNav({ ...eligible, historyLoading: true })).toBe(false);
    expect(shouldBackfillMessageNav({ ...eligible, historyError: "unavailable" })).toBe(false);
    expect(shouldBackfillMessageNav({ ...eligible, rounds: MESSAGE_NAV_BACKFILL_MAX_ROUNDS })).toBe(false);
  });

  it("caps consumption at three rounds and resets the budget for a different session", () => {
    const initial = { sessionId: "session-a", rounds: 0 };
    const exhausted = Array.from({ length: 5 }).reduce(consumeMessageNavBackfillRound, initial);
    expect(exhausted).toEqual({ sessionId: "session-a", rounds: MESSAGE_NAV_BACKFILL_MAX_ROUNDS });
    expect(resetMessageNavBackfillBudget(exhausted, "session-a")).toBe(exhausted);
    expect(resetMessageNavBackfillBudget(exhausted, "session-b")).toEqual({ sessionId: "session-b", rounds: 0 });
  });

  it("prefers a two-second idle callback and cancels it", () => {
    let idleRun: (() => void) | undefined;
    const run = vi.fn();
    const scheduler = {
      requestIdleCallback: vi.fn((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
        idleRun = () => callback({ didTimeout: false, timeRemaining: () => 12 });
        expect(options).toEqual({ timeout: MESSAGE_NAV_BACKFILL_IDLE_TIMEOUT_MS });
        return 17;
      }),
      cancelIdleCallback: vi.fn(),
      setTimeout: vi.fn(),
      clearTimeout: vi.fn()
    } as unknown as MessageNavBackfillScheduler;

    const cancel = scheduleMessageNavBackfill(run, scheduler);
    expect(scheduler.setTimeout).not.toHaveBeenCalled();
    idleRun?.();
    expect(run).toHaveBeenCalledOnce();
    cancel();
    expect(scheduler.cancelIdleCallback).toHaveBeenCalledWith(17);
  });

  it("falls back to a cancellable 300ms timer", () => {
    let timerRun: (() => void) | undefined;
    const run = vi.fn();
    const scheduler = {
      setTimeout: vi.fn((callback: TimerHandler, delay?: number) => {
        timerRun = callback as () => void;
        expect(delay).toBe(MESSAGE_NAV_BACKFILL_FALLBACK_DELAY_MS);
        return 23;
      }),
      clearTimeout: vi.fn()
    } as unknown as MessageNavBackfillScheduler;

    const cancel = scheduleMessageNavBackfill(run, scheduler);
    timerRun?.();
    expect(run).toHaveBeenCalledOnce();
    cancel();
    expect(scheduler.clearTimeout).toHaveBeenCalledWith(23);
  });
});
