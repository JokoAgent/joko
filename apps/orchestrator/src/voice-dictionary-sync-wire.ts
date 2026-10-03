import { randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  decryptNodeSyncBytes,
  encryptNodeSyncBytes,
  decodeNodeSyncBase64,
  isCanonicalNodeSyncBase64,
  isNodeSyncCipherChunkFrame,
  isValidNodeSyncPrivateKey,
  isValidNodeSyncPublicKey,
  nodeSyncPublicKeyFromPrivate,
  NODE_SYNC_CHUNK_BYTES,
  type NodeSyncCipherChunkFrame,
  type NodeSyncDeliveryContext
} from "@joko/node-sync";
import { isValidSyncState, MAX_VOICE_DICTIONARY_SYNC_BYTES, type VoiceDictionarySyncState } from "@joko/voice-input";

export const VOICE_DICTIONARY_PEER_FRAME_BYTES = MAX_VOICE_DICTIONARY_SYNC_BYTES;
export const VOICE_DICTIONARY_PEER_CIPHER_BYTES = Math.floor(VOICE_DICTIONARY_PEER_FRAME_BYTES / 4) * 3;
export const VOICE_DICTIONARY_PEER_MAX_CHUNKS = Math.ceil(VOICE_DICTIONARY_PEER_CIPHER_BYTES / NODE_SYNC_CHUNK_BYTES);
const MAX_ACTIVE_TRANSFERS_PER_PEER = 4;
const MAX_ACTIVE_TRANSFERS = 16;
const MAX_RECENT_TRANSFERS = 256;
const TRANSFER_TTL_MILLISECONDS = 120_000;

/** Complete current-v1 convergence state; no device-local or materialized-dictionary reader. */
export interface VoiceDictionaryPeerMessage {
  readonly frameVersion: 1;
  readonly state: VoiceDictionarySyncState;
  readonly requestReply?: boolean;
}

export interface VoiceDictionaryPeerEncodeOptions {
  readonly message: VoiceDictionaryPeerMessage;
  readonly ownPrivateKey: string;
  readonly ownPublicKey: string;
  readonly peerPublicKey: string;
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
}

export interface VoiceDictionaryPeerDecodeOptions {
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

export interface VoiceDictionaryPeerCodec {
  encode(options: VoiceDictionaryPeerEncodeOptions, signal?: AbortSignal): Promise<readonly NodeSyncCipherChunkFrame[]>;
  decode(options: VoiceDictionaryPeerDecodeOptions, signal?: AbortSignal): Promise<VoiceDictionaryPeerMessage>;
}

export function encodeVoiceDictionaryPeerMessage(options: VoiceDictionaryPeerEncodeOptions): readonly NodeSyncCipherChunkFrame[] {
  if (!isVoiceDictionaryPeerMessage(options.message) || !isValidNodeSyncPrivateKey(options.ownPrivateKey) ||
    !isValidNodeSyncPublicKey(options.ownPublicKey) || !isValidNodeSyncPublicKey(options.peerPublicKey) ||
    nodeSyncPublicKeyFromPrivate(options.ownPrivateKey) !== options.ownPublicKey ||
    !isNodeId(options.sourceNodeId) || !isNodeId(options.destinationNodeId)) {
    throw new Error("Voice dictionary peer encode options are invalid.");
  }
  const json = Buffer.from(JSON.stringify(options.message), "utf8");
  if (json.byteLength > VOICE_DICTIONARY_PEER_FRAME_BYTES) throw new Error("Voice dictionary peer message exceeds its size limit.");
  const compressed = gzipSync(json);
  if (compressed.byteLength > VOICE_DICTIONARY_PEER_CIPHER_BYTES) throw new Error("Voice dictionary peer transfer exceeds its size limit.");
  const total = Math.max(1, Math.ceil(compressed.byteLength / NODE_SYNC_CHUNK_BYTES));
  const transferId = randomUUID();
  const encrypted = encryptNodeSyncBytes("voice-dictionary", compressed, options.ownPrivateKey, options.peerPublicKey, {
    sourceNodeId: options.sourceNodeId, destinationNodeId: options.destinationNodeId, transferId, totalChunks: total
  });
  const frames = Array.from({ length: total }, (_, index): NodeSyncCipherChunkFrame => ({
    version: 1, type: "cipher-chunk", senderPublicKey: options.ownPublicKey, transferId, index, total,
    iv: encrypted.iv, tag: encrypted.tag, compression: "gzip",
    data: encrypted.ciphertext.subarray(index * NODE_SYNC_CHUNK_BYTES, (index + 1) * NODE_SYNC_CHUNK_BYTES).toString("base64")
  }));
  if (frames.reduce((bytes, frame) => bytes + frameBytes(frame), 0) > VOICE_DICTIONARY_PEER_FRAME_BYTES) {
    throw new Error("Voice dictionary peer frames exceed their size limit.");
  }
  return frames;
}

export function decodeVoiceDictionaryPeerMessage(options: VoiceDictionaryPeerDecodeOptions): VoiceDictionaryPeerMessage {
  if (!(options.ciphertext instanceof Uint8Array) || options.ciphertext.byteLength > VOICE_DICTIONARY_PEER_CIPHER_BYTES ||
    !isValidNodeSyncPrivateKey(options.ownPrivateKey) || !isValidNodeSyncPublicKey(options.expectedPeerPublicKey) ||
    !isNodeId(options.sourceNodeId) || !isNodeId(options.destinationNodeId) ||
    !isTransferId(options.transferId) || !Number.isSafeInteger(options.totalChunks) ||
    options.totalChunks < 1 || options.totalChunks > VOICE_DICTIONARY_PEER_MAX_CHUNKS ||
    !isCanonicalNodeSyncBase64(options.iv, 12) || !isCanonicalNodeSyncBase64(options.tag, 16)) {
    throw new Error("Voice dictionary peer decode options are invalid.");
  }
  const compressed = decryptNodeSyncBytes("voice-dictionary", {
    iv: options.iv, tag: options.tag, ciphertext: Buffer.from(options.ciphertext)
  }, options.ownPrivateKey, options.expectedPeerPublicKey, {
    sourceNodeId: options.sourceNodeId, destinationNodeId: options.destinationNodeId,
    transferId: options.transferId, totalChunks: options.totalChunks
  });
  const json = gunzipSync(compressed, { maxOutputLength: VOICE_DICTIONARY_PEER_FRAME_BYTES });
  let message: unknown;
  try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)); } catch { throw new Error("Voice dictionary peer payload is not valid JSON."); }
  if (!isVoiceDictionaryPeerMessage(message)) throw new Error("Voice dictionary peer payload is invalid.");
  return message;
}

