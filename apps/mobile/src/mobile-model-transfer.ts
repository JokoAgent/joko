import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY, type MobileModelPreviewLease } from "./mobile-model-preview";
import {
  assertMobileModelViewerManifest,
  buildMobileModelViewerCommand,
  mobileModelViewerLimits,
  type MobileModelViewerAck,
  type MobileModelViewerManifest
} from "./mobile-model-viewer";

export interface MobileModelChunkReader {
  readonly byteSize: number;
  read(maximumBytes: number): Uint8Array | Promise<Uint8Array>;
  close(): void | Promise<void>;
}

export interface MobileModelChunkFileDriver {
  open(uri: string, fileName: string, expectedByteSize: number): Promise<MobileModelChunkReader>;
}

export class MobileModelTransferSession {
  #reader?: MobileModelChunkReader;
  #state: "idle" | "opening" | "begin" | "chunk" | "commit" | "done" | "aborted" = "idle";
  #offset = 0;
  #nextIndex = 0;
  #nextFileIndex = 0;
  #pendingIndex = -1;
  #pendingFileIndex = -1;
  #pendingOffset = 0;
  #pendingByteSize = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #manifest: MobileModelViewerManifest;

  constructor(private readonly input: {
    readonly instanceId: string;
    readonly lease: MobileModelPreviewLease;
    readonly send: (message: string) => void;
    readonly driver?: MobileModelChunkFileDriver;
  }) {
    const { lease } = input;
    if (typeof input.instanceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.instanceId)
      || lease.leaseId !== input.instanceId
      || typeof lease.uri !== "string" || !lease.uri.startsWith("file://") || lease.uri.length > 4_096
      || /[\u0000-\u001f\u007f]/u.test(lease.uri)
      || lease.fileName !== `preview-${input.instanceId}.joko-model`
      || !Number.isSafeInteger(lease.localByteSize) || lease.localByteSize < 2
      || lease.localByteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
      || typeof input.send !== "function") {
      throw new Error("The model transfer source is invalid.");
    }
    this.#manifest = assertMobileModelViewerManifest({
      byteSize: lease.localByteSize,
      sha256Hex: lease.packageSha256Hex,
      modelKind: lease.modelKind,
      modelPath: lease.modelPath,
      files: lease.files,
      references: lease.references
    });
  }

  get done(): boolean { return this.#state === "done" || this.#state === "aborted"; }

  async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error("The model transfer has already started.");
    this.#state = "opening";
    const { lease } = this.input;
    const reader = await (this.input.driver ?? expoMobileModelChunkFileDriver)
      .open(lease.uri, lease.fileName, lease.localByteSize);
    if ((this.#state as string) === "aborted") {
      await reader.close();
      return;
    }
    if (!Number.isSafeInteger(reader.byteSize) || reader.byteSize !== lease.localByteSize) {
      await reader.close();
      this.#state = "aborted";
      throw new Error("The app-owned model transfer package changed size.");
    }
    this.#reader = reader;
    this.#state = "begin";
    try {
      this.input.send(buildMobileModelViewerCommand(this.input.instanceId, {
        command: "begin",
        manifest: this.#manifest
      }));
    } catch (error) {
      await this.abort();
      throw error;
    }
  }

  accept(ack: MobileModelViewerAck): Promise<void> {
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

  async #accept(ack: MobileModelViewerAck): Promise<void> {
    if (this.#state === "aborted" || this.#state === "done") return;
    if (ack.instanceId !== this.input.instanceId) throw await this.#fail("The model viewer acknowledged another transfer.");
    if (this.#state === "begin") {
      if (ack.command !== "begin" || ack.fileIndex !== -1 || ack.index !== -1
        || ack.offset !== 0 || ack.byteSize !== this.#manifest.byteSize) {
        throw await this.#fail("The model viewer begin acknowledgement is invalid.");
      }
      await this.#sendNext();
      return;
    }
    if (this.#state === "chunk") {
      if (ack.command !== "chunk" || ack.fileIndex !== this.#pendingFileIndex
        || ack.index !== this.#pendingIndex || ack.offset !== this.#pendingOffset
        || ack.byteSize !== this.#pendingByteSize) {
        throw await this.#fail("The model viewer chunk acknowledgement is out of order.");
      }
      await this.#sendNext();
      return;
    }
    if (this.#state === "commit") {
      if (ack.command !== "commit" || ack.fileIndex !== -1 || ack.index !== this.#nextIndex - 1
        || ack.offset !== this.#manifest.byteSize || ack.byteSize !== this.#manifest.byteSize) {
        throw await this.#fail("The model viewer commit acknowledgement is invalid.");
      }
      this.#state = "done";
      const reader = this.#reader;
      this.#reader = undefined;
      await reader?.close();
      return;
    }
    throw await this.#fail("The model viewer acknowledged an inactive transfer.");
  }

  async #sendNext(): Promise<void> {
    const reader = this.#reader;
    if (!reader) throw await this.#fail("The model transfer reader is unavailable.");
    if (this.#offset === this.#manifest.byteSize) {
      this.#state = "commit";
      this.input.send(buildMobileModelViewerCommand(this.input.instanceId, { command: "commit" }));
      return;
    }
    while (this.#nextFileIndex < this.#manifest.files.length
      && this.#offset === this.#manifest.files[this.#nextFileIndex]!.byteOffset
        + this.#manifest.files[this.#nextFileIndex]!.byteSize) this.#nextFileIndex += 1;
    const descriptor = this.#manifest.files[this.#nextFileIndex];
    if (!descriptor || this.#offset < descriptor.byteOffset
      || this.#offset >= descriptor.byteOffset + descriptor.byteSize) {
      throw await this.#fail("The model transfer file boundary is invalid.");
    }
    const maximum = Math.min(
      mobileModelViewerLimits.maximumChunkBytes,
      this.#manifest.byteSize - this.#offset,
      descriptor.byteOffset + descriptor.byteSize - this.#offset
    );
    const chunk = await reader.read(maximum);
    if (this.#state === "aborted") return;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 || chunk.byteLength > maximum) {
      throw await this.#fail("The app-owned model transfer package ended unexpectedly.");
    }
    const index = this.#nextIndex;
    const offset = this.#offset;
    this.#nextIndex += 1;
    this.#offset += chunk.byteLength;
    this.#pendingIndex = index;
    this.#pendingFileIndex = this.#nextFileIndex;
    this.#pendingOffset = offset;
    this.#pendingByteSize = chunk.byteLength;
    this.#state = "chunk";
    this.input.send(buildMobileModelViewerCommand(this.input.instanceId, {
      command: "chunk",
      fileIndex: this.#nextFileIndex,
      index,
      offset,
      base64: encodeMobileModelChunk(chunk)
    }));
  }

  async #fail(reason: string): Promise<Error> {
    await this.abort();
    return new Error(reason);
  }
}

export function encodeMobileModelChunk(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1
    || bytes.byteLength > mobileModelViewerLimits.maximumChunkBytes) {
    throw new Error("The model transfer chunk is outside its byte budget.");
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

const expoMobileModelChunkFileDriver: MobileModelChunkFileDriver = {
  async open(uri, fileName, expectedByteSize) {
    const { Directory, File, FileMode, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_MODEL_PREVIEW_ROOT_DIRECTORY);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    const file = new File(uri);
    if (!file.uri.startsWith(prefix) || file.name !== fileName || !file.exists
      || file.size !== expectedByteSize) {
      throw new Error("The model transfer source is outside its verified cache lease.");
    }
    const handle = file.open(FileMode.ReadOnly);
    let closed = false;
    return {
      byteSize: file.size,
      read(maximumBytes) {
        if (closed || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
          || maximumBytes > mobileModelViewerLimits.maximumChunkBytes) {
          throw new Error("The model transfer read request is invalid.");
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
