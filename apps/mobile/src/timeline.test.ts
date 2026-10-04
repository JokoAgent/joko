import { create } from "@bufbuild/protobuf";
import { EventSchema, MessageRole, ToolCallState } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { timelineRows } from "./timeline";

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
      { eventId: "complete", messageId: "message", contentIndex: 0, title: "Recording", previewKind: "media" },
      { eventId: "complete", messageId: "message", contentIndex: 1, title: "Model", previewKind: "model" }
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
      { contentIndex: 0, title: "Archive" },
      { contentIndex: 1, title: "Large image" }
    ]);
    expect(row?.artifacts?.every((artifact) => artifact.previewKind === undefined)).toBe(true);
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
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: "tool", completed: true,
      partnerPrivatePreview: { threadId: "thread-one", targetPartnerId: "partner-two", targetName: "Nova",
        preview: "Please verify the recovery boundary." } });
    expect(timelineRows([toolCompleted()])[0]?.partnerPrivatePreview).toEqual({
      threadId: "thread-one", targetPartnerId: "partner-two", targetName: "Nova"
    });
    expect(timelineRows([toolStarted(privateToolName, {
      target_partner_id: "partner-three", message: "Different target"
    }), toolCompleted()])[1]?.partnerPrivatePreview).toEqual({
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
