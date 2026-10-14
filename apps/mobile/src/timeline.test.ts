import { create } from "@bufbuild/protobuf";
import { EventCursorSchema, EventIdentitySchema, EventSchema, InputContentSchema, MessageInputDelivery, MessageRole, ObjectiveLifecycleAction, ObjectiveStatus, QueueItemState, RunSchema, RunState, RunUsageSummarySchema, ToolCallOutputMode, ToolCallState, ToolFileAction, ToolResultSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";
import { isWorkGroup, mobileWorkItems } from "./mobile-work-projection";
import { producedArtifactEvent, producedImageEvent, toolMediaEvent } from "./test/timeline-media";
import { mobilePartnerConversationRows, mobilePublicConversationInputs } from "./mobile-partner-presentation";
import { mobileMessageShareable, projectMobileConversationShareMessage } from "./mobile-conversation-share";

function completed(blocks: any[], role = MessageRole.ASSISTANT) {
  return create(EventSchema, {
    eventId: "complete",
    identity: { sessionId: "session" },
    cursor: { generation: 1n, sequence: 1n },
    payload: { kind: { case: "messageCompleted", value: {
      messageId: "message",
      role,
      blocks
    } } }
  });
}

it("shows typed objective completion while keeping the internal verdict out of visible and quoted assistant text", () => {
  const completion = completed([{ content: { case: "text", value: 'Done.\n```json\n{"goal_status":"complete"}\n```' } }]);
  const lifecycle = create(EventSchema, { eventId: "objective-complete", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 2n },
    payload: { kind: { case: "objectiveLifecycle", value: { action: ObjectiveLifecycleAction.COMPLETED, status: ObjectiveStatus.COMPLETE,
      ownerGeneration: 2n, turnsUsed: 4, tokensUsed: 123_000n } } } });
  const rows = timelineRows([completion, lifecycle]);
  expect(rows[0]).toMatchObject({ text: "Done.", quoteSource: { text: "Done." } });
  expect(rows[1]).toMatchObject({ objectiveLifecycle: { status: "complete", turns: 4, tokens: 123_000 } });
  expect(completion.payload?.kind.case === "messageCompleted" && completion.payload.kind.value.blocks[0]?.content.value).toContain("goal_status");
  const payload = lifecycle.payload!.kind;
  if (payload.case === "objectiveLifecycle") payload.value.status = ObjectiveStatus.ACTIVE;
  expect(timelineRows([lifecycle])).toEqual([]);
});

