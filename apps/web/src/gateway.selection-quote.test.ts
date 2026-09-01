import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, ListManagedModelRuntimesResponseSchema, OperationState, SnapshotSchema, SubmitOperationResponseSchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("selected-text quote gateway wiring", () => {
  it("sends interleaved TipTap quote atoms in body order with the durable gate", async () => {
    const payloads: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "listManagedModelRuntimes") {
          return response(method, create(ListManagedModelRuntimesResponseSchema, {}));
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
    const gateway = createOrchestratorGateway({ id: "connection-quote", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.send("session-current", {
      text: "before\nafter",
      editorDocument: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "before" },
            {
              type: "composerQuote",
              attrs: {
                id: "quote-one",
                kind: "message",
                text: "selected\n\ntext",
                sessionId: "session-current",
                messageId: "assistant-message",
                role: "assistant"
              }
            },
            { type: "text", text: "after" }
          ]
        }]
      },
      attachments: [],
      mentions: [],
      deliveryMode: "prompt"
    });

    expect(payloads[0]?.value.input.quotesEncoded).toBe(true);
    expect(payloads[0]?.value.input.parts.map((part: any) => ({ content: part.content }))).toEqual([{
      content: {
        case: "text",
        value: "before\n\n> <!-- joko-selection-quote -->\n> selected\n>\n> text\n\nafter"
      }
    }]);

    await gateway.send("session-current", {
      text: "> <!-- joko-selection-quote -->\n> typed marker",
      attachments: [],
      mentions: [],
      deliveryMode: "prompt"
    });
    expect(payloads[1]?.value.input.quotesEncoded).toBe(false);
    expect(payloads[1]?.value.input.parts[0]?.content.value).toBe("> <!-- joko-selection-quote -->\n> typed marker");

    await gateway.send("session-current", {
      text: "prefix alpha\nbeta suffix",
      editorDocument: {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text: "prefix " },
            {
              type: "composerPastedText",
              attrs: { text: "alpha\nbeta", display: "Pasted text (2 lines)" }
            },
            { type: "text", text: " suffix" }
          ]
        }]
      },
      attachments: [],
      mentions: [],
      deliveryMode: "prompt"
    });
    expect(payloads[2]?.value.input).toMatchObject({
      parts: [{ content: { case: "text", value: "prefix alpha\nbeta suffix" } }],
      pastedTextRanges: [{ start: 7, end: 17, display: "Pasted text (2 lines)" }]
    });
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
