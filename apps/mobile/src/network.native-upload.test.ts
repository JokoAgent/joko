import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { BlobDisposition, BlobRefSchema, BlobTransferTicketSchema, PendingBlobUploadSchema, TransferDirection } from "@joko/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fetcher: vi.fn(), trust: vi.fn(), bytes: new Uint8Array(), reads: [] as number[], handles: 0 }));
vi.mock("@joko/connection-transport", async importOriginal => ({
  ...await importOriginal<typeof import("@joko/connection-transport")>(),
  createConnectionFetch: (input: unknown) => { state.trust(input); return state.fetcher; }
}));
vi.mock("expo-file-system", () => ({
  FileMode: { ReadOnly: "r" },
  File: class {
    exists = true;
    get size() { return state.bytes.byteLength; }
    open() {
      state.handles += 1;
      let offset = 0, closed = false;
      return {
        readBytes(maximum: number) { if (closed) throw new Error("read after close"); state.reads.push(maximum); const chunk = state.bytes.slice(offset, offset + maximum); offset += chunk.byteLength; return chunk; },
        close() { if (closed) throw new Error("double close"); closed = true; state.handles -= 1; }
      };
    }
    bytes() { throw new Error("whole-file buffering is forbidden"); }
    upload() { throw new Error("native network bypass is forbidden"); }
  }
}));

import { uploadVerifiedBlob } from "./network";

function transfer(hash = createHash("sha256").update(state.bytes).digest("hex")) {
  const source = { uri: "file:///private/staged/owned", fileName: "large.bin", mediaType: "application/octet-stream", byteSize: state.bytes.byteLength, sha256Hex: hash };
  const pending = create(PendingBlobUploadSchema, { uploadId: "upload-owned", expectedByteSize: BigInt(source.byteSize), expectedSha256Hex: hash,
    ticket: create(BlobTransferTicketSchema, { ticketId: "ticket-owned", direction: TransferDirection.UPLOAD, relativeEndpoint: "/v1/blob-uploads/ticket-owned", maximumBytes: BigInt(source.byteSize), requiredMediaType: source.mediaType }) });
  const blob = create(BlobRefSchema, { blobId: "blob-owned", fileName: source.fileName, mediaType: source.mediaType, byteSize: BigInt(source.byteSize), sha256Hex: hash, disposition: BlobDisposition.ATTACHMENT });
  return { source, pending, blob };
}
const credential = { origin: "https://node.example", authKey: "connection-secret", endpointPublicKey: "captured-endpoint-key" };

beforeEach(() => { state.fetcher.mockReset(); state.trust.mockReset(); state.bytes = new Uint8Array(200_000).fill(19); state.reads.length = 0; state.handles = 0; });

describe("native attachment uploads over the pinned connection", () => {
  it("streams bounded file reads through the captured endpoint and completes the original upload", async () => {
    const input = transfer();
    const complete = vi.fn(async () => input.blob);
    let received = 0;
    state.fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      try { for (;;) { const value = await reader.read(); if (value.done) break; received += value.value.byteLength; } }
      finally { reader.releaseLock(); }
      return new Response(null, { status: 204 });
    });
    await expect(uploadVerifiedBlob(credential, input.source, input.pending, complete)).resolves.toEqual(input.blob);
    expect(state.trust).toHaveBeenCalledWith(credential);
    expect(state.fetcher).toHaveBeenCalledWith("https://node.example/v1/blob-uploads/ticket-owned", expect.objectContaining({ method: "PUT", redirect: "error", headers: { authorization: "Bearer connection-secret", "content-type": "application/octet-stream" } }));
    expect(received).toBe(state.bytes.byteLength);
    expect(state.reads.length).toBeGreaterThan(1);
    expect(Math.max(...state.reads)).toBeLessThanOrEqual(64 * 1024);
    expect(complete).toHaveBeenCalledWith("upload-owned", undefined);
    expect(state.handles).toBe(0);
  });

  it("does not complete a body whose staged bytes fail the original digest", async () => {
    const input = transfer("f".repeat(64));
    const complete = vi.fn(async () => input.blob);
    state.fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      try { while (!(await reader.read()).done) { /* stream until authenticated end */ } }
      finally { reader.releaseLock(); }
      return new Response(null, { status: 204 });
    });
    await expect(uploadVerifiedBlob(credential, input.source, input.pending, complete)).rejects.toThrow(/changed while it was uploaded/u);
    expect(complete).not.toHaveBeenCalled();
    expect(state.handles).toBe(0);
  });

  it("closes the file and prevents completion when cancellation interrupts a body", async () => {
    const input = transfer(), abort = new AbortController();
    const complete = vi.fn(async () => input.blob);
    state.fetcher.mockImplementation(async (_url: string, init: RequestInit) => {
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      try { await reader.read(); abort.abort(); await reader.read(); }
      finally { reader.releaseLock(); }
      return new Response(null, { status: 204 });
    });
    await expect(uploadVerifiedBlob(credential, input.source, input.pending, complete, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).not.toHaveBeenCalled();
    expect(state.handles).toBe(0);
  });
});
