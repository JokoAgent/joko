import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { isValidContactSyncState, type ContactSyncState } from "@joko/store";

import {
  decryptContactSyncBytes,
  encryptContactSyncBytes,
  isValidContactSyncPrivateKey,
  isValidContactSyncPublicKey
} from "./contact-sync-crypto.js";

export const CONTACT_SYNC_WIRE_VERSION = 1;
export const CONTACT_SYNC_CHANNEL = "joko:contacts:sync:v1";
export const CONTACT_SYNC_CHUNK_BYTES = 256 * 1024;
export const CONTACT_SYNC_MAX_CHUNKS = 128;
export const CONTACT_SYNC_MAX_COMPRESSED_BYTES = CONTACT_SYNC_CHUNK_BYTES * CONTACT_SYNC_MAX_CHUNKS;
export const CONTACT_SYNC_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

const MAX_ACTIVE_TRANSFERS_PER_PEER = 4;
const TRANSFER_TTL_MILLISECONDS = 2 * 60 * 1_000;

export interface ContactSyncCipherChunkFrame {
  readonly version: typeof CONTACT_SYNC_WIRE_VERSION;
  readonly type: "cipher-chunk";
  readonly senderPublicKey: string;
  readonly transferId: string;
  readonly index: number;
  readonly total: number;
  readonly iv: string;
  readonly tag: string;
  readonly compression: "gzip";
  readonly data: string;
}

export interface ContactSyncStateMessage {
  readonly version: 1;
  readonly type: "state";
  readonly state: ContactSyncState;
  readonly requestReply?: boolean;
}

export interface ContactSyncEncodeOptions {
  readonly message: ContactSyncStateMessage;
  readonly ownPrivateKey: string;
  readonly ownPublicKey: string;
  readonly peerPublicKey: string;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
}

export interface ContactSyncDecodeOptions {
  readonly ciphertext: Uint8Array;
  readonly iv: string;
  readonly tag: string;
  readonly ownPrivateKey: string;
  readonly expectedPeerPublicKey: string;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly transferId: string;
  readonly totalChunks: number;
}

export interface ContactSyncCodec {
  encode(options: ContactSyncEncodeOptions, signal?: AbortSignal): Promise<readonly ContactSyncCipherChunkFrame[]>;
  decode(options: ContactSyncDecodeOptions, signal?: AbortSignal): Promise<ContactSyncStateMessage>;
}

interface PendingTransfer {
  lastActivityAt: number;
  readonly senderPublicKey: string;
  readonly total: number;
  readonly iv: string;
  readonly tag: string;
  readonly chunks: Map<number, Buffer>;
  totalBytes: number;
}

export function encodeContactSyncMessageInProcess(options: ContactSyncEncodeOptions): readonly ContactSyncCipherChunkFrame[] {
  validateEncodeOptions(options);
  const json = Buffer.from(JSON.stringify(options.message), "utf8");
  if (json.byteLength > CONTACT_SYNC_MAX_DECOMPRESSED_BYTES) {
    throw new Error("Contacts sync state exceeds the decompressed size limit.");
  }
  const compressed = gzipSync(json);
  if (compressed.byteLength > CONTACT_SYNC_MAX_COMPRESSED_BYTES) {
    throw new Error("Contacts sync state exceeds the compressed size limit.");
  }
  const transferId = randomUUID();
  const total = Math.max(1, Math.ceil(compressed.byteLength / CONTACT_SYNC_CHUNK_BYTES));
  const encrypted = encryptContactSyncBytes(compressed, options.ownPrivateKey, options.peerPublicKey, {
    sourceNodeId: options.sourceNodeId,
    destinationNodeId: options.destinationNodeId,
    transferId,
    totalChunks: total
  });
  const frames: ContactSyncCipherChunkFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    frames.push({
      version: CONTACT_SYNC_WIRE_VERSION,
      type: "cipher-chunk",
      senderPublicKey: options.ownPublicKey,
      transferId,
      index,
      total,
      iv: encrypted.iv,
      tag: encrypted.tag,
      compression: "gzip",
      data: encrypted.ciphertext.subarray(index * CONTACT_SYNC_CHUNK_BYTES,
        Math.min((index + 1) * CONTACT_SYNC_CHUNK_BYTES, encrypted.ciphertext.byteLength)).toString("base64")
    });
  }
  return frames;
}