describe("mobile Timeline metadata events", () => {
  it("replays public scheduler input and its exact source without exposing objective or recovery prompts", () => {
    const text = "Read the report\n".repeat(18);
    const start = create(EventSchema, { eventId: "scheduled-input", identity: { sessionId: "session" }, cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "messageStarted", value: { messageId: "message", role: MessageRole.USER,
        userInputAccepted: true, inputDelivery: MessageInputDelivery.SCHEDULER,
        automationOrigin: { scheduleId: "schedule", scheduleName: "Daily report", runId: "run" },
        userInput: { parts: [{ content: { case: "text", value: text } }] } } } } });
    const end = completed([{ content: { case: "text", value: "native echo" } }], MessageRole.USER);
    end.cursor!.sequence = 2n;
    const replay = timelineRows([end, start]);
    expect(mobilePublicConversationInputs(replay)).toMatchObject([{ text, sourceText: text, internalInput: false,
      automationOrigin: { scheduleId: "schedule", scheduleName: "Daily report", runId: "run" } }]);
    expect(mobilePartnerConversationRows(replay, false, "partner")).toEqual(replay);
    expect(projectMobileConversationShareMessage(replay[0]!, end, [], start)).toMatchObject({ body: text,
      bodyParts: [{ kind: "text", text }] });
    if (start.payload?.kind.case !== "messageStarted") throw new Error("Expected accepted input");
    start.payload.kind.value.automaticContinuation = true;
    expect(mobilePublicConversationInputs(timelineRows([start, end]))).toEqual([]);
    expect(mobileMessageShareable(timelineRows([start, end])[0]!)).toBe(false);
    start.payload.kind.value.automaticContinuation = false;
    start.payload.kind.value.objectiveContinuation = { $typeName: "joko.v1.ObjectiveContinuation", ownerGeneration: 1n, turn: 1 };
    expect(mobilePublicConversationInputs(timelineRows([start, end]))).toEqual([]);
    expect(timelineRows([start, end])[0]?.sourceText).toBeUndefined();
  });

  it("keeps pasted input source available for copying and sharing while rejecting unaccepted source labels", () => {
    const text = "First line\nSecond line";
    const start = create(EventSchema, { eventId: "input", cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "messageStarted", value: { messageId: "message", role: MessageRole.USER, userInputAccepted: true,
        automationOrigin: { scheduleId: "schedule", scheduleName: "Daily" },
        userInput: { parts: [{ content: { case: "text", value: text } }], pastedTextRanges: [{ start: 0, end: text.length, display: "Pasted text (2 lines)" }] } } } } });
    const row = timelineRows([start])[0]!;
    expect(row.text).toBe("Pasted text (2 lines)");
    expect(row.sourceText).toBe(text);
    expect(projectMobileConversationShareMessage(row, start)).toMatchObject({ body: text });
    if (start.payload?.kind.case !== "messageStarted") throw new Error("Expected input");
    start.payload.kind.value.userInputAccepted = false;
    expect(timelineRows([start])[0]?.automationOrigin).toBeUndefined();
    expect(timelineRows([start])[0]?.sourceText).toBeUndefined();
    start.payload.kind.value.userInputAccepted = true;
    start.payload.kind.value.automationOrigin!.scheduleId = "";
    expect(timelineRows([start])[0]?.automationOrigin).toBeUndefined();
  });
  it("retains typed task senders without changing literal user text or inferring provenance from JSON", () => {
    const taskMessageOrigin = { senderSessionId: "source", senderSessionTitle: "Source title", senderPartnerId: "partner", senderPartnerName: "Partner name" };
    const event = create(EventSchema, { eventId: "handoff", identity: { sessionId: "recipient" }, cursor: { generation: 1n, sequence: 5n },
      payload: { kind: { case: "messageStarted", value: { messageId: "input", role: MessageRole.USER, userInputAccepted: true, taskMessageOrigin,
        userInput: { parts: [{ content: { case: "text", value: JSON.stringify(taskMessageOrigin) } }] } } } } });
    expect(timelineRows([event])).toMatchObject([{ text: JSON.stringify(taskMessageOrigin), sequence: 5n, eventId: "handoff", taskMessageOrigin }]);
    if (event.payload?.kind.case === "messageStarted") {
      event.payload.kind.value.userInputAccepted = false; expect(timelineRows([event])[0]?.taskMessageOrigin).toBeUndefined();
      event.payload.kind.value.userInputAccepted = true; event.payload.kind.value.taskMessageOrigin = undefined;
      expect(timelineRows([event])[0]?.taskMessageOrigin).toBeUndefined();
    }
  });
  it("keeps progressive collaboration dispatches visible with their original cursor and failure state", () => {
    const event = (sequence: bigint, done = false) => create(EventSchema, { eventId: `dispatch-${sequence}`, identity: { sessionId: "lead", runId: "run", generation: 1n },
      cursor: { generation: 1n, sequence }, payload: { kind: { case: done ? "toolCallCompleted" : "toolCallStarted", value: { toolCall: {
        toolCallId: "dispatch", toolId: "mcp__joko_collaboration__call_tool", sessionId: "lead", runId: "run", state: done ? ToolCallState.FAILED : ToolCallState.RUNNING,
        arguments: done ? [] : [{ fieldPath: "$", value: { case: "text", value: JSON.stringify({ name: "create_workers", args: { workers: [
          { label: "Developer", assignment: "Implement the feature" }, { label: "Reviewer", assignment: "Verify the evidence" }
        ] } }) } }], result: done ? { parts: [{ content: { case: "text", value: "Worker capacity reached" } }] } : undefined
      } } } } });
    const rows = timelineRows([event(1n), event(3n, true)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 1n, eventId: "dispatch-3", persistentTask: true,
      collaboration: { variant: "dispatch", action: "batch", count: 2, state: "failed", body: "Developer: Implement the feature\nReviewer: Verify the evidence", error: "Worker capacity reached" } });
    expect(isWorkGroup(mobileWorkItems(rows, false)[0]!)).toBe(false);
    const redacted = event(1n); if (redacted.payload?.kind.case === "toolCallStarted") redacted.payload.kind.value.toolCall!.arguments[0]!.redacted = true;
    expect(timelineRows([redacted])[0]?.collaboration).toBeUndefined();
    const unrelated = event(1n); if (unrelated.payload?.kind.case === "toolCallStarted") unrelated.payload.kind.value.toolCall!.toolId = "mcp__other__call_tool";
    expect(timelineRows([unrelated])[0]?.collaboration).toBeUndefined();
    for (const name of ["mcp__joko_032ff7b36750c3f6aec4706f__call_tool", "joko_joko_collaboration_0123456789ab/call_tool"]) {
      const routed = event(1n); if (routed.payload?.kind.case === "toolCallStarted") routed.payload.kind.value.toolCall!.toolId = name;
      expect(timelineRows([routed])[0]?.collaboration).toMatchObject({ action: "batch", count: 2 });
    }
  });
  it("presents only typed accepted worker reports and leaves user JSON and foreign provenance as ordinary input", () => {
    const origin = { goalId: "goal", workerId: "worker", leadSessionId: "lead", workerSessionId: "worker-task", workerLabel: "Reviewer", body: "Done\nEvidence" };
    const event = create(EventSchema, { eventId: "report", identity: { sessionId: "lead" }, cursor: { generation: 1n, sequence: 4n },
      payload: { kind: { case: "messageStarted", value: { messageId: "report-message", role: MessageRole.USER, userInputAccepted: true,
        userInput: { parts: [{ content: { case: "text", value: "[From Reviewer]\nDone\nEvidence" } }] }, collaborationReportOrigin: origin } } } });
    expect(timelineRows([event])).toMatchObject([{ text: origin.body, kind: "user", sequence: 4n, eventId: "report", collaboration: { variant: "report", origin } }]);
    if (event.payload?.kind.case === "messageStarted") {
      event.payload.kind.value.userInputAccepted = false; expect(timelineRows([event])[0]?.collaboration).toBeUndefined();
      event.payload.kind.value.userInputAccepted = true; event.payload.kind.value.collaborationReportOrigin!.leadSessionId = "other";
      expect(timelineRows([event])[0]?.collaboration).toBeUndefined();
      event.payload.kind.value.collaborationReportOrigin = undefined;
      event.payload.kind.value.userInput = create(InputContentSchema, { parts: [{ content: { case: "text", value: JSON.stringify(origin) } }] });
      expect(timelineRows([event])[0]?.collaboration).toBeUndefined();
    }
  });
  function metadataEvents() {
    return [
      create(EventSchema, { eventId: "session-metadata", identity: { sessionId: "session-one" },
        cursor: { generation: 1n, sequence: 1n },
        payload: { kind: { case: "sessionChanged", value: { session: { sessionId: "session-one", displayName: "Updated task" } } } } }),
      create(EventSchema, { eventId: "command-catalog", identity: { sessionId: "session-one" },
        cursor: { generation: 1n, sequence: 10n },
        payload: { kind: { case: "runtimeCommandsChanged", value: { commands: [{
          commandId: "command-one", name: "Inspect", sessionId: "session-one", loaded: true
        }] } } } }),
      create(EventSchema, { eventId: "run-projection", identity: { sessionId: "session-one", runId: "run-one" },
        cursor: { generation: 1n, sequence: 11n },
        payload: { kind: { case: "runChanged", value: { run: {
          runId: "run-one", sessionId: "session-one", state: RunState.RUNNING,
          version: { revision: { value: 2n } }
        } } } } }),
      create(EventSchema, { eventId: "queue-projection", identity: { sessionId: "session-one", runId: "run-one" },
        cursor: { generation: 1n, sequence: 13n },
        payload: { kind: { case: "queueItemChanged", value: { queueItem: {
          queueItemId: "queue-one", sessionId: "session-one", runId: "run-one", state: QueueItemState.COMPLETED,
          ordinal: 1n, input: { parts: [{ content: { case: "text", value: "Hello" } }] },
          version: { revision: { value: 3n } }
        } } } } })
    ];
  }

  it("leaves a control-only window empty while preserving its metadata and real cursors", () => {
    const events = metadataEvents(); const original = structuredClone(events);
    expect(timelineRows(events)).toEqual([]);
    expect(events).toEqual(original);
    expect(events.at(-1)?.cursor?.sequence).toBe(13n);
  });

  it("merges visible history and live content across metadata updates without using visible rows as the window edge", () => {
    const metadata = metadataEvents();
    const history = [metadata[0]!,
      create(EventSchema, { eventId: "accepted-user", identity: { sessionId: "session-one", operationId: "send-one" },
        cursor: { generation: 1n, sequence: 2n }, payload: { kind: { case: "messageStarted", value: {
          messageId: "user-one", role: MessageRole.USER, userInputAccepted: true,
          userInput: { parts: [{ content: { case: "text", value: "Hello" } }] }
        } } } }),
      create(EventSchema, { eventId: "assistant-start", identity: { sessionId: "session-one" },
        cursor: { generation: 1n, sequence: 3n }, payload: { kind: { case: "messageStarted", value: {
          messageId: "message", role: MessageRole.ASSISTANT
        } } } })];
    expect(timelineRows(history)).toMatchObject([
      { id: "user-one", kind: "user", text: "Hello", sequence: 2n, operationId: "send-one", completed: true },
      { id: "message", kind: "assistant", text: "…", sequence: 3n, completed: false }
    ]);
    const live = [
      create(EventSchema, { eventId: "assistant-delta", identity: { sessionId: "session-one" },
        cursor: { generation: 1n, sequence: 4n }, payload: { kind: { case: "textDelta", value: { messageId: "message", delta: "Working" } } } }),
      create(EventSchema, { ...toolCompleted(), cursor: create(EventCursorSchema, { generation: 1n, sequence: 5n }) }),
      create(EventSchema, { eventId: "recoverable-error", cursor: { generation: 1n, sequence: 6n },
        payload: { kind: { case: "recoverableError", value: { error: { message: "Try again" } } } } }),
      create(EventSchema, { eventId: "task-status", cursor: { generation: 1n, sequence: 7n },
        payload: { kind: { case: "statusStream", value: { label: "Running", detail: "Checking" } } } }),
      create(EventSchema, { eventId: "run-finished", cursor: { generation: 1n, sequence: 8n },
        payload: { kind: { case: "runDone", value: { runId: "run-one" } } } }),
      create(EventSchema, { ...completed([{ content: { case: "text", value: "Finished." } }]),
        identity: create(EventIdentitySchema, { sessionId: "session-one" }),
        cursor: create(EventCursorSchema, { generation: 1n, sequence: 9n }) }), metadata[1]!, metadata[2]!,
      create(EventSchema, { eventId: "terminal-error", cursor: { generation: 1n, sequence: 12n },
        payload: { kind: { case: "terminalError", value: { error: { message: "The task stopped." } } } } }), metadata[3]!
    ];
    expect(timelineRows([...history, live[0]!])[1]).toMatchObject({ text: "Working", sequence: 3n, completed: false });
    const events = [...history, ...live]; const original = structuredClone(events);
    expect(timelineRows(events)).toMatchObject([
      { id: "user-one", kind: "user", text: "Hello", sequence: 2n, operationId: "send-one" },
      { id: "message", kind: "assistant", text: "Finished.", sequence: 3n, eventId: "complete", completed: true },
      { kind: "tool", eventId: "tool-completed", sequence: 5n, completed: true },
      { kind: "error", eventId: "recoverable-error", text: "Try again", sequence: 6n },
      { kind: "status", eventId: "task-status", text: "Running · Checking", sequence: 7n },
      { kind: "activity", eventId: "run-finished", text: "Run finished", sequence: 8n },
      { kind: "error", eventId: "terminal-error", text: "The task stopped.", sequence: 12n }
    ]);
    expect(events).toEqual(original);
    expect(events.at(-1)?.cursor?.sequence).toBe(13n);
    expect(timelineRows(events).at(-1)?.sequence).toBe(12n);
  });
});

