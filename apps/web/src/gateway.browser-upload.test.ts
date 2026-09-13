import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  BeginBlobUploadResponseSchema,
  BlobDisposition,
  CompleteBlobUploadResponseSchema,
  GetSnapshotResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  TransferDirection
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("browser file upload gateway", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("commits the Blob before submitting the durable page upload mutation", async () => {
    const calls: string[] = [];
    const submitted: any[] = [];
    const fetch = vi.fn(async () => {
      calls.push("put");
      return new Response(undefined, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
        if (method.localName === "beginBlobUpload") {
          calls.push("begin");
          expect(input).toMatchObject({
            fileName: "proof.txt",
            mediaType: "text/plain",
            byteSize: 5n,
            sha256Hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            disposition: BlobDisposition.ATTACHMENT
          });
          return response(method, create(BeginBlobUploadResponseSchema, {
            upload: {
              uploadId: "upload-1",
              ticket: {
                ticketId: "ticket-1",
                direction: TransferDirection.UPLOAD,
                relativeEndpoint: "/v1/blob-uploads/ticket-1",
                maximumBytes: 5n,
                requiredMediaType: "application/octet-stream"
              },
              expectedByteSize: 5n
            }
          }));
        }
        if (method.localName === "completeBlobUpload") {
          calls.push("complete");
          expect(input).toMatchObject({ uploadId: "upload-1" });
          return response(method, create(CompleteBlobUploadResponseSchema, {
            blob: {
              blobId: "blob-1",
              fileName: "proof.txt",
              mediaType: "text/plain",
              byteSize: 5n,
              sha256Hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              disposition: BlobDisposition.ATTACHMENT
            }
          }));
        }
        if (method.localName === "submitOperation") {
          calls.push("submit");
          submitted.push(input.mutation.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected RPC ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await gateway.uploadBrowserFile("browser-1", "page-1", new File(["hello"], "proof.txt", { type: "text/plain" }));

    expect(calls).toEqual(["begin", "put", "complete", "submit"]);
    expect(fetch).toHaveBeenCalledWith("https://orchestrator.example/v1/blob-uploads/ticket-1", expect.objectContaining({
      method: "PUT",
      headers: expect.objectContaining({ authorization: "Bearer secret", "content-type": "application/octet-stream" })
    }));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      case: "uploadBrowserFile",
      value: {
        browserProviderId: "browser-1",
        pageId: "page-1",
        inputHint: "input[type=file]",
        blob: { blobId: "blob-1", fileName: "proof.txt" }
      }
    });
    gateway.disconnect();
  });

  it.each(["read", "digest", "ticket", "put", "complete"] as const)("stops an admitted upload after disconnect during %s", async (stage) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const calls: string[] = [];
    const rpcSignals: Array<AbortSignal | undefined> = [];
    const pause = async (step: typeof stage): Promise<void> => {
      if (stage === step) { entered(); await pending; }
    };
    const file = new File(["hello"], "proof.txt", { type: "text/plain" });
    const read = file.arrayBuffer.bind(file);
    vi.spyOn(file, "arrayBuffer").mockImplementation(async () => { calls.push("read"); await pause("read"); return read(); });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      calls.push("digest"); await pause("digest"); return digest(...args);
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls.push("put"); await pause("put"); return new Response(undefined, { status: 204 });
    }));
    const transport = {
      unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") return response(method, create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema) }));
        if (method.localName === "beginBlobUpload") {
          calls.push("ticket"); rpcSignals.push(signal); await pause("ticket");
          return response(method, create(BeginBlobUploadResponseSchema, { upload: {
            uploadId: "original-upload", ticket: { ticketId: "original-ticket", relativeEndpoint: "/v1/blob-uploads/original-ticket" }
          } }));
        }
        if (method.localName === "completeBlobUpload") {
          calls.push("complete"); rpcSignals.push(signal); await pause("complete");
          return response(method, create(CompleteBlobUploadResponseSchema, { blob: { blobId: "original-blob" } }));
        }
        if (method.localName === "submitOperation") {
          calls.push("submit");
          return response(method, create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } }));
        }
        throw new Error(`Unexpected RPC ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "original-connection", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "test-only-auth", {}, () => transport
    );
    await gateway.connect();
    const action = gateway.uploadBrowserFile("browser", "page", file);
    const outcome = action.then(() => undefined, (error: unknown) => error);
    await started;
    const admittedCalls = [...calls];
    gateway.disconnect();
    release();
    const error = await outcome;
    expect(calls).toEqual(admittedCalls);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(rpcSignals.every((signal) => signal?.aborted === true)).toBe(true);
  });
});

function response(method: any, message: any, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
