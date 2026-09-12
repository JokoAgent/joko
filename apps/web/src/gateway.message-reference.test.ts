import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, OperationState, SnapshotSchema, SubmitOperationResponseSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("structured message-reference gateway wiring", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a chip-only draft and emits its canonical link as a real text input part", async () => {
    vi.stubGlobal("window", { location: { href: "https://joko.test/app?profile=local#/tasks/current" } });
    const payloads: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "submitOperation") {
          payloads.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-message", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.send("session-current", {
      text: "",
      attachments: [],
      mentions: [{
        id: "message:task-one:event-nine",
        kind: "message",
        reference: "entry:42",
        label: "Review task",
        sessionId: "task/one",
        role: "assistant",
        sourceEventId: "event/9"
      }],
      deliveryMode: "prompt"
    }, { expectedGeneration: 1n });

    expect(payloads[0]?.value.input.parts.map((part: any) => ({ content: part.content }))).toEqual([{
      content: {
        case: "text",
        value: "https://joko.test/app?profile=local#/tasks/task%2Fone?event=event%2F9&message=entry%3A42"
      }
    }]);
    await gateway.send("session-current", {
      text: "@src/ @main.ts:2–5", attachments: [], deliveryMode: "prompt",
      inlineMentionRanges: [{ mentionId: "directory", from: 0, to: 5 }, { mentionId: "lines", from: 6, to: 18 }],
      mentions: [
        { id: "directory", kind: "workspace", workspaceId: "workspace", reference: "src", label: "src", token: "@src/", directory: true },
        { id: "lines", kind: "workspace", workspaceId: "workspace", reference: "src/main.ts", label: "main.ts:2–5", token: "@main.ts:2–5", lineRange: { startLine: 2, endLine: 5 } }
      ]
    }, { expectedGeneration: 1n });
    expect(payloads[1]?.value.input.parts.filter((part: any) => part.content.case === "workspaceMention").map((part: any) => part.content.value)).toMatchObject([
      { relativePath: "src", directory: true },
      { relativePath: "src/main.ts", directory: false, lineRange: { startLine: 2, endLine: 5 } }
    ]);
    await gateway.send("session-current", {
      text: "@report", attachments: [], deliveryMode: "prompt",
      inlineMentionRanges: [{ mentionId: "artifact:report", from: 0, to: 7 }],
      mentions: [{ id: "artifact:report", kind: "artifact", reference: "artifact-opaque", label: "report", token: "@report" }]
    }, { expectedGeneration: 1n });
    expect(payloads[2]?.value.input.parts.at(-1).content).toMatchObject({
      case: "artifactMention", value: { artifactId: "artifact-opaque", displayText: "report" }
    });
    expect(payloads[2]?.value.input.mentionRanges).toMatchObject([{ start: 0, end: 7, mentionIndex: 0 }]);
    await gateway.send("session-current", {
      text: "@release", attachments: [], deliveryMode: "prompt",
      inlineMentionRanges: [{ mentionId: "resource:release", from: 0, to: 8 }],
      mentions: [{
        id: "resource:release", kind: "resource", reference: "resource-opaque", label: "release", token: "@release",
        discoveredRevision: "sha256:exact", resourceVersion: "9", runtimeGeneration: 4
      }]
    }, { expectedGeneration: 1n });
    expect(payloads[3]?.value.input.parts.at(-1).content).toMatchObject({
      case: "resourceMention",
      value: {
        resourceId: "resource-opaque",
        displayText: "release",
        discoveredRevision: "sha256:exact",
        resourceVersion: 9n,
        runtimeGeneration: 4n
      }
    });
    await gateway.send("session-current", {
      text: "@earlier", attachments: [], deliveryMode: "prompt",
      inlineMentionRanges: [{ mentionId: "session:earlier", from: 0, to: 8 }],
      mentions: [{ id: "session:earlier", kind: "session", reference: "task/earlier", label: "earlier", token: "@earlier" }]
    }, { expectedGeneration: 1n });
    expect(payloads[4]?.value.input.parts.at(-1).content).toMatchObject({
      case: "sessionMention", value: { sessionId: "task/earlier", displayText: "earlier" }
    });
    expect(payloads[4]?.value.input.mentionRanges).toMatchObject([{ start: 0, end: 8, mentionIndex: 0 }]);
    await expect(gateway.send("session-current", {
      text: "@earlier", attachments: [], deliveryMode: "prompt",
      inlineMentionRanges: [{ mentionId: "session:earlier", from: 0, to: 8 }],
      mentions: [{ id: "session:earlier", kind: "session", reference: " task/earlier", label: "earlier", token: "@earlier" }]
    }, { expectedGeneration: 1n })).rejects.toThrow("exact task identity");
    await expect(gateway.send("session-current", {
      text: "@release", attachments: [], deliveryMode: "prompt",
      inlineMentionRanges: [{ mentionId: "resource:release", from: 0, to: 8 }],
      mentions: [{ id: "resource:release", kind: "resource", reference: "resource-opaque", label: "release", token: "@release" }]
    } as any, { expectedGeneration: 1n })).rejects.toThrow("exact runtime identity");
    const exactResource = {
      id: "resource:release", kind: "resource", reference: "resource-opaque", label: "release", token: "@release",
      discoveredRevision: "sha256:exact", resourceVersion: "9", runtimeGeneration: 4
    } as const;
    for (const invalidIdentity of [
      { ...exactResource, reference: " resource-opaque" },
      { ...exactResource, discoveredRevision: "sha256:exact\n" },
      { ...exactResource, resourceVersion: "1".repeat(21) },
      { ...exactResource, runtimeGeneration: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      await expect(gateway.send("session-current", {
        text: "@release", attachments: [], deliveryMode: "prompt",
        inlineMentionRanges: [{ mentionId: "resource:release", from: 0, to: 8 }],
        mentions: [invalidIdentity]
      }, { expectedGeneration: 1n })).rejects.toThrow("exact runtime identity");
    }
    await expect(gateway.send("session-current", {
      text: "@report", attachments: [], deliveryMode: "prompt",
      mentions: [{ id: "artifact:report", kind: "artifact", reference: "artifact-opaque", label: "report", token: "@report" }]
    }, { expectedGeneration: 1n })).rejects.toThrow("invalid mention occurrences");
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