describe("mobile Timeline turn usage", () => {
  const answer = () => create(EventSchema, { eventId: "answer-completed", cursor: { generation: 3n, sequence: 5n },
    identity: { sessionId: "task", runId: "run", attemptId: "attempt", generation: 2n },
    payload: { kind: { case: "messageCompleted", value: { messageId: "answer", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "text", value: "Done" } }], usage: { totalTokens: 10n } } } } });
  const summary = () => create(RunUsageSummarySchema, { usage: { totalTokens: 30n, costMicros: 120_000n, currencyCode: "USD" },
    estimated: true, costComplete: true, tokensComplete: true, completionEventId: "answer-completed", messageId: "answer" });
  const run = () => create(RunSchema, { runId: "run", sessionId: "task", state: RunState.SUCCEEDED,
    version: { revision: { value: 2n } }, usage: summary() });
  const changed = () => create(EventSchema, { eventId: "run-projection", cursor: { generation: 3n, sequence: 6n },
    identity: { sessionId: "task", runId: "run", generation: 2n }, payload: { kind: { case: "runChanged", value: { run: run() } } } });

  it("uses the durable total only on the exact final completion and restores a history window from the Snapshot Run", () => {
    const completion = answer();
    const intermediate = answer(); intermediate.eventId = "segment-completed";
    if (intermediate.payload?.kind.case === "messageCompleted") intermediate.payload.kind.value.messageId = "segment";
    intermediate.cursor!.sequence = 4n;
    expect(timelineRows([intermediate, completion]).map(row => row.usage)).toEqual([undefined, undefined]);
    const events = [intermediate, completion, changed()]; const original = structuredClone(events);
    const live = timelineRows([...events, events[2]!]);
    expect(live).toMatchObject([{ id: "segment" }, { id: "answer", usage: { totalTokens: 30n }, usageIsEstimate: true, usageCostComplete: true, usageTokensComplete: true }]);
    expect(live[0]?.usage).toBeUndefined();
    expect(timelineRows([completion], false, [run()])).toEqual([live[1]]);
    expect(timelineRows([...events].reverse())).toEqual(live);
    expect(events).toEqual(original);
    if (completion.payload?.kind.case === "messageCompleted") completion.payload.kind.value.turnUsage = summary();
    expect(timelineRows([completion])).toEqual([live[1]]);
  });

  it("adopts later priced totals without adding repeated observations or letting a stale Snapshot replace them", () => {
    const updated = changed(); updated.eventId = "priced-projection"; updated.cursor!.sequence = 8n;
    if (updated.payload?.kind.case !== "runChanged") throw new Error("Expected Run projection");
    updated.payload.kind.value.run!.version!.revision!.value = 3n;
    updated.payload.kind.value.run!.usage!.usage!.totalTokens = 45n;
    updated.payload.kind.value.run!.usage!.usage!.costMicros = 240_000n;
    updated.payload.kind.value.run!.usage!.estimated = false;
    expect(timelineRows([updated, changed(), answer(), changed(), updated], false, [run()]))
      .toMatchObject([{ usage: { totalTokens: 45n, costMicros: 240_000n }, usageIsEstimate: false, usageCostComplete: true }]);
  });

  it("retires a previously joined segment when the Run completion moves, including a final outside the visible history page", () => {
    const segment = answer(); segment.eventId = "segment-completed"; segment.cursor!.sequence = 3n;
    if (segment.payload?.kind.case !== "messageCompleted") throw new Error("Expected completion");
    segment.payload.kind.value.messageId = "segment";
    segment.payload.kind.value.turnUsage = summary();
    segment.payload.kind.value.turnUsage.messageId = "segment";
    segment.payload.kind.value.turnUsage.completionEventId = "segment-completed";
    expect(timelineRows([segment])[0]?.usage?.totalTokens).toBe(30n);
    const latest = changed();
    expect(timelineRows([segment, answer(), latest])[0]?.usage).toBeUndefined();
    expect(timelineRows([segment, latest])).toMatchObject([{ id: "segment", usage: undefined }]);
    expect(timelineRows([segment], false, [run()])).toMatchObject([{ id: "segment", usage: undefined }]);
    const checkpoint = run(); checkpoint.usage!.usage!.totalTokens = 200n;
    const historyProjection = changed();
    if (historyProjection.payload?.kind.case !== "runChanged") throw new Error("Expected Run projection");
    historyProjection.payload.kind.value.run!.usage = structuredClone(segment.payload.kind.value.turnUsage);
    historyProjection.payload.kind.value.run!.usage!.usage!.totalTokens = 120n;
    expect(timelineRows([segment, historyProjection], false, [checkpoint]))
      .toMatchObject([{ id: "segment", usage: undefined }]);
    for (const field of ["generation", "nativeGeneration", "sessionId", "runId"] as const) {
      const foreign = changed();
      if (field === "generation") foreign.cursor!.generation = 1n;
      else if (field === "nativeGeneration") foreign.identity!.generation = 1n;
      else foreign.identity![field] = "foreign";
      expect(timelineRows([segment, foreign])[0]?.usage?.totalTokens).toBe(30n);
    }
  });

  it("rejects foreign Run and completion identities and retired event generations instead of guessing message ownership", () => {
    const completion = answer();
    for (const field of ["sessionId", "runId"] as const) {
      const foreign = run(); foreign[field] = "foreign";
      expect(timelineRows([completion], false, [foreign])[0]?.usage).toBeUndefined();
    }
    for (const field of ["completionEventId", "messageId"] as const) {
      const foreign = run(); foreign.usage![field] = "foreign";
      expect(timelineRows([completion], false, [foreign])[0]?.usage).toBeUndefined();
      if (completion.payload?.kind.case !== "messageCompleted") throw new Error("Expected completion");
      completion.payload.kind.value.turnUsage = foreign.usage;
      expect(timelineRows([completion])[0]?.usage).toBeUndefined();
    }
    if (completion.payload?.kind.case === "messageCompleted") completion.payload.kind.value.turnUsage = undefined;
    for (const field of ["generation", "nativeGeneration", "runId", "sessionId"] as const) {
      const retired = changed();
      if (field === "generation") retired.cursor!.generation = 1n;
      else if (field === "nativeGeneration") retired.identity!.generation = 1n;
      else retired.identity![field] = "foreign";
      expect(timelineRows([completion, retired])[0]?.usage).toBeUndefined();
      expect(timelineRows([completion, retired], false, [run()])[0]?.usage?.totalTokens).toBe(30n);
    }
    const child = run(); child.runId = "child-run"; child.sessionId = "child-task";
    expect(timelineRows([completion], false, [child, run()])[0]?.usage?.totalTokens).toBe(30n);
  });

  it("keeps missing and mixed prices token-only and rejects malformed current-v1 totals", () => {
    const completion = answer(); const unknown = run();
    unknown.usage!.usage!.currencyCode = ""; unknown.usage!.usage!.costMicros = 0n; unknown.usage!.costComplete = false;
    unknown.usage!.tokensComplete = false;
    expect(timelineRows([completion], false, [unknown])[0]).toMatchObject({ usage: { totalTokens: 30n, currencyCode: "", costMicros: 0n },
      usageIsEstimate: true, usageCostComplete: false, usageTokensComplete: false });
    for (const mutate of [
      (value: ReturnType<typeof run>) => { value.usage!.usage!.inputTokens = -1n; },
      (value: ReturnType<typeof run>) => { value.usage!.usage!.totalTokens = 2n ** 64n; },
      (value: ReturnType<typeof run>) => { value.usage!.usage!.costMicros = -1n; },
      (value: ReturnType<typeof run>) => { value.usage!.usage!.currencyCode = "usd"; },
      (value: ReturnType<typeof run>) => { value.usage!.usage!.currencyCode = ""; },
      (value: ReturnType<typeof run>) => { value.usage!.messageId = ""; }
    ]) {
      const malformed = run(); mutate(malformed);
      expect(timelineRows([completion], false, [malformed])[0]?.usage).toBeUndefined();
    }
  });
});

