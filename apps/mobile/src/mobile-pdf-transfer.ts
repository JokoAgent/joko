import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { MOBILE_PDF_PREVIEW_ROOT_DIRECTORY } from "./mobile-pdf-preview";
import {
  buildMobilePdfViewerCommand,
  mobilePdfViewerLimits,
  type MobilePdfViewerAck
} from "./mobile-pdf-viewer";

export interface MobilePdfChunkReader {
  readonly byteSize: number;
  read(maximumBytes: number): Uint8Array | Promise<Uint8Array>;
  close(): void | Promise<void>;
}

export interface MobilePdfChunkFileDriver {
  open(uri: string, fileName: string, expectedByteSize: number): Promise<MobilePdfChunkReader>;
}

export class MobilePdfTransferSession {
  #reader?: MobilePdfChunkReader;
  #state: "idle" | "opening" | "begin" | "chunk" | "commit" | "done" | "aborted" = "idle";
  #offset = 0;
  #nextIndex = 0;
  #pendingIndex = -1;
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly input: {
    readonly instanceId: string;
    readonly uri: string;
    readonly fileName: string;
    readonly byteSize: number;
    readonly sha256Hex: string;
    readonly send: (message: string) => void;
    readonly driver?: MobilePdfChunkFileDriver;
  }) {
    if (typeof input.instanceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.instanceId)
      || typeof input.uri !== "string" || !input.uri.startsWith("file://") || input.uri.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(input.uri)
      || input.fileName !== `preview-${input.instanceId}.pdf`
      || !Number.isSafeInteger(input.byteSize) || input.byteSize < 64
      || input.byteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
      || !/^[0-9a-f]{64}$/u.test(input.sha256Hex) || typeof input.send !== "function") {
      throw new Error("The PDF transfer source is invalid.");
    }
  }

  get done(): boolean { return this.#state === "done" || this.#state === "aborted"; }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("The PDF transfer has already started.");
    this.#state = "opening";
    const reader = await (this.input.driver ?? expoMobilePdfChunkFileDriver)
      .open(this.input.uri, this.input.fileName, this.input.byteSize);
    if ((this.#state as string) === "aborted") {
      await reader.close();
      return;
    }
    if (!Number.isSafeInteger(reader.byteSize) || reader.byteSize !== this.input.byteSize) {
      await reader.close();
      this.#state = "aborted";
      throw new Error("The app-owned PDF transfer file changed size.");
    }
    this.#reader = reader;
    this.#state = "begin";
    try {
      this.input.send(buildMobilePdfViewerCommand(this.input.instanceId, {
        command: "begin",
        byteSize: this.input.byteSize,
        sha256Hex: this.input.sha256Hex
      }));
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  accept(ack: MobilePdfViewerAck): Promise<void> {
    const operation = this.#tail.then(() => this.#accept(ack)).catch(async (error: unknown) => {
      await this.abort();
      throw error;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async abort(): Promise<void> {
    if (this.#state === "aborted" || this.#state === "done") return;
    this.#state = "aborted";
    const reader = this.#reader;
    this.#reader = undefined;
    await reader?.close();
  }

  async #accept(ack: MobilePdfViewerAck): Promise<void> {
    if (this.#state === "aborted" || this.#state === "done") return;
    if (ack.instanceId !== this.input.instanceId) throw await this.#fail("The PDF viewer acknowledged another transfer.");
    if (this.#state === "begin") {
      if (ack.command !== "begin" || ack.index !== -1) throw await this.#fail("The PDF viewer begin acknowledgement is invalid.");
      await this.#sendNext();
      return;
    }
    if (this.#state === "chunk") {
      if (ack.command !== "chunk" || ack.index !== this.#pendingIndex) {
        throw await this.#fail("The PDF viewer chunk acknowledgement is out of order.");
      }
      await this.#sendNext();
      return;
    }
    if (this.#state === "commit") {
      if (ack.command !== "commit" || ack.index !== this.#nextIndex - 1) {
        throw await this.#fail("The PDF viewer commit acknowledgement is invalid.");
      }
      this.#state = "done";
      const reader = this.#reader;
      this.#reader = undefined;
      await reader?.close();
      return;
    }
    throw await this.#fail("The PDF viewer acknowledged an inactive transfer.");
  }

  async #sendNext(): Promise<void> {
    const reader = this.#reader;
    if (!reader) throw await this.#fail("The PDF transfer reader is unavailable.");
    if (this.#offset === this.input.byteSize) {
      this.#state = "commit";
      this.input.send(buildMobilePdfViewerCommand(this.input.instanceId, { command: "commit" }));
      return;
    }
    const maximum = Math.min(mobilePdfViewerLimits.maximumChunkBytes, this.input.byteSize - this.#offset);
    const chunk = await reader.read(maximum);
    if (this.#state === "aborted") return;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > maximum) {
      throw await this.#fail("The app-owned PDF transfer file ended unexpectedly.");
    }
    const index = this.#nextIndex;
    const offset = this.#offset;
    this.#nextIndex += 1;
    this.#offset += chunk.byteLength;
    this.#pendingIndex = index;
    this.#state = "chunk";
    this.input.send(buildMobilePdfViewerCommand(this.input.instanceId, {
      command: "chunk",
      index,
      offset,
      base64: encodeMobilePdfChunk(chunk)
    }));
  }

  async #fail(reason: string): Promise<Error> {
    await this.abort();
    return new Error(reason);
  }
}

export function encodeMobilePdfChunk(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
    || bytes.byteLength > mobilePdfViewerLimits.maximumChunkBytes) {
    throw new Error("The PDF transfer chunk is outside its byte budget.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const group = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(group >>> 18) & 63]!;
    result += alphabet[(group >>> 12) & 63]!;
    result += second === undefined ? "=" : alphabet[(group >>> 6) & 63]!;
    result += third === undefined ? "=" : alphabet[group & 63]!;
  }
  return result;
}

const expoMobilePdfChunkFileDriver: MobilePdfChunkFileDriver = {
  async open(uri, fileName, expectedByteSize) {
    const { Directory, File, FileMode, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_PDF_PREVIEW_ROOT_DIRECTORY);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    const file = new File(uri);
    if (!file.uri.startsWith(prefix) || file.name !== fileName || !file.exists
      || file.size !== expectedByteSize) throw new Error("The PDF transfer source is outside its verified cache lease.");
    const handle = file.open(FileMode.ReadOnly);
    let closed = false;
    return {
      byteSize: file.size,
      read(maximumBytes) {
        if (closed || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
          || maximumBytes > mobilePdfViewerLimits.maximumChunkBytes) {
          throw new Error("The PDF transfer read request is invalid.");
        }
        return handle.readBytes(maximumBytes);
      },
      close() {
        if (closed) return;
        closed = true;
        handle.close();
      }
    };
  }
};
