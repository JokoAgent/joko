import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "./events.js";
import { ProjectionGapError, emptyProjection, reduceEvent } from "./projection.js";

function event(sequence: bigint, payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    id: `event-${sequence}`,
    sequence,
    revision: sequence,
    emittedAt: Date.now(),
    backendId: "test",
    targetId: "target",
    sessionId: "session",
    generation: 1,
    traceId: "trace",
    payload
  };
}

describe("session projection", () => {
  it("assembles streaming blocks and replaces them with authoritative messages", () => {
    let state = emptyProjection();
    state = reduceEvent(state, event(1n, { type: "text_delta", blockId: "b", delta: "Hel" }));
    state = reduceEvent(state, event(2n, { type: "text_delta", blockId: "b", delta: "lo" }));
    expect(state.streamingBlocks.get("b")?.text).toBe("Hello");
    state = reduceEvent(
      state,
      event(3n, {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "Hello" }],
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 3,
          cost: 0.001
        }
      })
    );
    expect(state.streamingBlocks.size).toBe(0);
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]?.usage).toMatchObject({ totalTokens: 3, cost: 0.001 });
  });

  it("rejects event gaps so the caller can resnapshot", () => {
    const state = reduceEvent(emptyProjection(), event(4n, { type: "status", key: "x", text: "y" }));
    expect(() => reduceEvent(state, event(6n, { type: "status", key: "x" }))).toThrow(ProjectionGapError);
  });

  it("retains scheduler origin as typed durable message metadata", () => {
    const automationOrigin = { kind: "scheduler", scheduleId: "schedule-1", scheduleName: "Nightly", runId: "run-1" } as const;
    const state = reduceEvent(emptyProjection(), event(1n, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "check the build" }],
      automationOrigin
    }));

    expect(state.timeline[0]?.automationOrigin).toEqual(automationOrigin);
  });

  it("retains accepted-input delivery without inferring untyped history", () => {
    const state = reduceEvent(emptyProjection(), event(1n, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "redirect the running agent" }],
      inputDelivery: "steer"
    }));

    expect(state.timeline[0]?.inputDelivery).toBe("steer");
  });

  it("projects session attention without adding timeline chrome", () => {
    const state = reduceEvent(emptyProjection(), event(1n, {
      type: "session_attention",
      kind: "awaiting",
      unread: true,
      subjectCursor: "41",
      subjectGeneration: 3,
      attentionCursor: "41",
      attentionGeneration: 3,
      readThroughCursor: "12",
      readThroughGeneration: 2
    }));

    expect(state.timeline).toEqual([]);
    expect(state.attention).toMatchObject({
      kind: "awaiting",
      unread: true,
      subjectCursor: 41n,
      subjectGeneration: 3,
      attentionCursor: 41n,
      attentionGeneration: 3,
      readThroughCursor: 12n,
      readThroughGeneration: 2
    });
  });

  it("preserves an explicitly unknown retry terminal without inferring success", () => {
    const payload = { type: "retry", state: "unknown", attempt: 3 } as const;
    const state = reduceEvent(emptyProjection(), event(1n, payload));

    expect(state.timeline[0]?.payload).toEqual(payload);
  });
});