describe("mobile Timeline quote source", () => {
  it("exposes exact completed assistant pure text and nothing else as quote authority", () => {
    expect(timelineRows([completed([
      { content: { case: "text", value: "first" } },
      { content: { case: "text", value: "second" } }
    ])])[0]?.quoteSource).toEqual({
      sourceMessageId: "message",
      sourceEventId: "complete",
      text: "first\nsecond"
    });
    expect(timelineRows([completed([
      { content: { case: "text", value: "first" } },
      { content: { case: "artifact", value: {} } }
    ])])[0]?.quoteSource).toBeUndefined();
    expect(timelineRows([completed([{ content: { case: "text", value: "user" } }], MessageRole.USER)])[0]?.quoteSource)
      .toBeUndefined();
    expect(timelineRows([completed([{ content: { case: "text", value: "   " } }])])[0]?.quoteSource)
      .toBeUndefined();
  });

  it("keeps exact supported non-image artifact occurrences beside completed messages", () => {
    const row = timelineRows([completed([
      { content: { case: "artifact", value: { label: "Recording", blob: {
        blobId: "recording", fileName: "recording.mp3", mediaType: "audio/mpeg",
        byteSize: 256n, sha256Hex: "a".repeat(64)
      } } } },
      { content: { case: "artifact", value: { label: "Model", blob: {
        blobId: "model", fileName: "model.glb", mediaType: "model/gltf-binary",
        byteSize: 256n, sha256Hex: "b".repeat(64)
      } } } }
    ])])[0];
    expect(row?.artifacts).toMatchObject([
      { eventId: "complete", source: { kind: "timeline", messageId: "message", contentIndex: 0 }, title: "Recording", previewKind: "media" },
      { eventId: "complete", source: { kind: "timeline", messageId: "message", contentIndex: 1 }, title: "Model", previewKind: "model" }
    ]);
  });

  it("keeps arbitrary and over-preview-limit files shareable without duplicating gallery images", () => {
    const row = timelineRows([completed([
      { content: { case: "artifact", value: { label: "Archive", blob: {
        blobId: "archive", fileName: "archive.zip", mediaType: "application/zip",
        byteSize: 256n, sha256Hex: "a".repeat(64)
      } } } },
      { content: { case: "artifact", value: { label: "Large image", blob: {
        blobId: "large-image", fileName: "large.png", mediaType: "image/png",
        byteSize: 33_554_433n, sha256Hex: "b".repeat(64)
      } } } },
      { content: { case: "artifact", value: { label: "Small image", blob: {
        blobId: "small-image", fileName: "small.png", mediaType: "image/png",
        byteSize: 256n, sha256Hex: "c".repeat(64)
      } } } }
    ])])[0];

    expect(row?.images).toMatchObject([{ title: "Small image", mediaType: "image/png" }]);
    expect(row?.artifacts).toMatchObject([
      { source: { kind: "timeline", contentIndex: 0 }, title: "Archive" },
      { source: { kind: "timeline", contentIndex: 1 }, title: "Large image" }
    ]);
    expect(row?.artifacts?.every((artifact) => artifact.previewKind === undefined)).toBe(true);
  });
});

