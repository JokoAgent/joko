export const MESSAGE_NAV_BACKFILL_TARGET_ENTRIES = 8;
export const MESSAGE_NAV_BACKFILL_MAX_ROUNDS = 3;
export const MESSAGE_NAV_BACKFILL_IDLE_TIMEOUT_MS = 2_000;
export const MESSAGE_NAV_BACKFILL_FALLBACK_DELAY_MS = 300;

export interface MessageNavBackfillBudget {
  readonly sessionId: string;
  readonly rounds: number;
}

export interface MessageNavBackfillInput {
  readonly enabled: boolean;
  readonly entryCount: number;
  readonly hasEarlier: boolean;
  readonly historyLoading: boolean;
  readonly historyError?: string;
  readonly rounds: number;
}

export type MessageNavBackfillScheduler = Pick<Window, "setTimeout" | "clearTimeout">
  & Partial<Pick<Window, "requestIdleCallback" | "cancelIdleCallback">>;

export function resetMessageNavBackfillBudget(
  budget: MessageNavBackfillBudget,
  sessionId: string
): MessageNavBackfillBudget {
  return budget.sessionId === sessionId ? budget : { sessionId, rounds: 0 };
}

export function consumeMessageNavBackfillRound(budget: MessageNavBackfillBudget): MessageNavBackfillBudget {
  return {
    sessionId: budget.sessionId,
    rounds: Math.min(MESSAGE_NAV_BACKFILL_MAX_ROUNDS, budget.rounds + 1)
  };
}

export function shouldBackfillMessageNav(input: MessageNavBackfillInput): boolean {
  if (!input.enabled || !input.hasEarlier || input.historyLoading || input.historyError !== undefined) return false;
  if (input.rounds >= MESSAGE_NAV_BACKFILL_MAX_ROUNDS) return false;
  return input.entryCount < MESSAGE_NAV_BACKFILL_TARGET_ENTRIES;
}

export function scheduleMessageNavBackfill(
  run: () => void,
  scheduler: MessageNavBackfillScheduler = window
): () => void {
  if (typeof scheduler.requestIdleCallback === "function") {
    const handle = scheduler.requestIdleCallback(run, { timeout: MESSAGE_NAV_BACKFILL_IDLE_TIMEOUT_MS });
    return () => scheduler.cancelIdleCallback?.(handle);
  }
  const handle = scheduler.setTimeout(run, MESSAGE_NAV_BACKFILL_FALLBACK_DELAY_MS);
  return () => scheduler.clearTimeout(handle);
}
