import { create } from "@bufbuild/protobuf";
import { EventCursorSchema, EventSchema, MessageRole, ToolCallOutputMode, ToolCallState, ToolFileAction, ToolResultSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";
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
    expect(timelineRows([producedImageEvent(animation)])[0]).toMatchObject({ artifacts: [{ title: "animation", mediaType: "image/gif" }] });
    expect(timelineRows([producedImageEvent(animation)])[0]?.images).toBeUndefined();
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