describe("ordered Thinking inside canonical Mobile messages", () => {
  const scoped = (sequence: number, kind: string, value: unknown) => create(EventSchema, {
    eventId: `thinking-event-${sequence}`, identity: { sessionId: "session", runId: "run", attemptId: "attempt", generation: 7n },
    cursor: { generation: 3n, sequence: BigInt(sequence) }, occurredAt: { seconds: BigInt(sequence) },
    payload: { kind: { case: kind, value } as any }
  });

  it("keeps stream/final ordered content in one original message with canonical media and fail-closed quote authority", () => {
    const history = [scoped(1, "messageStarted", { messageId: "answer", role: MessageRole.ASSISTANT }),
      scoped(2, "thinkingDelta", { messageId: "answer", contentIndex: 0, delta: "draft" }),
      scoped(3, "textDelta", { messageId: "answer", contentIndex: 1, delta: "draft answer" }),
      scoped(4, "thinkingDelta", { messageId: "answer", contentIndex: 3, delta: "second draft" })];
    const streaming = timelineRows(history, true);
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ id: "answer", text: "draft answer", completed: false, workActivity: false });
    expect(streaming[0]?.messageParts?.map((part) => [part.contentIndex, part.kind])).toEqual([[0, "thinking"], [1, "text"], [3, "thinking"]]);
    const firstKey = streaming[0]?.messageParts?.[0]?.kind === "thinking" ? streaming[0].messageParts[0].thinking.key : undefined;
    const final = scoped(5, "messageCompleted", { messageId: "answer", role: MessageRole.ASSISTANT, blocks: [
      { content: { case: "thinking", value: { text: "final first" } } },
      { content: { case: "text", value: "Answer" } },
      { content: { case: "image", value: { altText: "Image", blob: { blobId: "picture", fileName: "picture.png", mediaType: "image/png", byteSize: 128n, sha256Hex: "a".repeat(64) } } } },
      { content: { case: "thinking", value: { text: "secret", redacted: true } } },
      { content: { case: "artifact", value: { label: "Report", blob: { blobId: "report", fileName: "report.pdf", mediaType: "application/pdf", byteSize: 128n, sha256Hex: "b".repeat(64) } } } },
      { content: { case: "text", value: "Tail" } }
    ] });
    const events = [...history, final, scoped(6, "thinkingDelta", { messageId: "answer", contentIndex: 0, delta: "late" }),
      scoped(7, "textDelta", { messageId: "answer", contentIndex: 1, delta: "late answer" })];
    const original = structuredClone(events);
    const rows = timelineRows(events, true);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ id: "answer", eventId: "thinking-event-5", sequence: 1n, completed: true });
    expect(row.messageParts?.map((part) => part.kind)).toEqual(["thinking", "text", "image", "thinking", "artifact", "text"]);
    expect(row.messageParts?.[0]).toMatchObject({ thinking: { key: firstKey, text: "final first", completed: true, streaming: false } });
    expect(row.messageParts?.[2]).toMatchObject({ image: { pageId: row.images?.[0]?.pageId, sourceEventId: "thinking-event-5" } });
    expect(row.messageParts?.[3]).toMatchObject({ thinking: { redacted: true, text: "" } });
    expect(row.messageParts?.[4]).toMatchObject({ artifact: { artifactId: row.artifacts?.[0]?.artifactId, source: { contentIndex: 4 } } });
    expect(row.text).not.toContain("late");
    expect(row.quoteSource).toBeUndefined();
    expect(events).toEqual(original);
  });

  it("restores redacted/thinking-only history as work without empty placeholders or fabricated streaming", () => {
    const restored = timelineRows([scoped(1, "messageCompleted", { messageId: "history", role: MessageRole.ASSISTANT, blocks: [
      { content: { case: "thinking", value: { text: "" } } },
      { content: { case: "thinking", value: { text: "hidden", redacted: true } } },
      { content: { case: "thinking", value: { text: "Historical body" } } }
    ] })]);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: "history", workActivity: true, workStreaming: false });
    expect(restored[0]?.messageParts?.map((part) => part.contentIndex)).toEqual([1, 2]);
    expect(restored[0]?.messageParts?.every((part) => part.kind !== "thinking" || part.thinking.completed && !part.thinking.streaming)).toBe(true);
    const empty = scoped(2, "messageCompleted", { messageId: "empty", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "thinking", value: { text: " " } } }] });
    expect(timelineRows([empty])).toEqual([]);
    expect(empty.cursor?.sequence).toBe(2n);
    const middle = timelineRows([scoped(3, "thinkingDelta", { messageId: "inside", contentIndex: 0, delta: "Already started" })], false);
    expect(middle).toMatchObject([{ id: "inside", messageParts: [{ thinking: { text: "Already started", streaming: false } }] }]);
  });

  it("places work before its completed answer without changing the canonical message start cursor or tool detail", () => {
    const started = scoped(1, "messageStarted", { messageId: "answer", role: MessageRole.ASSISTANT });
    const tool = scoped(2, "toolCallCompleted", { toolCall: { toolCallId: "call", toolId: "read_file", sessionId: "session",
      runId: "run", attemptId: "attempt", state: ToolCallState.SUCCEEDED,
      result: { parts: [{ content: { case: "text", value: "File body" } }] } } });
    const final = scoped(3, "messageCompleted", { messageId: "answer", role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "text", value: "Final answer" } }] });
    const rows = timelineRows([started, tool, final]);
    expect(rows[0]).toMatchObject({ id: "answer", sequence: 1n, answerSequence: 3n, text: "Final answer" });
    const display = mobileWorkItems(rows, false);
    expect(display.map((item) => item.kind)).toEqual(["work", "assistant"]);
    expect(display[1]).toBe(rows[0]);
    const group = display[0]!;
    if (!isWorkGroup(group)) throw new Error("The work group is missing.");
    expect(group.children[0]).toBe(rows[1]);
    expect(rows[1]?.tool?.output).toBe("File body");
  });
});