export function isVoiceDictionaryPeerMessage(value: unknown): value is VoiceDictionaryPeerMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, "frameVersion") && Object.hasOwn(record, "state") && record.frameVersion === 1 &&
    Object.keys(record).every((key) => ["frameVersion", "state", "requestReply"].includes(key)) &&
    (!Object.hasOwn(record, "requestReply") || typeof record.requestReply === "boolean") && isValidSyncState(record.state);
}

interface PendingTransfer {
  readonly senderPublicKey: string;
  readonly destinationNodeId: string;
  readonly ownPrivateKey: string;
  readonly total: number;
  readonly iv: string;
  readonly tag: string;
  readonly chunks: Map<number, Buffer>;
  lastActivityAt: number;
  cipherBytes: number;
  frameBytes: number;
}

export class VoiceDictionaryPeerWireDecoder {
  readonly #pending = new Map<string, PendingTransfer>();
  readonly #recent = new Map<string, number>();
  readonly #decoding = new Map<string, symbol>();
  #generation = 0;
  #abortController = new AbortController();

  constructor(private readonly codec: VoiceDictionaryPeerCodec) {}

  async accept(options: {
    readonly sourceNodeId: string;
    readonly destinationNodeId: string;
    readonly ownPrivateKey: string;
    readonly expectedPeerPublicKey: string;
    readonly frame: NodeSyncCipherChunkFrame;
    readonly delivery: NodeSyncDeliveryContext;
    readonly now?: number;
  }): Promise<VoiceDictionaryPeerMessage | null> {
    if (!options.delivery.isCurrent() || options.delivery.signal.aborted) return null;
    const frame = options.frame;
    if (!isNodeSyncCipherChunkFrame(frame) || frame.total > VOICE_DICTIONARY_PEER_MAX_CHUNKS ||
      !isNodeId(options.sourceNodeId) || !isNodeId(options.destinationNodeId) ||
      !isValidNodeSyncPrivateKey(options.ownPrivateKey) || frame.senderPublicKey !== options.expectedPeerPublicKey) {
      throw new Error("Voice dictionary peer frame or authority is invalid.");
    }
    const now = options.now ?? Date.now();
    this.#prune(now);
    const key = `${options.sourceNodeId}\u0000${frame.transferId}`;
    if (this.#decoding.has(key) || this.#recent.has(key)) return null;
    const chunk = decodeNodeSyncBase64(frame.data);
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      const peerPrefix = `${options.sourceNodeId}\u0000`;
      const activeForPeer = [...this.#pending.keys(), ...this.#decoding.keys()].filter((id) => id.startsWith(peerPrefix)).length;
      if (activeForPeer >= MAX_ACTIVE_TRANSFERS_PER_PEER || this.#pending.size + this.#decoding.size >= MAX_ACTIVE_TRANSFERS) {
        throw new Error("Voice dictionary peer transfer capacity is exhausted.");
      }
      pending = { senderPublicKey: frame.senderPublicKey, destinationNodeId: options.destinationNodeId,
        ownPrivateKey: options.ownPrivateKey, total: frame.total, iv: frame.iv, tag: frame.tag,
        chunks: new Map(), cipherBytes: 0, frameBytes: 0, lastActivityAt: now };
      this.#pending.set(key, pending);
    } else if (pending.senderPublicKey !== frame.senderPublicKey || pending.destinationNodeId !== options.destinationNodeId ||
      pending.ownPrivateKey !== options.ownPrivateKey || pending.total !== frame.total || pending.iv !== frame.iv || pending.tag !== frame.tag) {
      this.#pending.delete(key);
      throw new Error("Voice dictionary peer transfer metadata or authority changed.");
    }
    const previous = pending.chunks.get(frame.index);
    if (previous !== undefined) {
      if (!previous.equals(chunk)) {
        this.#pending.delete(key);
        throw new Error("Voice dictionary peer duplicate chunk changed.");
      }
      return null;
    }
    pending.chunks.set(frame.index, chunk);
    pending.cipherBytes += chunk.byteLength;
    pending.frameBytes += frameBytes(frame);
    pending.lastActivityAt = now;
    if (pending.cipherBytes > VOICE_DICTIONARY_PEER_CIPHER_BYTES || pending.frameBytes > VOICE_DICTIONARY_PEER_FRAME_BYTES) {
      this.#pending.delete(key);
      throw new Error("Voice dictionary peer transfer exceeds its size limit.");
    }
    if (pending.chunks.size !== pending.total) return null;
    this.#pending.delete(key);
    this.#remember(key, now);
    const ciphertext = Buffer.concat(Array.from({ length: pending.total }, (_, index) => pending.chunks.get(index)!));
    const token = Symbol();
    const generation = this.#generation;
    this.#decoding.set(key, token);
    const signal = AbortSignal.any([this.#abortController.signal, options.delivery.signal]);
    try {
      const message = await this.codec.decode({ ciphertext, iv: pending.iv, tag: pending.tag,
        ownPrivateKey: options.ownPrivateKey, expectedPeerPublicKey: options.expectedPeerPublicKey,
        sourceNodeId: options.sourceNodeId, destinationNodeId: options.destinationNodeId,
        transferId: frame.transferId, totalChunks: frame.total }, signal);
      if (generation !== this.#generation || signal.aborted || !options.delivery.isCurrent()) return null;
      if (!isVoiceDictionaryPeerMessage(message)) throw new Error("Voice dictionary peer codec returned an invalid payload.");
      return message;
    } finally {
      if (this.#decoding.get(key) === token) this.#decoding.delete(key);
    }
  }

  reset(): void {
    this.#generation += 1;
    this.#abortController.abort(new Error("Voice dictionary peer authority was retired."));
    this.#abortController = new AbortController();
    this.#pending.clear();
    this.#decoding.clear();
    this.#recent.clear();
  }

  #remember(key: string, now: number): void {
    if (this.#recent.size >= MAX_RECENT_TRANSFERS) this.#recent.delete(this.#recent.keys().next().value!);
    this.#recent.set(key, now);
  }

  #prune(now: number): void {
    for (const [key, pending] of this.#pending) if (now - pending.lastActivityAt > TRANSFER_TTL_MILLISECONDS) this.#pending.delete(key);
    for (const [key, at] of this.#recent) if (now - at > TRANSFER_TTL_MILLISECONDS) this.#recent.delete(key);
  }
}

function frameBytes(frame: NodeSyncCipherChunkFrame): number { return Buffer.byteLength(JSON.stringify(frame), "utf8"); }
function isNodeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value); }
function isTransferId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