export function decodeContactSyncMessageInProcess(options: ContactSyncDecodeOptions): ContactSyncStateMessage {
  validateDecodeOptions(options);
  if (options.ciphertext.byteLength > CONTACT_SYNC_MAX_COMPRESSED_BYTES) {
    throw new Error("Contacts sync transfer exceeds the compressed size limit.");
  }
  const compressed = decryptContactSyncBytes({
    iv: options.iv,
    tag: options.tag,
    ciphertext: Buffer.from(options.ciphertext)
  }, options.ownPrivateKey, options.expectedPeerPublicKey, {
    sourceNodeId: options.sourceNodeId,
    destinationNodeId: options.destinationNodeId,
    transferId: options.transferId,
    totalChunks: options.totalChunks
  });
  const bytes = gunzipSync(compressed, { maxOutputLength: CONTACT_SYNC_MAX_DECOMPRESSED_BYTES });
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Contacts sync payload is not valid JSON."); }
  if (!isContactSyncStateMessage(parsed)) throw new Error("Contacts sync payload is invalid.");
  return parsed;
}

export const inProcessContactSyncCodec: ContactSyncCodec = {
  encode: async (options, signal) => {
    throwIfAborted(signal);
    const frames = encodeContactSyncMessageInProcess(options);
    throwIfAborted(signal);
    return frames;
  },
  decode: async (options, signal) => {
    throwIfAborted(signal);
    const message = decodeContactSyncMessageInProcess(options);
    throwIfAborted(signal);
    return message;
  }
};

export function isContactSyncStateMessage(value: unknown): value is ContactSyncStateMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "type", "state"], ["requestReply"]) ||
    value.version !== 1 || value.type !== "state" || !isValidContactSyncState(value.state)) return false;
  return value.requestReply === undefined || typeof value.requestReply === "boolean";
}

export function isContactSyncCipherChunkFrame(value: unknown): value is ContactSyncCipherChunkFrame {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "version", "type", "senderPublicKey", "transferId", "index", "total", "iv", "tag", "compression", "data"
  ]) || value.version !== CONTACT_SYNC_WIRE_VERSION || value.type !== "cipher-chunk" ||
    !isValidContactSyncPublicKey(value.senderPublicKey) || !isTransferId(value.transferId) ||
    !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.total) ||
    (value.index as number) < 0 || (value.total as number) < 1 ||
    (value.total as number) > CONTACT_SYNC_MAX_CHUNKS || (value.index as number) >= (value.total as number) ||
    !isCanonicalBase64(value.iv, 12) || !isCanonicalBase64(value.tag, 16) || value.compression !== "gzip" ||
    typeof value.data !== "string" || value.data.length > Math.ceil(CONTACT_SYNC_CHUNK_BYTES / 3) * 4 + 4) return false;
  try {
    return decodeCanonicalBase64(value.data).byteLength <= CONTACT_SYNC_CHUNK_BYTES;
  } catch {
    return false;
  }
}

export class ContactSyncWireDecoder {
  readonly #pending = new Map<string, PendingTransfer>();
  readonly #decoding = new Map<string, symbol>();
  #abortController = new AbortController();
  #generation = 0;

  constructor(private readonly codec: ContactSyncCodec) {}