describe("canonical Timeline tool media", () => {
  function imageMessage(sequence: number, blobId: string) {
    return create(EventSchema, { ...completed([{ content: { case: "image", value: { altText: blobId, blob: {
      blobId, fileName: `${blobId}.png`, mediaType: "image/png", byteSize: 128n, sha256Hex: "a".repeat(64)
    } } } }]), eventId: `media-${sequence}`, cursor: create(EventCursorSchema, { generation: 1n, sequence: BigInt(sequence) }) });
  }

  it("keeps typed media outside the tool card through append, replacement and terminal authority", () => {
    const events = [toolMediaEvent(imageMessage(1, "first"), "toolCallStarted"),
      toolMediaEvent(imageMessage(2, "second"), "toolCallUpdated", ToolCallOutputMode.APPEND)];
    expect(timelineRows(events)).toMatchObject([{ kind: "tool", completed: false,
      images: [{ title: "first", sourceEventId: "media-1" }, { title: "second", sourceEventId: "media-2" }] }]);
    events.push(toolMediaEvent(imageMessage(3, "replacement"), "toolCallUpdated"));
    expect(timelineRows(events)[0]?.images?.map((image) => image.title)).toEqual(["replacement"]);
    events.push(toolMediaEvent(imageMessage(4, "final")),
      toolMediaEvent(imageMessage(5, "late"), "toolCallUpdated", ToolCallOutputMode.APPEND));
    expect(timelineRows(events)).toMatchObject([{ completed: true, images: [{ title: "final", sourceEventId: "media-4" }] }]);
    const produced = producedArtifactEvent(imageMessage(6, "final"));
    expect(timelineRows([...events, produced])).toHaveLength(1);
  });

  it("projects independent typed images and artifacts while refusing text URLs and foreign artifact scope", () => {
    const image = producedImageEvent(imageMessage(1, "image"));
    const artifact = producedArtifactEvent(completed([{ content: { case: "artifact", value: { label: "PDF", blob: {
      blobId: "pdf", fileName: "proof.pdf", mediaType: "application/pdf", byteSize: 128n, sha256Hex: "b".repeat(64)
    } } } }]));
    expect(timelineRows([image, artifact])).toMatchObject([
      { label: "File", artifacts: [{ title: "PDF", source: { kind: "artifactProduced", artifactId: "canonical-file" } }] },
      { label: "Image", images: [{ title: "image" }] }
    ]);
    if (artifact.payload?.kind.case !== "artifactProduced") throw new Error("fixture");
    artifact.payload.kind.value.artifact!.sessionId = "foreign";
    expect(timelineRows([artifact])).toEqual([]);
    expect(timelineRows([toolMediaEvent(completed([{ content: { case: "text", value: "https://example.test/image.png" } }]))])[0]?.images)
      .toBeUndefined();
    const animation = imageMessage(2, "animation");
    if (animation.payload?.kind.case !== "messageCompleted" || animation.payload.kind.value.blocks[0]?.content.case !== "image") throw new Error("fixture");
    const blob = animation.payload.kind.value.blocks[0].content.value.blob!;
    blob.mediaType = "image/gif";
    blob.fileName = "animation.gif";
    expect(timelineRows([producedImageEvent(animation)])[0]).toMatchObject({ images: [{ title: "animation", mediaType: "image/gif" }] });
    expect(timelineRows([producedImageEvent(animation)])[0]?.artifacts).toBeUndefined();
  });
});

