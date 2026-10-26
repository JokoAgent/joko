import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fetcher: vi.fn(), trust: vi.fn(), files: new Map<string, Uint8Array>(), directories: new Set<string>(),
  writes: [] as number[], openHandles: 0, cancelled: 0
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "owned" }));
vi.mock("@joko/connection-transport", () => ({
  createConnectionFetch: (input: unknown) => { state.trust(input); return state.fetcher; }
}));
vi.mock("./network", () => ({ MOBILE_FILE_SHARE_MAXIMUM_BYTES: 256 * 1024 * 1024 }));
vi.mock("expo-file-system", () => {
  const uri = (...parts: Array<string | { uri: string }>): string => parts.map(part => typeof part === "string" ? part : part.uri).map((part, index) => index ? part.replace(/^\//u, "") : part.replace(/\/$/u, "")).join("/");
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(...parts); }
    get exists() { return state.directories.has(this.uri); }
    create() { state.directories.add(this.uri); }
    delete() {
      state.directories.delete(this.uri);
      for (const key of state.files.keys()) if (key.startsWith(`${this.uri}/`)) state.files.delete(key);
    }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(...parts); }
    get name() { return this.uri.split("/").at(-1)!; }
    get exists() { return state.files.has(this.uri); }
    get size() { return state.files.get(this.uri)?.byteLength ?? 0; }
    create() { if (this.exists) throw new Error("already exists"); state.files.set(this.uri, new Uint8Array()); }
    open() {
      state.openHandles += 1;
      let offset = 0, closed = false;
      return {
        close() { if (closed) throw new Error("handle closed twice"); closed = true; state.openHandles -= 1; },
        writeBytes: (chunk: Uint8Array) => {
          if (closed) throw new Error("write after close");
          state.writes.push(chunk.byteLength);
          const previous = state.files.get(this.uri)!;
          const next = new Uint8Array(previous.byteLength + chunk.byteLength);
          next.set(previous); next.set(chunk, previous.byteLength); state.files.set(this.uri, next);
        },
        readBytes: (maximum: number) => {
          if (closed) throw new Error("read after close");
          const chunk = state.files.get(this.uri)!.slice(offset, offset + maximum); offset += chunk.byteLength; return chunk;
        }
      };
    }
  }
  return { Directory, File, FileMode: { ReadOnly: "r", WriteOnly: "w" }, Paths: { cache: "file:///cache" } };
});

import { mobileFileShareTesting } from "./mobile-file-share";

function source(bytes: Uint8Array) {
  return { url: "https://node.example/v1/blobs/owned-ticket", endpointPublicKey: "captured-endpoint-key",
    headers: { authorization: "Bearer connection-secret" }, blobId: "blob-owned", fileName: "data.bin",
    mediaType: "application/octet-stream", byteSize: bytes.byteLength,
    sha256Hex: createHash("sha256").update(bytes).digest("hex") };
}

function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
    cancel() { state.cancelled += 1; }
  }), { headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream", ...headers } });
}

beforeEach(() => {
  state.fetcher.mockReset(); state.trust.mockReset(); state.files.clear(); state.directories.clear();
  state.writes.length = 0; state.openHandles = 0; state.cancelled = 0;
});

describe("native file sharing over the pinned connection", () => {
  it("writes bounded chunks from the secure response and retains incremental digest verification", async () => {
    const bytes = new Uint8Array(300_000).fill(37);
    const body = response(bytes);
    body.arrayBuffer = vi.fn(() => { throw new Error("whole-file buffering is forbidden"); });
    state.fetcher.mockResolvedValue(body);
    const progress = vi.fn();
    const file = await mobileFileShareTesting.driver.download(source(bytes), "data.bin", "owned", progress);
    expect(state.trust).toHaveBeenCalledWith({ origin: "https://node.example", endpointPublicKey: "captured-endpoint-key", transportKind: "https" });
    expect(state.fetcher).toHaveBeenCalledWith(source(bytes).url, expect.objectContaining({ redirect: "error", cache: "no-store", headers: source(bytes).headers }));
    expect(state.writes.length).toBeGreaterThan(1);
    expect(Math.max(...state.writes)).toBeLessThanOrEqual(64 * 1024);
    expect(state.files.get(file.uri)).toEqual(bytes);
    await expect(mobileFileShareTesting.driver.verify(file, bytes.byteLength, () => undefined)).resolves.toEqual({ byteSize: bytes.byteLength, sha256Hex: source(bytes).sha256Hex });
    expect(body.arrayBuffer).not.toHaveBeenCalled();
    expect(state.openHandles).toBe(0);
  });

  it("fails closed before creating native files when endpoint trust is unavailable", async () => {
    state.trust.mockImplementation(() => { throw new Error("A trusted endpoint key is required."); });
    await expect(mobileFileShareTesting.driver.download(source(new Uint8Array(4)), "data.bin", "owned", () => undefined)).rejects.toThrow(/trusted endpoint/u);
    expect(state.fetcher).not.toHaveBeenCalled();
    expect(state.files.size).toBe(0);
    expect(state.directories.size).toBe(0);
  });

  it("cancels the secure stream and removes partial files after an authenticated size mismatch", async () => {
    const bytes = new Uint8Array(4);
    state.fetcher.mockResolvedValue(response(new Uint8Array(5), { "content-length": "4" }));
    await expect(mobileFileShareTesting.driver.download(source(bytes), "data.bin", "owned", () => undefined)).rejects.toThrow(/exceeded its authenticated size/u);
    expect(state.files.size).toBe(0);
    expect(state.openHandles).toBe(0);
    expect(state.directories.has("file:///cache/joko-file-share/owned")).toBe(false);
  });

  it("cancels a stalled read and retires its handle and temporary directory", async () => {
    const abort = new AbortController();
    const bytes = new Uint8Array(4);
    state.fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, 2)); },
      cancel() { state.cancelled += 1; }
    }), { headers: { "content-length": "4", "content-type": "application/octet-stream" } }));
    await expect(mobileFileShareTesting.driver.download(source(bytes), "data.bin", "owned", () => abort.abort(), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(state.cancelled).toBe(1);
    expect(state.files.size).toBe(0);
    expect(state.openHandles).toBe(0);
  });
});
