import type { QueueItemView, SessionAttentionView, TimelineItemView } from "../model.js";
import { describe, expect, it } from "vitest";
import { ErrorTailLocalProjectionStore, errorTailLocalKey, explicitErrorAttentionCursor, findDurableErrorTail, hasErrorTailQueueContinuation, resolveErrorTail } from "./error-tail-behavior.js";

describe("durable error-tail projection", () => {
  it("selects only the highest-sequence durable error at the current tail", () => {
    const error = item("error-1", 2n, "error");
    expect(findDurableErrorTail([error, item("assistant-old", 1n, "assistant")])).toBe(error);
    expect(findDurableErrorTail([error, item("assistant-new", 3n, "assistant")])).toBeUndefined();
  });

  it("keeps the terminal error as tail across Pi's later internal failed-done marker", () => {
    const error = item("error-run-1", 20n, "error");
    const failedDone: TimelineItemView = {
      id: "run:run-1",
      runId: "run-1",
      sequence: 22n,
      kind: "status",
      title: "run_done",
      text: "failed",
      streaming: false,
      createdAt: 2_200
    };
    const stableTail = findDurableErrorTail([error, failedDone]);
    expect(stableTail).toBe(error);

    const unread = attention("error", true, 20n, 22n, 0n);
    expect(explicitErrorAttentionCursor(unread, stableTail!)).toEqual(unread.attentionCursor);
    expect(resolveErrorTail("session-a", [error, failedDone], [], false, "none", {
      ...unread,
      unread: false,
      readThroughCursor: cursor(22n)
    })).toMatchObject({ bannerVisible: false, hideFromTimeline: false });
  });

  it("moves an idle unhandled tail exclusively above the composer", () => {
    const error = item("error-1", 2n, "error", 200);
    expect(resolveErrorTail("session-a", [error], [], false, "none")).toEqual({
      item: error,
      localKey: errorTailLocalKey("session-a", "error-1"),
      bannerVisible: true,
      hideFromTimeline: true,
      queueContinuation: false
    });
    expect(resolveErrorTail("session-a", [error], [], true, "none")).toMatchObject({ bannerVisible: false, hideFromTimeline: true });
  });

  it("suppresses duplicate activation while a queue continuation is pending", () => {
    const error = item("error-1", 2n, "error", 200);
    expect(hasErrorTailQueueContinuation([queueItem("queued", 201)], "session-a")).toBe(true);
    expect(hasErrorTailQueueContinuation([queueItem("failed", 201)], "session-a")).toBe(false);
    // A follow-up may have been queued before the failing run settled; it still owns continuation.
    expect(hasErrorTailQueueContinuation([queueItem("queued", 199)], "session-a")).toBe(true);
    expect(resolveErrorTail("session-a", [error], [queueItem("dispatchUnknown", 205)], false, "none")).toMatchObject({
      bannerVisible: false,
      hideFromTimeline: true,
      queueContinuation: true
    });
  });

  it("keeps dismissals stable across remount projections without claiming remote persistence", () => {
    const store = new ErrorTailLocalProjectionStore();
    const error = item("error-1", 2n, "error");
    const key = errorTailLocalKey("session-a", error.id);
    store.dismiss(key);
    expect(resolveErrorTail("session-a", [error], [], false, store.read(key))).toMatchObject({ bannerVisible: false, hideFromTimeline: false });
    expect(store.read(key)).toBe("dismissed");
  });

  it("uses the error subject for explicit CAS and durable read-through for reload dismissal", () => {
    const oldError = item("error-old", 40n, "error");
    const exact = attention("error", true, 40n, 44n, 0n);
    expect(explicitErrorAttentionCursor(exact, oldError)).toEqual(exact.attentionCursor);
    expect(explicitErrorAttentionCursor({ ...exact, subjectCursor: cursor(41n) }, oldError)).toBeUndefined();

    const dismissed = attention("error", false, 40n, 44n, 44n);
    expect(resolveErrorTail("session-a", [oldError], [], false, "none", dismissed)).toMatchObject({
      bannerVisible: false,
      hideFromTimeline: false
    });

    // An explicit error receipt may immediately transition to awaiting while
    // an interaction remains open; its read-through still owns the old tail.
    const awaiting = attention("awaiting", true, 45n, 46n, 44n);
    expect(resolveErrorTail("session-a", [oldError], [], false, "none", awaiting)?.bannerVisible).toBe(false);

    // A newer durable error can arrive before its attention event. The older
    // receipt must not transiently hide that new tail.
    const newError = item("error-new", 50n, "error");
    expect(resolveErrorTail("session-a", [newError], [], false, "none", dismissed)?.bannerVisible).toBe(true);
  });

  it("optimistically single-flights, restores on failure, and shows a new error id", () => {
    const store = new ErrorTailLocalProjectionStore();
    const oldKey = errorTailLocalKey("session-a", "error-1");
    expect(store.begin(oldKey)).toBe(true);
    expect(store.begin(oldKey)).toBe(false);
    expect(store.read(oldKey)).toBe("inFlight");
    store.fail(oldKey);
    expect(store.read(oldKey)).toBe("none");
    expect(store.begin(oldKey)).toBe(true);
    store.succeed(oldKey);
    expect(store.read(oldKey)).toBe("handled");
    expect(store.read(errorTailLocalKey("session-a", "error-2"))).toBe("none");
  });

  it("bounds client-only projection memory", () => {
    const store = new ErrorTailLocalProjectionStore(2);
    store.dismiss("one");
    store.dismiss("two");
    store.dismiss("three");
    expect(store.size).toBe(2);
    expect(store.read("one")).toBe("none");
    expect(store.read("three")).toBe("dismissed");
  });
});

function item(id: string, sequence: bigint, kind: TimelineItemView["kind"], createdAt = Number(sequence) * 100): TimelineItemView {
  return {
    id,
    sequence,
    kind,
    createdAt,
    ...(kind === "error" ? { error: { runId: "run-1", code: "FAILED", message: "Turn failed", phase: "stream", severity: "retryable" as const, retryable: true, recovery: [] } } : {})
  };
}

function queueItem(state: QueueItemView["state"], createdAt: number): QueueItemView {
  return { id: `${state}:${createdAt}`, sessionId: "session-a", revision: 1n, generation: 1n, source: "user", mode: "followUp", text: "continue", state, editLocked: false, ordinal: 1, createdAt };
}

function cursor(sequence: bigint) {
  return { opaqueToken: `cursor-${sequence}`, sequence, generation: 0n };
}

function attention(
  kind: SessionAttentionView["kind"],
  unread: boolean,
  subject: bigint,
  fence: bigint,
  readThrough: bigint
): SessionAttentionView {
  return {
    kind,
    unread,
    subjectCursor: cursor(subject),
    attentionCursor: cursor(fence),
    readThroughCursor: cursor(readThrough),
    updatedAt: Number(fence)
  };
}
