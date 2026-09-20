import { describe, expect, it, vi } from "vitest";
import type { MobileModelPreviewLease } from "./mobile-model-preview";
import {
  MobileModelTransferSession,
  encodeMobileModelChunk,
  type MobileModelChunkFileDriver,
  type MobileModelChunkReader
} from "./mobile-model-transfer";
import { mobileModelViewerLimits } from "./mobile-model-viewer";

describe("MobileModelTransferSession", () => {
  it("streams the exact package only after ordered acknowledgements and closes after commit", async () => {
    const bytes = Uint8Array.from({ length: mobileModelViewerLimits.maximumChunkBytes + 5 }, (_, index) => index % 251);
    const fixture = readerFixture(bytes);
    const send = vi.fn<(value: string) => void>();
    const transfer = new MobileModelTransferSession({
      instanceId: "model-1",
      lease: lease(bytes.byteLength),
      send,
      driver: fixture.driver
    });
    await transfer.start();
    expect(command(send, 0)).toMatchObject({ command: "begin", byteSize: bytes.byteLength,
      modelKind: "gltf", modelPath: "scene.gltf" });

    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "begin",
      fileIndex: -1, index: -1, offset: 0, byteSize: bytes.byteLength });
    expect(command(send, 1)).toMatchObject({ command: "chunk", fileIndex: 0, index: 0, offset: 0 });
    expect(Buffer.from(command(send, 1).base64!, "base64")).toHaveLength(mobileModelViewerLimits.maximumChunkBytes);

    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 0, index: 0, offset: 0, byteSize: mobileModelViewerLimits.maximumChunkBytes });
    expect(command(send, 2)).toMatchObject({ command: "chunk", index: 1,
      offset: mobileModelViewerLimits.maximumChunkBytes });
    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 0, index: 1, offset: mobileModelViewerLimits.maximumChunkBytes, byteSize: 5 });
    expect(command(send, 3)).toMatchObject({ command: "commit" });
    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "commit",
      fileIndex: -1, index: 1, offset: bytes.byteLength, byteSize: bytes.byteLength });
    expect(transfer.done).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("fails closed on an out-of-order acknowledgement", async () => {
    const bytes = new Uint8Array(80).fill(1);
    const fixture = readerFixture(bytes);
    const transfer = new MobileModelTransferSession({
      instanceId: "model-1", lease: lease(bytes.byteLength), send: () => undefined, driver: fixture.driver
    });
    await transfer.start();
    await expect(transfer.accept({
      type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 0, index: 0, offset: 0, byteSize: 80
    })).rejects.toThrow(/begin acknowledgement/u);
    expect(transfer.done).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("never sends one chunk across two manifest file boundaries", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const fixture = readerFixture(bytes);
    const send = vi.fn<(value: string) => void>();
    const transfer = new MobileModelTransferSession({
      instanceId: "model-1",
      lease: {
        ...lease(bytes.byteLength),
        files: [
          { path: "scene.gltf", mediaType: "model/gltf+json", byteOffset: 0,
            byteSize: 3, sha256Hex: "b".repeat(64) },
          { path: "mesh.bin", mediaType: "application/octet-stream", byteOffset: 3,
            byteSize: 5, sha256Hex: "c".repeat(64) }
        ],
        references: [{ uri: "mesh.bin", path: "mesh.bin", kind: "buffer", fileIndex: 1 }]
      },
      send,
      driver: fixture.driver
    });

    await transfer.start();
    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "begin",
      fileIndex: -1, index: -1, offset: 0, byteSize: bytes.byteLength });
    expect(command(send, 1)).toMatchObject({
      command: "chunk", fileIndex: 0, index: 0, offset: 0,
      base64: Buffer.from(bytes.slice(0, 3)).toString("base64")
    });

    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 0, index: 0, offset: 0, byteSize: 3 });
    expect(command(send, 2)).toMatchObject({
      command: "chunk", fileIndex: 1, index: 1, offset: 3,
      base64: Buffer.from(bytes.slice(3)).toString("base64")
    });

    await transfer.accept({ type: "joko-model-viewer/ack", instanceId: "model-1", command: "chunk",
      fileIndex: 1, index: 1, offset: 3, byteSize: 5 });
    expect(command(send, 3)).toMatchObject({ command: "commit" });
  });

  it("closes a reader that resolves after cancellation", async () => {
    let resolve!: (reader: MobileModelChunkReader) => void;
    const close = vi.fn();
    const driver: MobileModelChunkFileDriver = {
      open: async () => new Promise<MobileModelChunkReader>((done) => { resolve = done; })
    };
    const transfer = new MobileModelTransferSession({
      instanceId: "model-1", lease: lease(80), send: () => undefined, driver
    });
    const start = transfer.start();
    await transfer.abort();
    resolve({ byteSize: 80, read: () => new Uint8Array(80), close });
    await start;
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses canonical base64 for every supported chunk length", () => {
    expect(encodeMobileModelChunk(Uint8Array.from([1]))).toBe("AQ==");
    expect(encodeMobileModelChunk(Uint8Array.from([1, 2]))).toBe("AQI=");
    expect(encodeMobileModelChunk(Uint8Array.from([1, 2, 3]))).toBe("AQID");
    expect(() => encodeMobileModelChunk(new Uint8Array())).toThrow(/budget/u);
  });
});

function lease(byteSize: number): MobileModelPreviewLease {
  return {
    leaseId: "model-1",
    profileId: "profile-1",
    uri: "file:///cache/joko-model-preview/preview-model-1.joko-model",
    fileName: "preview-model-1.joko-model",
    mediaType: "model/gltf+json",
    modelKind: "gltf",
    modelPath: "scene.gltf",
    localByteSize: byteSize,
    packageSha256Hex: "a".repeat(64),
    files: [{ path: "scene.gltf", mediaType: "model/gltf+json", byteOffset: 0,
      byteSize, sha256Hex: "b".repeat(64) }],
    references: []
  };
}

function readerFixture(bytes: Uint8Array) {
  let offset = 0;
  const close = vi.fn();
  const driver: MobileModelChunkFileDriver = {
    async open(_uri, _fileName, expectedByteSize) {
      expect(expectedByteSize).toBe(bytes.byteLength);
      return {
        byteSize: bytes.byteLength,
        read(maximumBytes) {
          const chunk = bytes.slice(offset, offset + maximumBytes);
          offset += chunk.byteLength;
          return chunk;
        },
        close
      };
    }
  };
  return { driver, close };
}

function command(send: ReturnType<typeof vi.fn>, index: number): {
  readonly command: string;
  readonly fileIndex?: number;
  readonly byteSize?: number;
  readonly index?: number;
  readonly offset?: number;
  readonly base64?: string;
  readonly modelKind?: string;
  readonly modelPath?: string;
} {
  return JSON.parse(send.mock.calls[index]![0] as string) as ReturnType<typeof command>;
}
