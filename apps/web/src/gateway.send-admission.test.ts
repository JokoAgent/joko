import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  BeginBlobUploadResponseSchema,
  CompleteBlobUploadResponseSchema,
  EntityKind,
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  type SubmitOperationRequest
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";
import type { AppSnapshot, ComposerDraft } from "./model.js";

describe("input preparation and admission", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the source generation through delayed attachment reads, snapshot changes, and response retry", async () => {
    let generation = 4n;
    let snapshot: AppSnapshot | undefined;
    const submissions: SubmitOperationRequest[] = [];
    const uploads = vi.fn(async () => new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", uploads);
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        let message: unknown;
        switch (method.localName) {
          case "getSnapshot": message = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, {
            generation: 1n, sessions: [{ sessionId: "task", nativeBinding: { runtimeGeneration: generation } }]
          }) }); break;
          case "listManagedModelRuntimes": message = create(ListManagedModelRuntimesResponseSchema); break;
          case "beginBlobUpload": message = create(BeginBlobUploadResponseSchema, {
            upload: { uploadId: "upload", ticket: { relativeEndpoint: "/v1/blob-uploads/ticket" } }
          }); break;
          case "completeBlobUpload": message = create(CompleteBlobUploadResponseSchema, {
            blob: { blobId: "attachment", fileName: "note.txt", mediaType: "text/plain", byteSize: 4n }
          }); break;
          case "submitOperation":
            submissions.push(input);
            if (submissions.length === 1) throw new ConnectError("Accepted response was lost", Code.Unavailable);
            message = create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } });
            break;
          default: throw new Error(`Unexpected RPC ${method.localName}`);
        }
        return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
      }),
      stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method,
        header: new Headers(), trailer: new Headers(), message: idleStream() }))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "server", name: "Browser",
      origin: "https://orchestrator.example" }, "secret", { onSnapshot: value => { snapshot = value; } }, () => transport);
    await gateway.connect();
    const file = new File(["note"], "note.txt", { type: "text/plain" });
    let release!: (bytes: ArrayBuffer) => void;
    const read = vi.spyOn(file, "arrayBuffer").mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const draft: ComposerDraft = { text: "Review", attachments: [{ id: "local", kind: "file", file }], mentions: [], deliveryMode: "prompt" };
    await expect(gateway.send("task", draft, { expectedGeneration: 0n })).rejects.toThrow("source task generation");
    expect(read).not.toHaveBeenCalled();
    const admission = { expectedGeneration: generation };
    const pending = gateway.send("task", draft, admission);
    expect(read).toHaveBeenCalledOnce();
    expect(submissions).toEqual([]);
    generation = 5n;
    admission.expectedGeneration = generation;
    await gateway.refresh();
    expect(snapshot?.sessions[0]?.generation).toBe(5n);
    release(new TextEncoder().encode("note").buffer);
    await pending;
    expect(uploads).toHaveBeenCalledOnce();
    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.operationId).toBe(submissions[1]?.operationId);
    for (const submission of submissions) {
      expect(submission.mutation?.preconditions).toMatchObject([{ entity: { kind: EntityKind.SESSION, id: "task" }, expectedGeneration: 4n }]);
      expect(submission.mutation?.preconditions[0]?.expectedRevision).toBeUndefined();
    }
    gateway.disconnect();
  });
});

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