  async accept(options: {
    readonly sourceNodeId: string;
    readonly destinationNodeId: string;
    readonly frame: ContactSyncCipherChunkFrame;
    readonly ownPrivateKey: string;
    readonly expectedPeerPublicKey: string;
    readonly now?: number;
  }): Promise<ContactSyncStateMessage | null> {
    if (!isContactSyncCipherChunkFrame(options.frame)) throw new Error("Contacts sync frame is invalid.");
    const now = options.now ?? Date.now();
    this.#prune(now);
    const frame = options.frame;
    if (frame.senderPublicKey !== options.expectedPeerPublicKey) throw new Error("Contacts sync peer key mismatch.");
    const chunk = decodeCanonicalBase64(frame.data);
    const key = `${options.sourceNodeId}\u0000${frame.transferId}`;
    if (this.#decoding.has(key)) return null;
    let transfer = this.#pending.get(key);
    if (transfer === undefined) {
      const prefix = `${options.sourceNodeId}\u0000`;
      const pending = [...this.#pending].filter(([candidate]) => candidate.startsWith(prefix));
      const decoding = [...this.#decoding.keys()].filter((candidate) => candidate.startsWith(prefix)).length;
      if (pending.length + decoding >= MAX_ACTIVE_TRANSFERS_PER_PEER) {
        const oldest = pending.sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt)[0];
        if (oldest === undefined) return null;
        this.#pending.delete(oldest[0]);
      }
      transfer = {
        lastActivityAt: now,
        senderPublicKey: frame.senderPublicKey,
        total: frame.total,
        iv: frame.iv,
        tag: frame.tag,
        chunks: new Map(),
        totalBytes: 0
      };
      this.#pending.set(key, transfer);
    } else if (transfer.senderPublicKey !== frame.senderPublicKey || transfer.total !== frame.total ||
      transfer.iv !== frame.iv || transfer.tag !== frame.tag) {
      this.#pending.delete(key);
      throw new Error("Contacts sync transfer metadata changed.");
    }
    if (!transfer.chunks.has(frame.index)) {
      transfer.chunks.set(frame.index, chunk);
      transfer.totalBytes += chunk.byteLength;
      transfer.lastActivityAt = now;
      if (transfer.totalBytes > CONTACT_SYNC_MAX_COMPRESSED_BYTES) {
        this.#pending.delete(key);
        throw new Error("Contacts sync transfer exceeds the compressed size limit.");
      }
    }
    if (transfer.chunks.size !== transfer.total) return null;
    this.#pending.delete(key);
    const ciphertext = Buffer.concat(Array.from({ length: transfer.total }, (_, index) => {
      const value = transfer!.chunks.get(index);
      if (value === undefined) throw new Error("Contacts sync transfer is missing a chunk.");
      return value;
    }));
    const token = Symbol(key);
    const generation = this.#generation;
    this.#decoding.set(key, token);
    try {
      const message = await this.codec.decode({
        ciphertext,
        iv: transfer.iv,
        tag: transfer.tag,
        ownPrivateKey: options.ownPrivateKey,
        expectedPeerPublicKey: options.expectedPeerPublicKey,
        sourceNodeId: options.sourceNodeId,
        destinationNodeId: options.destinationNodeId,
        transferId: frame.transferId,
        totalChunks: frame.total
      }, this.#abortController.signal);
      return generation === this.#generation ? message : null;
    } finally {
      if (this.#decoding.get(key) === token) this.#decoding.delete(key);
    }
  }

  reset(): void {
    this.#generation += 1;
    this.#abortController.abort();
    this.#abortController = new AbortController();
    this.#pending.clear();
    this.#decoding.clear();
  }

  #prune(now: number): void {
    for (const [key, transfer] of this.#pending) {
      if (now - transfer.lastActivityAt > TRANSFER_TTL_MILLISECONDS) this.#pending.delete(key);
    }
  }
}

function validateEncodeOptions(options: ContactSyncEncodeOptions): void {
  if (!isContactSyncStateMessage(options.message) || !isValidContactSyncPrivateKey(options.ownPrivateKey) ||
    !isValidContactSyncPublicKey(options.ownPublicKey) || !isValidContactSyncPublicKey(options.peerPublicKey) ||
    !isNodeId(options.sourceNodeId) || !isNodeId(options.destinationNodeId)) {
    throw new Error("Contacts sync encode options are invalid.");
  }
}

function validateDecodeOptions(options: ContactSyncDecodeOptions): void {
  if (!(options.ciphertext instanceof Uint8Array) || !isValidContactSyncPrivateKey(options.ownPrivateKey) ||
    !isValidContactSyncPublicKey(options.expectedPeerPublicKey) || !isNodeId(options.sourceNodeId) ||
    !isNodeId(options.destinationNodeId) || !isTransferId(options.transferId) ||
    !Number.isSafeInteger(options.totalChunks) || options.totalChunks < 1 || options.totalChunks > CONTACT_SYNC_MAX_CHUNKS ||
    !isCanonicalBase64(options.iv, 12) || !isCanonicalBase64(options.tag, 16)) {
    throw new Error("Contacts sync decode options are invalid.");
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Contacts sync base64 value is invalid.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Contacts sync base64 value is invalid.");
  return decoded;
}

function isCanonicalBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string") return false;
  try { return decodeCanonicalBase64(value).byteLength === bytes; } catch { return false; }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Contacts sync codec was cancelled.");
}

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isTransferId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
