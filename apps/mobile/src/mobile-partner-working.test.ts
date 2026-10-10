import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { CompactionState, EventSchema, InteractionState, MessageRole, RetryState, RunState,
  SessionState, SnapshotSchema, ToolCallState } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobilePartnerWorkingStatus } from "./mobile-partner-working";
import { profileSnapshot } from "./test/mobile-partner-profile";

function fixture() {
  const partner = profileSnapshot.partner;
  const snapshot = create(SnapshotSchema, { generation: 2n, sessions: [{ sessionId: partner.canonicalSessionId,
    targetId: partner.homeTargetId, backendId: partner.capabilities.modelChain[0]!.backendId,
    state: SessionState.RUNNING, version: { generation: 2n } }], runs: [{ runId: "run", activeAttemptId: "attempt",
    sessionId: partner.canonicalSessionId, targetId: partner.homeTargetId,
    backendId: partner.capabilities.modelChain[0]!.backendId, state: RunState.RUNNING, version: { generation: 2n } }] });
  const identity = { sessionId: partner.canonicalSessionId, targetId: partner.homeTargetId,
    backendId: partner.capabilities.modelChain[0]!.backendId, generation: 2n, runId: "run", attemptId: "attempt" };
  const observation = { ownerKey: "owner", online: true, snapshot };
  const event = (sequence: number, payload: MessageInitShape<typeof EventSchema>["payload"]) => create(EventSchema, {
    eventId: `event-${sequence}`, identity, cursor: { generation: 2n, sequence: BigInt(sequence) }, payload });
  const tool = (sequence: number, state = ToolCallState.RUNNING, withInput = sequence === 1) => event(sequence, { kind: {
    case: state === ToolCallState.SUCCEEDED || state === ToolCallState.FAILED ? "toolCallCompleted" : "toolCallStarted",
    value: { toolCall: { toolCallId: "call", toolId: "Bash", sessionId: identity.sessionId, runId: "run", attemptId: "attempt", state,
      ...(withInput ? { arguments: [{ fieldPath: "$", value: { case: "text", value: '{"command":"pnpm test","description":"Private details"}' } }] } : {}) } }
  } });
  return { partner, snapshot, observation, event, tool };
}

describe("mobile Partner current working status", () => {
  it("tracks only the exact active Run and Attempt, preserving returned subjects without success claims", () => {
    const { partner, observation, event, tool } = fixture();
    const read = (events: ReturnType<typeof event>[]) => mobilePartnerWorkingStatus(partner, observation, events);
    expect(read([])?.phase).toBe("thinking");
    const started = tool(1);
    expect(read([started])?.phase).toBe("testing");
    const incomplete = tool(1, ToolCallState.RUNNING, false);
    expect(read([incomplete])?.phase).toBe("processing");
    const updated = tool(1); updated.eventId = "arguments-complete"; updated.cursor!.sequence = 2n;
    expect(read([incomplete, updated])?.phase).toBe("testing");
    expect(read([started, tool(2, ToolCallState.FAILED)])?.phase).toBe("reviewing-checks");
    expect(read([started, tool(2, ToolCallState.SUCCEEDED), event(3, { kind: { case: "textDelta", value: {
      messageId: "reply", delta: "Private reply content" } } })])?.phase).toBe("replying");
    const stale = tool(4); stale.identity!.attemptId = "old-attempt";
    const background = tool(5); background.identity!.runId = "background-run";
    const other = tool(6); other.identity!.sessionId = "child-session";
    const oldGeneration = tool(7); oldGeneration.cursor!.generation = 1n;
    expect(read([stale, background, other, oldGeneration])?.phase).toBe("thinking");
    const status = read([started])!;
    expect(JSON.stringify(status)).not.toContain("Private");
    observation.snapshot.runs[0]!.activeAttemptId = "next-attempt";
    expect(read([started])?.turnKey).not.toBe(status.turnKey);
  });

  it("retires immediately for terminal, waiting, offline and mismatched canonical facts", () => {
    const { partner, snapshot, observation, event, tool } = fixture();
    const started = tool(1);
    for (const terminal of [event(2, { kind: { case: "runDone", value: { runId: "run" } } }),
      event(3, { kind: { case: "runAborted", value: { runId: "run" } } }),
      event(4, { kind: { case: "terminalError", value: { error: { code: "FAILED", message: "Private error" } } } })]) {
      expect(mobilePartnerWorkingStatus(partner, observation, [started, terminal])).toBeUndefined();
    }
    snapshot.sessions[0]!.state = SessionState.WAITING;
    expect(mobilePartnerWorkingStatus(partner, observation, [started])).toBeUndefined();
    snapshot.sessions[0]!.state = SessionState.RUNNING;
    snapshot.interactions = create(SnapshotSchema, { interactions: [{ sessionId: partner.canonicalSessionId,
      targetId: partner.homeTargetId, backendId: partner.capabilities.modelChain[0]!.backendId,
      generation: 2n, state: InteractionState.PENDING }] }).interactions;
    expect(mobilePartnerWorkingStatus(partner, observation, [started])).toBeUndefined();
    snapshot.interactions = [];
    expect(mobilePartnerWorkingStatus(partner, { ...observation, online: false }, [started])).toBeUndefined();
    snapshot.sessions[0]!.targetId = "other-target";
    expect(mobilePartnerWorkingStatus(partner, observation, [started])).toBeUndefined();
  });

  it("keeps typed compaction and retry reasons current, discards stale recovery and resumes after tool waiting", () => {
    const { partner, snapshot, observation, event, tool } = fixture();
    const retry = event(2, { kind: { case: "retryChanged", value: { runId: "run", attemptId: "attempt",
      state: RetryState.WAITING, error: { code: "RATE_LIMITED", message: "Private provider error" } } } });
    expect(mobilePartnerWorkingStatus(partner, observation, [tool(1), retry])?.phase).toBe("rate-limit");
    const resumed = event(3, { kind: { case: "retryChanged", value: { runId: "run", attemptId: "attempt", state: RetryState.STARTED } } });
    expect(mobilePartnerWorkingStatus(partner, observation, [tool(1), retry, resumed])?.phase).toBe("testing");
    snapshot.sessions[0]!.contextState = create(SnapshotSchema, { sessions: [{ contextState: { compacting: true } }] }).sessions[0]!.contextState;
    const oldCompaction = event(4, { kind: { case: "compactionChanged", value: { compactionId: "old", state: CompactionState.COMPLETED } } });
    expect(mobilePartnerWorkingStatus(partner, observation, [oldCompaction])?.phase).toBe("compacting");
    snapshot.sessions[0]!.contextState = undefined;
    const waiting = tool(2, ToolCallState.WAITING_PERMISSION);
    expect(mobilePartnerWorkingStatus(partner, observation, [tool(1), waiting])).toBeUndefined();
    expect(mobilePartnerWorkingStatus(partner, observation, [tool(1), waiting, tool(3, ToolCallState.SUCCEEDED)])?.phase).toBe("reviewing-checks");
    snapshot.runs[0]!.state = RunState.RETRYING; snapshot.runs[0]!.error = create(SnapshotSchema, { runs: [{
      error: { code: "OVERLOADED", message: "Private", retryable: true } }] }).runs[0]!.error;
    expect(mobilePartnerWorkingStatus(partner, observation, [])?.phase).toBe("model-busy");
  });
});
