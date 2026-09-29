import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject
} from "node:crypto";

export type NodeSyncPurpose = "contacts" | "voice-dictionary";

export function nodeSyncDomain(purpose: NodeSyncPurpose): { readonly encryption: string; readonly lanAuth: string; readonly magic: string; readonly multicastPort: number } {
  if (purpose !== "contacts" && purpose !== "voice-dictionary") throw new TypeError("Node sync purpose is invalid.");
  return { encryption: `joko:${purpose}-device-sync:v1`, lanAuth: `joko:${purpose}-device-sync:lan-auth:v1`,
    magic: `joko-${purpose}-sync`, multicastPort: purpose === "contacts" ? 53_547 : 53_548 };
}
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface NodeSyncExportedIdentity {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface NodeSyncEncryptedBytes {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: Buffer;
}

export interface NodeSyncEncryptionContext {
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly transferId: string;
  readonly totalChunks: number;
}

export interface NodeSyncLanAuthContext {
  readonly kind: "request" | "ack";
  readonly sourceNodeId: string;
  readonly destinationNodeId: string;
  readonly challenge: string;
  readonly senderPublicKey: string;
  readonly transferId: string;
  readonly index: number;
  readonly total: number;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export function generateNodeSyncIdentity(): NodeSyncExportedIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { publicKey: exportPublicKey(publicKey), privateKey: exportPrivateKey(privateKey) };
}

export function nodeSyncPublicKeyFromPrivate(privateKey: string): string {
  return exportPublicKey(createPublicKey(importPrivateKey(privateKey)));
}

export function isValidNodeSyncPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 256) return false;
  try {
    const key = importPublicKey(value);
    return key.asymmetricKeyType === "x25519" && exportPublicKey(key) === value;
  } catch {
    return false;
  }
}

export function isValidNodeSyncPrivateKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 256) return false;
  try {
    const key = importPrivateKey(value);
    return key.asymmetricKeyType === "x25519" && exportPrivateKey(key) === value;
  } catch {
    return false;
  }
}

export function encryptNodeSyncBytes(
  purpose: NodeSyncPurpose,
  plaintext: Uint8Array,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: NodeSyncEncryptionContext
): NodeSyncEncryptedBytes {
  validateEncryptionContext(context);
  const key = deriveEncryptionKey(purpose, ownPrivateKey, peerPublicKey, context);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildEncryptionAad(purpose, context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext };
}