describe("mobile accepted-input send identity", () => {
  it("projects only the exact durable Operation identity onto canonical user rows", () => {
    const started = create(EventSchema, {
      eventId: "accepted-start",
      identity: { sessionId: "session", operationId: "send-operation" },
      cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "accepted-message",
        role: MessageRole.USER,
        userInputAccepted: true,
        userInput: { parts: [{ content: { case: "text", value: "Hello" } }] }
      } } }
    });
    const completedUser = create(EventSchema, {
      eventId: "accepted-complete",
      identity: { sessionId: "session", operationId: "send-operation" },
      cursor: { generation: 1n, sequence: 2n },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "accepted-message",
        role: MessageRole.USER,
        blocks: [{ content: { case: "text", value: "native echo" } }]
      } } }
    });
    expect(timelineRows([started, completedUser])).toMatchObject([{
      id: "accepted-message",
      operationId: "send-operation",
      text: "Hello",
      completed: true
    }]);

    const imported = create(EventSchema, {
      eventId: "imported-start",
      identity: { sessionId: "session", operationId: "send-operation" },
      cursor: { generation: 1n, sequence: 3n },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "imported-message",
        role: MessageRole.USER,
        userInputAccepted: false,
        userInput: { parts: [{ content: { case: "text", value: "Imported" } }] }
      } } }
    });
    expect(timelineRows([imported])[0]?.operationId).toBeUndefined();
  });
});

const privateToolName = "mcp__joko_partners__send_private_message";
const privateResult = {
  thread_id: "thread-one",
  message_id: "message-one",
  target_partner: { id: "partner-two", display_name: "Nova", avatar: "orbit", status: "active", ready: true },
  delivery_status: "delivered",
  remaining_messages: 11,
  conversation_ended: false
};

function toolStarted(name = privateToolName, input: unknown = {
  target_partner_id: "partner-two", message: "Please verify the recovery boundary."
}) {
  return create(EventSchema, {
    eventId: "tool-start",
    identity: { sessionId: "session-one" },
    cursor: { generation: 1n, sequence: 1n },
    payload: { kind: { case: "toolCallStarted", value: { toolCall: {
      toolCallId: "call-one", toolId: name, sessionId: "session-one", runId: "run-one", attemptId: "attempt-one",
      state: ToolCallState.RUNNING,
      arguments: [{ fieldPath: "$", value: { case: "text", value: JSON.stringify(input) } }]
    } } } }
  });
}

function toolCompleted(options: {
  name?: string;
  result?: unknown;
  state?: ToolCallState;
  providerId?: string;
  truncated?: boolean;
  parts?: { content: { case: "text"; value: string } }[];
} = {}) {
  return create(EventSchema, {
    eventId: "tool-completed",
    identity: { sessionId: "session-one" },
    cursor: { generation: 1n, sequence: 2n },
    payload: { kind: { case: "toolCallCompleted", value: { toolCall: {
      toolCallId: "call-one", toolId: options.name ?? privateToolName,
      toolProviderId: options.providerId ?? "",
      sessionId: "session-one", runId: "run-one", attemptId: "attempt-one",
      state: options.state ?? ToolCallState.SUCCEEDED,
      result: { parts: options.parts ?? [{ content: { case: "text", value: JSON.stringify(options.result ?? privateResult) } }],
        truncated: options.truncated ?? false }
    } } } }
  });
}

describe("mobile Partner private message Timeline preview", () => {
  it("projects only a successful current Partner tool result and uses matching call input for optional preview", () => {
    const rows = timelineRows([toolCompleted(), toolStarted()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tool", completed: true,
      partnerPrivatePreview: { threadId: "thread-one", targetPartnerId: "partner-two", targetName: "Nova",
        preview: "Please verify the recovery boundary." } });
    expect(timelineRows([toolCompleted()])[0]?.partnerPrivatePreview).toEqual({
      threadId: "thread-one", targetPartnerId: "partner-two", targetName: "Nova"
    });
    expect(timelineRows([toolStarted(privateToolName, {
      target_partner_id: "partner-three", message: "Different target"
    }), toolCompleted()])[0]?.partnerPrivatePreview).toEqual({
      threadId: "thread-one", targetPartnerId: "partner-two", targetName: "Nova"
    });
  });

  it("recognizes the exact owned provider alias and leaves foreign or failed calls generic", () => {
    const ownedAlias = "mcp__joko_28e1bfbb33986d6789e0c720__send_private_message";
    expect(timelineRows([toolCompleted({ name: ownedAlias })])[0]?.partnerPrivatePreview?.threadId)
      .toBe("thread-one");
    for (const options of [
      { name: "mcp__other__send_private_message" },
      { name: "send_private_message" },
      { name: "mcp__joko_000000000000000000000000__send_private_message" },
      { providerId: "other" },
      { state: ToolCallState.FAILED }
    ]) {
      const row = timelineRows([toolCompleted(options)])[0];
      expect(row).toMatchObject({ kind: "tool", completed: true });
      expect(row?.partnerPrivatePreview).toBeUndefined();
    }
  });

  it("keeps malformed or incomplete result envelopes as generic tool rows", () => {
    for (const options of [
      { result: { ...privateResult, target_partner: { ...privateResult.target_partner, id: "bad id" } } },
      { result: { ...privateResult, target_partner: { ...privateResult.target_partner, display_name: "\u202eNova" } } },
      { result: { ...privateResult, thread_id: "" } },
      { result: { ...privateResult, delivery_status: "failed" } },
      { result: { ...privateResult, extra: "unexpected" } },
      { truncated: true },
      { parts: [{ content: { case: "text" as const, value: "not JSON" } }] }
    ]) {
      const row = timelineRows([toolCompleted(options)])[0];
      expect(row).toMatchObject({ kind: "tool", completed: true });
      expect(row?.partnerPrivatePreview).toBeUndefined();
    }
  });
});

