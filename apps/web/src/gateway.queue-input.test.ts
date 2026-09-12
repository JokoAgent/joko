import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  InputContentSchema,
  ListManagedModelRuntimesResponseSchema,
  OperationState,
  QueueDeliveryMode,
  QueueItemState,
  QueueSourceKind,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot } from "./model.js";
import { queueItemEditProjection, remapQueueItemTextEdit } from "./queue-item-edit.js";
import { SELECTION_QUOTE_BLOCK_MARKER_LINE } from "./selection-quote.js";

describe("queued structured input gateway", () => {
  it.each([
    {
      label: "an unspecified delivery mode",
      deliveryMode: QueueDeliveryMode.UNSPECIFIED,
      state: QueueItemState.ACCEPTED,
      error: "unknown Queue delivery mode"
    },
    {
      label: "an unknown delivery mode",
      deliveryMode: 99 as QueueDeliveryMode,
      state: QueueItemState.ACCEPTED,
      error: "unknown Queue delivery mode"
    },
    {
      label: "an unspecified state",
      deliveryMode: QueueDeliveryMode.PROMPT,
      state: QueueItemState.UNSPECIFIED,
      error: "unknown Queue item state"
    },
    {
      label: "an unknown state",
      deliveryMode: QueueDeliveryMode.PROMPT,
      state: 99 as QueueItemState,
      error: "unknown Queue item state"
    }
  ])("rejects a reconnect snapshot with $label", async ({ deliveryMode, state, error }) => {
    const onSnapshot = vi.fn();
    const transport = {
      unary: vi.fn(async (method: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            queueItems: [{
              queueItemId: "queue-invalid-enum",
              sessionId: "task-1",
              targetId: "target-1",
              backendId: "backend-1",
              sourceKind: QueueSourceKind.UI,
              deliveryMode,
              state,
              version: { revision: { value: 1n }, generation: 1n },
              input: { parts: [{ content: { case: "text", value: "Queued text" } }] }
            }]
          })
        }));
        if (method.localName === "listManagedModelRuntimes") {
          return response(method, create(ListManagedModelRuntimesResponseSchema));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-invalid-queue-enum", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      { onSnapshot },
      () => transport
    );

    await expect(gateway.connect()).rejects.toThrow(error);
    expect(onSnapshot).not.toHaveBeenCalled();
    gateway.disconnect();
  });

  it("projects accepted atoms once, steers the exact input and edits only receipt-owned occurrences", async () => {
    const text = `${SELECTION_QUOTE_BLOCK_MARKER_LINE}\n> Selected\n\nUse @same then @same and PASTE`;
    const firstMention = text.indexOf("@same");
    const secondMention = text.indexOf("@same", firstMention + 1);
    const pastedStart = text.indexOf("PASTE");
    const acceptedInput = create(InputContentSchema, {
      parts: [
        { content: { case: "text", value: text } },
        { content: { case: "artifactMention", value: { artifactId: "artifact-1", displayText: "same" } } },
        { content: { case: "workspaceMention", value: { workspaceId: "workspace-1", relativePath: "src/report.ts", displayText: "same" } } },
        { content: { case: "resourceMention", value: { resourceId: "resource-1", displayText: "release", discoveredRevision: "sha256:resource", resourceVersion: 3n, runtimeGeneration: 2n } } },
        { content: { case: "sessionMention", value: { sessionId: "earlier-task", displayText: "earlier" } } },
        { content: { case: "file", value: { blobId: "file-1", fileName: "notes.txt", mediaType: "text/plain", byteSize: 12n } } },
        { content: { case: "image", value: { altText: "diagram.png", blob: { blobId: "image-1", fileName: "diagram.png", mediaType: "image/png", byteSize: 42n } } } }
      ],
      quotesEncoded: true,
      pastedTextRanges: [{ start: pastedStart, end: pastedStart + 5, display: "Pasted text (1 line)" }],
      mentionRanges: [
        { start: firstMention, end: firstMention + 5, mentionIndex: 1 },
        { start: secondMention, end: secondMention + 5, mentionIndex: 0 }
      ]
    });
    const submissions: any[] = [];
    let snapshot: AppSnapshot | undefined;
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            queueItems: [{
              queueItemId: "queue-1",
              sessionId: "task-1",
              targetId: "target-1",
              backendId: "backend-1",
              sourceKind: QueueSourceKind.UI,
              deliveryMode: QueueDeliveryMode.FOLLOW_UP,
              state: QueueItemState.ACCEPTED,
              ordinal: 0n,
              version: { revision: { value: 4n }, generation: 2n },
              input: acceptedInput
            }]
          })
        }));
        if (method.localName === "listManagedModelRuntimes") {
          return response(method, create(ListManagedModelRuntimesResponseSchema));
        }
        if (method.localName === "submitOperation") {
          submissions.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-queue", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      { onSnapshot: (value) => { snapshot = value; } },
      () => transport
    );
    await gateway.connect();

    const queued = snapshot!.queue[0]!;
    expect(queued.text).toBe(text);
    expect(queued.text.match(/@same/gu)).toHaveLength(2);
    expect(queued).toMatchObject({
      quotesEncoded: true,
      pastedTextRanges: [{ start: pastedStart, end: pastedStart + 5, display: "Pasted text (1 line)" }],
      mentionRanges: [
        { start: firstMention, end: firstMention + 5, mentionIndex: 1 },
        { start: secondMention, end: secondMention + 5, mentionIndex: 0 }
      ],
      inputMentions: [
        { kind: "artifact", artifactId: "artifact-1" },
        { kind: "workspace", workspaceId: "workspace-1", relativePath: "src/report.ts" },
        { kind: "resource", resourceId: "resource-1", resourceVersion: "3", runtimeGeneration: 2 },
        { kind: "session", sessionId: "earlier-task" }
      ],
      attachments: [{ kind: "file", label: "notes.txt" }, { kind: "image", label: "diagram.png" }]
    });

    await gateway.steerQueueItemNow("queue-1", "steer-lock");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ case: "editQueueItem", value: {
      queueItemId: "queue-1", deliveryMode: QueueDeliveryMode.STEER, lockToken: "steer-lock"
    } });
    expect(submissions[0].value.input).toEqual(acceptedInput);
    expect(submissions[0].value.textSplices).toEqual([]);

    const editorSource = queueItemEditProjection(queued);
    await gateway.editQueueItem("queue-1", editorSource, "followUp", "edit-lock");
    expect(submissions).toHaveLength(1);

    const removedStart = editorSource.text.indexOf("@same");
    const edit = remapQueueItemTextEdit(
      editorSource,
      `${editorSource.text.slice(0, removedStart)}${editorSource.text.slice(removedStart + 6)}`,
      { selectionStart: removedStart, selectionEnd: removedStart + 6, inputType: "deleteContentForward" }
    );
    await gateway.editQueueItem("queue-1", edit, "followUp", "edit-lock");
    expect(submissions).toHaveLength(2);
    const changed = submissions[1]?.value.input;
    expect(changed.quotesEncoded).toBe(false);
    expect(changed.parts.map((part: any) => part.content.case)).toEqual([
      "text", "artifactMention", "resourceMention", "sessionMention", "file", "image"
    ]);
    expect(changed.parts[0].content.value).toBe(edit.text);
    expect(changed.mentionRanges.map(({ start, end, mentionIndex }: any) => ({ start, end, mentionIndex }))).toEqual(edit.mentionRanges);
    expect(changed.pastedTextRanges.map(({ start, end, display }: any) => ({ start, end, display }))).toEqual(edit.pastedTextRanges);
    expect(submissions[1]?.value.textSplices.map(({ start, end, replacementText }: any) => ({ start, end, replacementText })))
      .toEqual(edit.textSplices);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
