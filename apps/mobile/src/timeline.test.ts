import { create } from "@bufbuild/protobuf";
import { EventCursorSchema, EventIdentitySchema, EventSchema, MessageRole, QueueItemState, RunState, ToolCallOutputMode, ToolCallState, ToolFileAction, ToolResultSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";
import { isWorkGroup, mobileWorkItems } from "./mobile-work-projection";
import { producedArtifactEvent, producedImageEvent, toolMediaEvent } from "./test/timeline-media";

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

describe("mobile Timeline metadata events", () => {
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
