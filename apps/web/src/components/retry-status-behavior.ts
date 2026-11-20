import { codexRetryProgressKind } from "@joko/contracts";
import type { ErrorView, SessionView, TimelineItemView } from "../model.js";
import { isInternalFailedRunDone } from "./error-tail-behavior.js";

export interface ActiveRetryProjection {
  readonly itemId: string;
  readonly runId: string;
  readonly source: "auto" | "summarization" | "unknown";
  readonly attemptNumber: number;
  readonly maxAttempts?: number;
  readonly retryAt?: number;
  readonly error?: ErrorView;
}

export type RetryEscapeTarget = "other" | "editable" | "composer" | "disclosure";

export interface RetryEscapeInput {
  readonly key: string;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
  readonly modalOpen: boolean;
  readonly target: RetryEscapeTarget;
}

export interface RetryEscapeContext {
  readonly sessionState: SessionView["state"];
  readonly activeRunId?: string;
  readonly retry?: Pick<ActiveRetryProjection, "runId" | "source" | "error">;
  readonly canAbortRetry: boolean;
  readonly canAbortRun?: boolean;
}

type RetryStopAction = "abortRetry" | "abort";
export type RetryEscapeIntent = { readonly kind: RetryStopAction; readonly runId: string } | null;

export function resolveRetryStopAction(retry: RetryEscapeContext["retry"], capabilities: Pick<RetryEscapeContext, "canAbortRetry" | "canAbortRun">): RetryStopAction | undefined {
  if (retry?.source === "auto") {
    if (capabilities.canAbortRun) return "abort";
    if (capabilities.canAbortRetry) return "abortRetry";
  }
  if (capabilities.canAbortRun && retry?.source === "unknown"
    && (retry.error?.code === "CLAUDE_CODE_API_RETRY" || codexRetryProgressKind(retry.error?.code))) return "abort";
  return undefined;
}

/**
 * Session-level Escape is intentionally narrower than Composer Escape: it only
 * fills the timeline/header gap while higher-priority UI gets the key first.
 */
export function resolveRetryEscapeIntent(input: RetryEscapeInput, context: RetryEscapeContext): RetryEscapeIntent {
  const action = resolveRetryStopAction(context.retry, context);
  if (
    input.key !== "Escape" ||
    input.repeat ||
    input.isComposing ||
    input.defaultPrevented ||
    input.modalOpen ||
    input.target !== "other" ||
    context.sessionState !== "retrying" ||
    context.activeRunId === undefined ||
    context.retry?.runId !== context.activeRunId ||
    action === undefined
  ) return null;
  return { kind: action, runId: context.activeRunId };
}

/**
 * Retry progress can be rebuilt from durable events. The current Run and the
 * latest lifecycle update determine whether it still belongs in the status slot.
 */
export function resolveActiveRetry(
  items: readonly TimelineItemView[],
  session: Pick<SessionView, "state" | "activeRunId" | "activeAttemptId"> & Partial<Pick<SessionView, "generation">>
): ActiveRetryProjection | undefined {
  if (session.state !== "retrying" || session.activeRunId === undefined) return undefined;

  let latest: TimelineItemView | undefined;
  for (const item of items) {
    if (item.runId !== session.activeRunId || item.retry === undefined) continue;
    if (codexRetryProgressKind(item.retry.error?.code) && (!item.retry.attemptId
      || item.retry.attemptId !== session.activeAttemptId || item.retry.generation !== session.generation)) continue;
    if (
      latest === undefined ||
      item.sequence > latest.sequence ||
      (item.sequence === latest.sequence && item.createdAt > latest.createdAt)
    ) latest = item;
  }

  if (latest?.retry?.state !== "waiting") return undefined;
  return {
    itemId: latest.id,
    runId: session.activeRunId,
    source: latest.retry.source,
    attemptNumber: latest.retry.attemptNumber,
    ...(latest.retry.maxAttempts === undefined ? {} : { maxAttempts: latest.retry.maxAttempts }),
    ...(latest.retry.retryAt === undefined ? {} : { retryAt: latest.retry.retryAt }),
    ...(latest.retry.error === undefined ? {} : { error: latest.retry.error })
  };
}

/**
 * Native retry state remains durable for reconnect and cancellation, while UI
 * notice eligibility stays deliberately closed to later capacity retries.
 */
export function hasVisibleAutoRetryNotice(retry: ActiveRetryProjection): boolean {
  return retry.source === "auto"
    && retry.attemptNumber >= 2
    && retry.error?.code === "UPSTREAM_OVERLOAD";
}

/** Matches Pi's CountdownTimer: ceiling seconds, then hold at zero. */
export function retryCountdownSeconds(retryAt: number | undefined, now: number): number | undefined {
  if (retryAt === undefined || !Number.isFinite(retryAt) || !Number.isFinite(now)) return undefined;
  return Math.max(0, Math.ceil((retryAt - now) / 1_000));
}

export function hidesFromTimelineHistory(item: TimelineItemView): boolean {
  return item.retry !== undefined
    || item.compaction?.state === "started"
    || isInternalFailedRunDone(item);
}
