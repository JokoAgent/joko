import { describe, expect, it } from "vitest";
import type { SessionView, TimelineItemView } from "../model.js";
import { hasVisibleAutoRetryNotice, hidesFromTimelineHistory, resolveActiveRetry, resolveRetryEscapeIntent, retryCountdownSeconds, type RetryEscapeContext, type RetryEscapeInput } from "./retry-status-behavior.js";

const retryingSession = { state: "retrying", activeRunId: "run-a" } satisfies Pick<SessionView, "state" | "activeRunId">;

describe("Pi retry status projection", () => {
  it("restores the newest waiting update for the active retry run", () => {
    const items = [
      retryItem("old", 1n, "run-a", "waiting", 1, 3, 5_000),
      retryItem("other", 4n, "run-b", "waiting", 9, 9, 9_000),
      retryItem("current", 3n, "run-a", "waiting", 2, 3, 8_000)
    ];

    expect(resolveActiveRetry(items, retryingSession)).toEqual({
      itemId: "current",
      runId: "run-a",
      source: "auto",
      attemptNumber: 2,
      maxAttempts: 3,
      retryAt: 8_000
    });
  });

  it("clears on authoritative run state or a later retry lifecycle update", () => {
    const waiting = retryItem("wait", 1n, "run-a", "waiting", 1, 3, 5_000);
    expect(resolveActiveRetry([waiting], { ...retryingSession, state: "running" })).toBeUndefined();
    expect(resolveActiveRetry([waiting, retryItem("start", 2n, "run-a", "started", 1)], retryingSession)).toBeUndefined();
    expect(resolveActiveRetry([waiting, retryItem("done", 2n, "run-a", "succeeded", 1)], retryingSession)).toBeUndefined();
  });

  it("ceil-counts to zero and never becomes negative", () => {
    expect(retryCountdownSeconds(5_001, 4_000)).toBe(2);
    expect(retryCountdownSeconds(5_000, 4_000)).toBe(1);
    expect(retryCountdownSeconds(5_000, 5_001)).toBe(0);
    expect(retryCountdownSeconds(undefined, 5_001)).toBeUndefined();
  });

  it("treats only later classified overloads as visible auto-retry notices", () => {
    const overload = retryError("UPSTREAM_OVERLOAD");
    expect(hasVisibleAutoRetryNotice(activeRetry(1, overload))).toBe(false);
    expect(hasVisibleAutoRetryNotice(activeRetry(2, overload))).toBe(true);
    expect(hasVisibleAutoRetryNotice(activeRetry(2, retryError("UPSTREAM_STREAM_INTERRUPTED")))).toBe(false);
    expect(hasVisibleAutoRetryNotice(activeRetry(2, retryError("PI_TRANSIENT_PROVIDER_ERROR")))).toBe(false);
    expect(hasVisibleAutoRetryNotice(activeRetry(2))).toBe(false);
  });

  it("keeps retry events durable while hiding them from transcript history", () => {
    expect(hidesFromTimelineHistory(retryItem("wait", 1n, "run-a", "waiting", 1))).toBe(true);
    expect(hidesFromTimelineHistory({ id: "compact", sequence: 2n, kind: "compaction", createdAt: 2, compaction: { id: "c", state: "started", reason: "manual", automatic: false } })).toBe(true);
    expect(hidesFromTimelineHistory({ id: "compact-done", sequence: 3n, kind: "compaction", createdAt: 3, compaction: { id: "c", state: "completed", reason: "manual", automatic: false } })).toBe(false);
    expect(hidesFromTimelineHistory({
      id: "run:run-failed",
      sequence: 4n,
      kind: "status",
      createdAt: 4,
      title: "run_done",
      text: "failed",
      streaming: false
    })).toBe(true);
    expect(hidesFromTimelineHistory({
      id: "status-user-visible",
      sequence: 5n,
      kind: "status",
      createdAt: 5,
      title: "run_done",
      text: "failed",
      streaming: false
    })).toBe(false);
    expect(hidesFromTimelineHistory({ id: "message", sequence: 2n, kind: "assistant", createdAt: 2 })).toBe(false);
  });

  it("lets SessionPane cancel the current cancellable auto-retry from non-editor chrome", () => {
    expect(resolveRetryEscapeIntent(retryEscapeInput(), retryEscapeContext())).toEqual({
      kind: "abortRetry",
      runId: "run-a"
    });
  });

  it.each([
    ["repeat", { repeat: true }],
    ["IME composition", { isComposing: true }],
    ["an already handled key", { defaultPrevented: true }],
    ["a modal", { modalOpen: true }],
    ["a text editor", { target: "editable" as const }],
    ["the Composer", { target: "composer" as const }],
    ["an open disclosure", { target: "disclosure" as const }],
    ["a different key", { key: "Enter" }]
  ])("leaves Escape to %s", (_label, override) => {
    expect(resolveRetryEscapeIntent({ ...retryEscapeInput(), ...override }, retryEscapeContext())).toBeNull();
  });

  it.each([
    ["a non-retrying session", { sessionState: "running" as const }],
    ["an unavailable abort capability", { canAbortRetry: false }],
    ["a missing active run", { activeRunId: undefined }],
    ["a stale retry run", { retry: { runId: "run-b", source: "auto" as const } }],
    ["a summarization retry", { retry: { runId: "run-a", source: "summarization" as const } }]
  ])("does not cancel %s", (_label, override) => {
    expect(resolveRetryEscapeIntent(retryEscapeInput(), { ...retryEscapeContext(), ...override })).toBeNull();
  });
});

function retryEscapeInput(): RetryEscapeInput {
  return {
    key: "Escape",
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    modalOpen: false,
    target: "other"
  };
}

function retryEscapeContext(): RetryEscapeContext {
  return {
    sessionState: "retrying",
    activeRunId: "run-a",
    retry: { runId: "run-a", source: "auto" },
    canAbortRetry: true
  };
}

function activeRetry(attemptNumber: number, error?: NonNullable<TimelineItemView["retry"]>["error"]) {
  return {
    itemId: `retry-${attemptNumber}`,
    runId: "run-a",
    source: "auto" as const,
    attemptNumber,
    ...(error === undefined ? {} : { error })
  };
}

function retryError(code: string): NonNullable<NonNullable<TimelineItemView["retry"]>["error"]> {
  return {
    code,
    message: "redacted provider detail",
    phase: "retry",
    severity: "retryable",
    retryable: true,
    recovery: []
  };
}

function retryItem(
  id: string,
  sequence: bigint,
  runId: string,
  state: NonNullable<TimelineItemView["retry"]>["state"],
  attemptNumber: number,
  maxAttempts?: number,
  retryAt?: number
): TimelineItemView {
  return {
    id,
    sequence,
    runId,
    kind: "status",
    createdAt: Number(sequence),
    retry: {
      state,
      source: "auto",
      attemptNumber,
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
      ...(retryAt === undefined ? {} : { retryAt })
    }
  };
}