export function decryptNodeSyncBytes(
  purpose: NodeSyncPurpose,
  encrypted: NodeSyncEncryptedBytes,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: NodeSyncEncryptionContext
): Buffer {
  validateEncryptionContext(context);
  const iv = decodeExactBase64(encrypted.iv, IV_BYTES, "Node sync IV");
  const tag = decodeExactBase64(encrypted.tag, TAG_BYTES, "Node sync tag");
  const key = deriveEncryptionKey(purpose, ownPrivateKey, peerPublicKey, context);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(buildEncryptionAad(purpose, context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

export function createNodeSyncLanProof(
  purpose: NodeSyncPurpose,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: NodeSyncLanAuthContext
): string {
  validateLanContext(context);
  const key = deriveSharedKey(ownPrivateKey, peerPublicKey, nodeSyncDomain(purpose).lanAuth);
  return createHmac("sha256", key).update(buildLanAuthMessage(purpose, context)).digest("base64");
}

export function verifyNodeSyncLanProof(
  purpose: NodeSyncPurpose,
  proof: string,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: NodeSyncLanAuthContext
): boolean {
  try {
    const supplied = decodeExactBase64(proof, 32, "Node sync LAN proof");
    const expected = Buffer.from(createNodeSyncLanProof(purpose, ownPrivateKey, peerPublicKey, context), "base64");
    return timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function deriveEncryptionKey(
  purpose: NodeSyncPurpose,
  ownPrivateKey: string,
  peerPublicKey: string,
  context: NodeSyncEncryptionContext
): Buffer {
  const nodePair = [context.sourceNodeId, context.destinationNodeId].sort().join("\u0000");
  return deriveSharedKey(ownPrivateKey, peerPublicKey, `${nodeSyncDomain(purpose).encryption}\u0000${nodePair}`);
}

function deriveSharedKey(ownPrivateKey: string, peerPublicKey: string, info: string): Buffer {
  const shared = diffieHellman({ privateKey: importPrivateKey(ownPrivateKey), publicKey: importPublicKey(peerPublicKey) });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from(info, "utf8"), 32));
}

function buildEncryptionAad(purpose: NodeSyncPurpose, context: NodeSyncEncryptionContext): Buffer {
  return Buffer.from([
    nodeSyncDomain(purpose).encryption,
    context.sourceNodeId,
    context.destinationNodeId,
    context.transferId,
    String(context.totalChunks)
  ].join("\u0000"), "utf8");
}

function buildLanAuthMessage(purpose: NodeSyncPurpose, context: NodeSyncLanAuthContext): Buffer {
  return Buffer.from([
    nodeSyncDomain(purpose).lanAuth,
    context.kind,
    context.sourceNodeId,
    context.destinationNodeId,
    context.challenge,
    context.senderPublicKey,
    context.transferId,
    String(context.index),
    String(context.total),
    context.iv,
    context.tag,
    context.data
  ].join("\u0000"), "utf8");
}

function validateEncryptionContext(context: NodeSyncEncryptionContext): void {
  if (!isNodeId(context.sourceNodeId) || !isNodeId(context.destinationNodeId) ||
    !isTransferId(context.transferId) || !Number.isSafeInteger(context.totalChunks) ||
    context.totalChunks < 1 || context.totalChunks > 128) {
    throw new Error("Node sync encryption context is invalid.");
  }
}

function validateLanContext(context: NodeSyncLanAuthContext): void {
  if ((context.kind !== "request" && context.kind !== "ack") || !isNodeId(context.sourceNodeId) ||
    !isNodeId(context.destinationNodeId) || !isTransferId(context.transferId) ||
    !isValidNodeSyncPublicKey(context.senderPublicKey) || !isCanonicalBase64(context.challenge, 24) ||
    !Number.isSafeInteger(context.index) || context.index < 0 || !Number.isSafeInteger(context.total) ||
    context.total < 1 || context.total > 128 || context.index >= context.total ||
    !isCanonicalBase64(context.iv, IV_BYTES) || !isCanonicalBase64(context.tag, TAG_BYTES) ||
    typeof context.data !== "string" || context.data.length > 400_000) {
    throw new Error("Node sync LAN authentication context is invalid.");
  }
}

function importPublicKey(value: string): KeyObject {
  const key = createPublicKey({ key: decodeBase64(value, "Node sync public key"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("Node sync public key is not X25519.");
  return key;
}

function importPrivateKey(value: string): KeyObject {
  const key = createPrivateKey({ key: decodeBase64(value, "Node sync private key"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "x25519") throw new Error("Node sync private key is not X25519.");
  return key;
}

function exportPublicKey(key: KeyObject): string {
  return (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64");
}

function exportPrivateKey(key: KeyObject): string {
  return (key.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64");
}

function decodeBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error(`${label} is invalid.`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.toString("base64") !== value) throw new Error(`${label} is invalid.`);
  return decoded;
}

function decodeExactBase64(value: string, length: number, label: string): Buffer {
  const decoded = decodeBase64(value, label);
  if (decoded.byteLength !== length) throw new Error(`${label} has an invalid length.`);
  return decoded;
}

function isCanonicalBase64(value: unknown, length: number): value is string {
  if (typeof value !== "string") return false;
  try { return decodeExactBase64(value, length, "value").byteLength === length; } catch { return false; }
}

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isTransferId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
