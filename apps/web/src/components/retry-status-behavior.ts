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
  readonly retry?: Pick<ActiveRetryProjection, "runId" | "source">;
  readonly canAbortRetry: boolean;
}

export type RetryEscapeIntent = { readonly kind: "abortRetry"; readonly runId: string } | null;

/**
 * Session-level Escape is intentionally narrower than Composer Escape: it only
 * fills the timeline/header gap while higher-priority UI gets the key first.
 */
export function resolveRetryEscapeIntent(input: RetryEscapeInput, context: RetryEscapeContext): RetryEscapeIntent {
  if (
    input.key !== "Escape" ||
    input.repeat ||
    input.isComposing ||
    input.defaultPrevented ||
    input.modalOpen ||
    input.target !== "other" ||
    context.sessionState !== "retrying" ||
    !context.canAbortRetry ||
    context.activeRunId === undefined ||
    context.retry?.source !== "auto" ||
    context.retry.runId !== context.activeRunId
  ) return null;
  return { kind: "abortRetry", runId: context.activeRunId };
}

/**
 * Pi's RetryStatusIndicator exists only while a retry delay is active. The
 * durable event remains in history so reconnects can rebuild that transient
 * state, but a terminal/started update and the authoritative run state clear it.
 */
export function resolveActiveRetry(
  items: readonly TimelineItemView[],
  session: Pick<SessionView, "state" | "activeRunId">
): ActiveRetryProjection | undefined {
  if (session.state !== "retrying" || session.activeRunId === undefined) return undefined;

  let latest: TimelineItemView | undefined;
  for (const item of items) {
    if (item.runId !== session.activeRunId || item.retry === undefined) continue;
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