describe("native Timeline tool lifecycle", () => {
  function callEvent(sequence: number, phase: "toolCallStarted" | "toolCallUpdated" | "toolCallCompleted", options: {
    output?: string; mode?: ToolCallOutputMode; name?: string; sessionId?: string; attemptId?: string; generation?: bigint;
    state?: ToolCallState; redacted?: boolean; input?: string; truncated?: boolean;
  } = {}) {
    const call = { toolCallId: "command-one", toolId: options.name ?? "Bash", sessionId: options.sessionId ?? "task-one",
      runId: "run-one", attemptId: options.attemptId ?? "attempt-one", state: options.state ?? ToolCallState.RUNNING,
      arguments: phase === "toolCallStarted" ? [{ fieldPath: "$", redacted: options.redacted ?? false,
        value: { case: "text" as const, value: options.input ?? '{"command":"pnpm build"}' } }] : [],
      ...(phase === "toolCallCompleted" ? { result: { parts: options.output === undefined ? []
        : [{ content: { case: "text" as const, value: options.output } }], truncated: options.truncated ?? false } } : {}) };
    return create(EventSchema, { eventId: `event-${sequence}`, identity: { sessionId: "task-one" },
      cursor: { sequence: BigInt(sequence), generation: options.generation ?? 1n },
      payload: { kind: phase === "toolCallUpdated" ? { case: phase, value: { toolCall: call,
        incrementalResult: { parts: [{ content: { case: "text", value: options.output ?? "" } }] },
        outputMode: options.mode ?? ToolCallOutputMode.REPLACE } } : { case: phase, value: { toolCall: call } } }
    });
  }

  it("merges ordered append/replace/terminal receipts at one stable row and never reopens it for a late update", () => {
    const events = [callEvent(1, "toolCallStarted"), callEvent(2, "toolCallUpdated", { output: "first" }),
      callEvent(3, "toolCallUpdated", { output: " chunk", mode: ToolCallOutputMode.APPEND }),
      callEvent(4, "toolCallUpdated", { output: "replacement", mode: ToolCallOutputMode.UNSPECIFIED })];
    expect(timelineRows(events)[0]).toMatchObject({ eventId: "event-4", sequence: 1n, completed: false,
      tool: { input: '$: {"command":"pnpm build"}', output: "replacement", summary: { action: "runCommand", primary: "pnpm build" } } });
    events.push(callEvent(5, "toolCallCompleted", { output: "final", state: ToolCallState.SUCCEEDED }));
    events.push(callEvent(6, "toolCallUpdated", { output: "late" }));
    expect(timelineRows([...events].reverse())).toMatchObject([{ eventId: "event-5", completed: true,
      tool: { state: "succeeded", output: "final" } }]);
    expect(timelineRows([events[0]!, events[1]!, events[2]!])[0]?.tool?.output).toBe("first chunk");
  });

  it("isolates call identity by attempt/generation/name and refuses a foreign Session payload", () => {
    const events = [callEvent(1, "toolCallStarted"), callEvent(2, "toolCallUpdated", { attemptId: "other-attempt", output: "attempt" }),
      callEvent(3, "toolCallUpdated", { generation: 2n, output: "generation" }),
      callEvent(4, "toolCallCompleted", { name: "Read", output: "different tool", state: ToolCallState.FAILED }),
      callEvent(5, "toolCallCompleted", { sessionId: "foreign", output: "hidden", state: ToolCallState.SUCCEEDED })];
    const rows = timelineRows(events);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.tool?.output)).toEqual(["", "attempt", "generation", "different tool", undefined]);
    expect(rows.map((row) => row.tool?.output ?? row.text).join("\n")).not.toContain("hidden");
  });

  it("keeps redacted, unknown, malformed and over-budget input as bounded raw display with explicit truncation", () => {
    const redacted = timelineRows([callEvent(1, "toolCallStarted", { redacted: true, input: "private input" }),
      callEvent(2, "toolCallUpdated", { output: "result" })])[0]?.tool;
    expect(redacted).toMatchObject({ input: "$: ••••", inputRedacted: true });
    expect(redacted?.summary).toBeUndefined();
    for (const options of [{ name: "unknown_tool" }, { input: "{broken" }]) {
      expect(timelineRows([callEvent(1, "toolCallStarted", options)])[0]?.tool?.summary).toBeUndefined();
    }
    const large = timelineRows([callEvent(1, "toolCallStarted", { input: "x".repeat(300_000) }),
      callEvent(2, "toolCallCompleted", { output: "preview", truncated: true, state: ToolCallState.SUCCEEDED })])[0]?.tool;
    expect(large?.input.length).toBe(262_144);
    expect(large).toMatchObject({ inputTruncated: true, output: "preview", outputTruncated: true });
  });

  it("retains typed command stdout/stderr, table cells and file revision display without promoting paths to actions", () => {
    const event = callEvent(1, "toolCallCompleted", { state: ToolCallState.FAILED });
    if (event.payload?.kind.case !== "toolCallCompleted") throw new Error("fixture missing result");
    event.payload.kind.value.toolCall!.result = create(ToolResultSchema, { parts: [
      { content: { case: "command", value: { commandDisplay: "git status", stdoutPreview: "out", stderrPreview: "err", exitCode: 2, completed: true } } },
      { content: { case: "table", value: { columns: ["name", "value"], rows: [{ cells: ["first", "second"] }] } } },
      { content: { case: "fileChange", value: { workspaceId: "workspace", relativePath: "src/main.ts", action: ToolFileAction.UPDATED, revisionBefore: "r1", revisionAfter: "r2" } } }
    ] });
    const result = timelineRows([event])[0]?.tool;
    expect(result?.output).toContain("git status\nout\nerr\nexit_code: 2");
    expect(result?.output).toContain("name\tvalue\nfirst\tsecond");
    expect(result?.output).toContain('"path":"src/main.ts"');
    expect(result?.state).toBe("failed");
  });
});
