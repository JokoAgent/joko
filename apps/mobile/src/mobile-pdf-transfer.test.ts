import { describe, expect, it, vi } from "vitest";
import {
  MobilePdfTransferSession,
  encodeMobilePdfChunk,
  type MobilePdfChunkFileDriver,
  type MobilePdfChunkReader
} from "./mobile-pdf-transfer";
import { mobilePdfViewerLimits } from "./mobile-pdf-viewer";

describe("MobilePdfTransferSession", () => {
  it("streams exact bounded chunks only after ordered acknowledgements and closes after commit", async () => {
    const bytes = Uint8Array.from({ length: mobilePdfViewerLimits.maximumChunkBytes + 5 }, (_, index) => index % 251);
    const fixture = readerFixture(bytes);
    const send = vi.fn<(value: string) => void>();
    const transfer = new MobilePdfTransferSession({
      instanceId: "pdf-1",
      uri: "file:///cache/joko-pdf-preview/preview-pdf-1.pdf",
      fileName: "preview-pdf-1.pdf",
      byteSize: bytes.byteLength,
      sha256Hex: "a".repeat(64),
      send,
      driver: fixture.driver
    });
    await transfer.start();
    expect(command(send, 0)).toMatchObject({ command: "begin", byteSize: bytes.byteLength });

    await transfer.accept({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "begin", index: -1 });
    expect(command(send, 1)).toMatchObject({ command: "chunk", index: 0, offset: 0 });
    expect(Buffer.from(command(send, 1).base64!, "base64")).toHaveLength(mobilePdfViewerLimits.maximumChunkBytes);

    await transfer.accept({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "chunk", index: 0 });
    expect(command(send, 2)).toMatchObject({ command: "chunk", index: 1,
      offset: mobilePdfViewerLimits.maximumChunkBytes });
    expect(Buffer.from(command(send, 2).base64!, "base64")).toHaveLength(5);

    await transfer.accept({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "chunk", index: 1 });
    expect(command(send, 3)).toMatchObject({ command: "commit" });
    await transfer.accept({ type: "joko-pdf-viewer/ack", instanceId: "pdf-1", command: "commit", index: 1 });
    expect(transfer.done).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("fails closed and closes the reader on duplicate or out-of-order acknowledgements", async () => {
    const fixture = readerFixture(new Uint8Array(80).fill(1));
    const transfer = new MobilePdfTransferSession({
      instanceId: "pdf-2",
      uri: "file:///cache/joko-pdf-preview/preview-pdf-2.pdf",
      fileName: "preview-pdf-2.pdf",
      byteSize: 80,
      sha256Hex: "b".repeat(64),
      send: () => undefined,
      driver: fixture.driver
    });
    await transfer.start();
    await expect(transfer.accept({ type: "joko-pdf-viewer/ack", instanceId: "pdf-2", command: "chunk", index: 0 }))
      .rejects.toThrow(/begin acknowledgement/u);
    expect(transfer.done).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("closes a reader that resolves after the transfer was cancelled", async () => {
    let resolve!: (reader: MobilePdfChunkReader) => void;
    const close = vi.fn();
    const driver: MobilePdfChunkFileDriver = {
      open: async () => new Promise<MobilePdfChunkReader>((done) => { resolve = done; })
    };
    const transfer = new MobilePdfTransferSession({
      instanceId: "pdf-3",
      uri: "file:///cache/joko-pdf-preview/preview-pdf-3.pdf",
      fileName: "preview-pdf-3.pdf",
      byteSize: 80,
      sha256Hex: "c".repeat(64),
      send: () => undefined,
      driver
    });
    const start = transfer.start();
    await transfer.abort();
    resolve({ byteSize: 80, read: () => new Uint8Array(80), close });
    await start;
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses canonical base64 for every supported chunk length", () => {
    expect(encodeMobilePdfChunk(Uint8Array.from([1]))).toBe("AQ==");
    expect(encodeMobilePdfChunk(Uint8Array.from([1, 2]))).toBe("AQI=");
    expect(encodeMobilePdfChunk(Uint8Array.from([1, 2, 3]))).toBe("AQID");
    expect(() => encodeMobilePdfChunk(new Uint8Array())).toThrow(/budget/u);
  });
});

function readerFixture(bytes: Uint8Array) {
  let offset = 0;
  const close = vi.fn();
  const driver: MobilePdfChunkFileDriver = {
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
  readonly byteSize?: number;
  readonly index?: number;
  readonly offset?: number;
  readonly base64?: string;
} {
  return JSON.parse(send.mock.calls[index]![0] as string) as {
    command: string; byteSize?: number; index?: number; offset?: number; base64?: string;
  };
}
