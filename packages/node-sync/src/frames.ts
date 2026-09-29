import { isValidNodeSyncPublicKey } from "./crypto.js";

export const NODE_SYNC_CHUNK_BYTES = 256 * 1024;
export const NODE_SYNC_MAX_CHUNKS = 128;

/** Authenticated encrypted transport envelope, independent of the document owner. */
export interface NodeSyncCipherChunkFrame {
  readonly version: 1;
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

export function isNodeSyncCipherChunkFrame(value: unknown): value is NodeSyncCipherChunkFrame {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const keys = ["version", "type", "senderPublicKey", "transferId", "index", "total", "iv", "tag", "compression", "data"];
  if (Object.keys(frame).length !== keys.length || !keys.every((key) => Object.hasOwn(frame, key))
    || frame.version !== 1 || frame.type !== "cipher-chunk" || !isValidNodeSyncPublicKey(frame.senderPublicKey)
    || typeof frame.transferId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(frame.transferId)
    || typeof frame.index !== "number" || !Number.isSafeInteger(frame.index) || frame.index < 0
    || typeof frame.total !== "number" || !Number.isSafeInteger(frame.total) || frame.total < 1
    || frame.total > NODE_SYNC_MAX_CHUNKS || frame.index >= frame.total
    || !isCanonicalNodeSyncBase64(frame.iv, 12) || !isCanonicalNodeSyncBase64(frame.tag, 16)
    || frame.compression !== "gzip" || typeof frame.data !== "string"
    || frame.data.length > Math.ceil(NODE_SYNC_CHUNK_BYTES / 3) * 4 + 4) return false;
  try { return decodeNodeSyncBase64(frame.data).byteLength <= NODE_SYNC_CHUNK_BYTES; } catch { return false; }
}

export function decodeNodeSyncBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("Node sync encoding is invalid.");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("Node sync encoding is not canonical.");
  return decoded;
}

export function isCanonicalNodeSyncBase64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string") return false;
  try { return decodeNodeSyncBase64(value).byteLength === bytes; } catch { return false; }
}
