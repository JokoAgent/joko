import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const PACKAGE_MAGIC = Buffer.from("JOKOSESSION\u0001", "ascii");
const FORMAT_VERSION = 1;
const HEADER_LIMIT_BYTES = 16 * 1024;
const DEFAULT_CONTENT_LIMIT_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_COUNT = 10_000;
const MAX_ENTRY_PATH_LENGTH = 512;
const MAX_PASSWORD_BYTES = 1_024;
const KDF_COST = 32_768;
const KDF_BLOCK_SIZE = 8;
const KDF_PARALLELISM = 1;
const KDF_MAX_MEMORY = 64 * 1024 * 1024;

export type PortableSessionFidelity = "full" | "partial" | "product_only";
export type PortableSessionEntryKind = "native_history" | "artifact" | "projection" | "collaboration";

export interface PortableSessionEntry {
  readonly path: string;
  readonly kind: PortableSessionEntryKind;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface PortableSessionWorker {
  readonly id: string;
  readonly title: string;
  readonly role?: string;
  readonly label?: string;
  readonly state: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled";
  readonly focused: boolean;
  readonly backendCapability: string;
  readonly nativeHistoryEntry?: string;
}

export interface PortableSessionManifest {
  readonly formatVersion: 1;
  readonly exportedAt: string;
  readonly applicationVersion: string;
  readonly title: string;
  readonly workspaceKind: "dialogue" | "project";
  readonly backendCapability: string;
  readonly fidelity: PortableSessionFidelity;
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly nativeHistoryEntry?: string;
  readonly workers?: readonly PortableSessionWorker[];
}

export const MAXIMUM_PORTABLE_SESSION_WORKERS = 256;

export interface PortableSessionPackage {
  readonly manifest: PortableSessionManifest;
  readonly entries: readonly PortableSessionEntry[];
}

export interface EncodePortableSessionOptions {
  readonly password?: string;
  readonly contentLimitBytes?: number;
}

export interface DecodePortableSessionOptions {
  readonly password?: string;
  readonly contentLimitBytes?: number;
}

interface SerializedEntry {
  readonly path: string;
  readonly kind: PortableSessionEntryKind;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly data: string;
}

interface SerializedPackage {
  readonly manifest: PortableSessionManifest;
  readonly entries: readonly SerializedEntry[];
}

interface PlainHeader {
  readonly formatVersion: 1;
  readonly encoding: "gzip-json";
  readonly cipher: "none";
  readonly payloadBytes: number;
  readonly payloadSha256: string;
}

interface EncryptedHeader {
  readonly formatVersion: 1;
  readonly encoding: "gzip-json";
  readonly cipher: "aes-256-gcm";
  readonly kdf: "scrypt-32768-8-1";
  readonly salt: string;
  readonly nonce: string;
  readonly tag: string;
  readonly payloadBytes: number;
  readonly payloadSha256: string;
}

type PackageHeader = PlainHeader | EncryptedHeader;

export class PortableSessionPackageError extends Error {
  constructor(
    readonly code:
      | "INVALID_PACKAGE"
      | "UNSUPPORTED_VERSION"
      | "PASSWORD_REQUIRED"
      | "DECRYPTION_FAILED"
      | "CONTENT_LIMIT_EXCEEDED",
    message: string
  ) {
    super(message);
    this.name = "PortableSessionPackageError";
  }
}

export function createPortableSessionManifest(
  input: Omit<PortableSessionManifest, "formatVersion">
): PortableSessionManifest {
  const manifest: PortableSessionManifest = {
    formatVersion: FORMAT_VERSION,
    ...input
  };
  validateManifest(manifest);
  return manifest;
}

export function encodePortableSessionPackage(
  value: PortableSessionPackage,
  options: EncodePortableSessionOptions = {}
): Uint8Array {
  const contentLimit = normalizeContentLimit(options.contentLimitBytes);
  validateManifest(value.manifest);
  validateEntryReferences(value.manifest, value.entries);
  if (value.entries.length > MAX_ENTRY_COUNT) {
    throw invalid(`A portable Session package cannot contain more than ${MAX_ENTRY_COUNT} entries.`);
  }

  let totalEntryBytes = 0;
  const paths = new Set<string>();
  const entries = value.entries.map((entry): SerializedEntry => {
    const path = validateEntryPath(entry.path);
    if (paths.has(path)) throw invalid(`Portable Session entry is duplicated: ${path}`);
    paths.add(path);
    validateEntryKind(entry.kind);
    const mediaType = boundedText(entry.mediaType, "entry media type", 256);
    const bytes = Buffer.from(entry.bytes);
    totalEntryBytes += bytes.byteLength;
    if (!Number.isSafeInteger(totalEntryBytes) || totalEntryBytes > contentLimit) {
      throw contentLimitExceeded(contentLimit);
    }
    return {
      path,
      kind: entry.kind,
      mediaType,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      data: bytes.toString("base64")
    };
  });
  validateEntryReferences(value.manifest, entries);

  const serialized = Buffer.from(JSON.stringify({ manifest: value.manifest, entries } satisfies SerializedPackage), "utf8");
  if (serialized.byteLength > contentLimit) throw contentLimitExceeded(contentLimit);
  const compressed = gzipSync(serialized, { level: 9 });
  if (compressed.byteLength > contentLimit) throw contentLimitExceeded(contentLimit);

  const password = normalizePassword(options.password);
  let payload: Buffer;
  let header: PackageHeader;
  if (password === undefined) {
    payload = compressed;
    header = {
      formatVersion: FORMAT_VERSION,
      encoding: "gzip-json",
      cipher: "none",
      payloadBytes: payload.byteLength,
      payloadSha256: sha256(payload)
    };
  } else {
    const salt = randomBytes(16);
    const nonce = randomBytes(12);
    const key = deriveKey(password, salt);
    const authenticated = encryptedAuthenticatedFields(salt, nonce, compressed.byteLength, sha256(compressed));
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(authenticated), "utf8"));
    payload = Buffer.concat([cipher.update(compressed), cipher.final()]);
    header = {
      ...authenticated,
      tag: cipher.getAuthTag().toString("base64")
    };
  }

  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.byteLength > HEADER_LIMIT_BYTES) throw invalid("Portable Session package header is too large.");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(headerBytes.byteLength, 0);
  return Buffer.concat([PACKAGE_MAGIC, length, headerBytes, payload]);
}

export function decodePortableSessionPackage(
  encoded: Uint8Array,
  options: DecodePortableSessionOptions = {}
): PortableSessionPackage {
  const contentLimit = normalizeContentLimit(options.contentLimitBytes);
  const packageBytes = Buffer.from(encoded);
  const minimumBytes = PACKAGE_MAGIC.byteLength + 4 + 2;
  if (packageBytes.byteLength < minimumBytes || !safeEqual(packageBytes.subarray(0, PACKAGE_MAGIC.byteLength), PACKAGE_MAGIC)) {
    throw invalid("Portable Session package magic is invalid.");
  }
  const headerLength = packageBytes.readUInt32BE(PACKAGE_MAGIC.byteLength);
  if (headerLength < 2 || headerLength > HEADER_LIMIT_BYTES) throw invalid("Portable Session package header length is invalid.");
  const headerStart = PACKAGE_MAGIC.byteLength + 4;
  const payloadStart = headerStart + headerLength;
  if (payloadStart > packageBytes.byteLength) throw invalid("Portable Session package is truncated.");
  const header = parseHeader(packageBytes.subarray(headerStart, payloadStart));
  const payload = packageBytes.subarray(payloadStart);
  if (header.payloadBytes !== payload.byteLength || payload.byteLength > contentLimit) {
    if (payload.byteLength > contentLimit) throw contentLimitExceeded(contentLimit);
    throw invalid("Portable Session payload length does not match its header.");
  }

  let compressed: Buffer;
  if (header.cipher === "none") {
    if (!safeDigest(payload, header.payloadSha256)) throw invalid("Portable Session payload integrity check failed.");
    compressed = payload;
  } else {
    const password = normalizePassword(options.password);
    if (password === undefined) {
      throw new PortableSessionPackageError("PASSWORD_REQUIRED", "This portable Session package requires a password.");
    }
    const salt = decodeFixedBase64(header.salt, 16, "salt");
    const nonce = decodeFixedBase64(header.nonce, 12, "nonce");
    const tag = decodeFixedBase64(header.tag, 16, "authentication tag");
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, salt), nonce);
      decipher.setAAD(Buffer.from(JSON.stringify(encryptedAuthenticatedFields(salt, nonce, header.payloadBytes, header.payloadSha256)), "utf8"));
      decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(payload), decipher.final()]);
    } catch {
      throw new PortableSessionPackageError(
        "DECRYPTION_FAILED",
        "The portable Session package password is incorrect or the package was modified."
      );
    }
    if (!safeDigest(compressed, header.payloadSha256)) {
      throw new PortableSessionPackageError("DECRYPTION_FAILED", "The portable Session package failed its integrity check.");
    }
  }

  let json: Buffer;
  try {
    json = gunzipSync(compressed, { maxOutputLength: contentLimit });
  } catch (error) {
    if (isOutputLimitError(error)) throw contentLimitExceeded(contentLimit);
    throw invalid("Portable Session payload could not be decompressed.");
  }
  if (json.byteLength > contentLimit) throw contentLimitExceeded(contentLimit);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString("utf8"));
  } catch {
    throw invalid("Portable Session payload is not valid JSON.");
  }
  return parseSerializedPackage(parsed, contentLimit);
}

export function isEncryptedPortableSessionPackage(encoded: Uint8Array): boolean {
  const packageBytes = Buffer.from(encoded);
  if (packageBytes.byteLength < PACKAGE_MAGIC.byteLength + 6) return false;
  if (!safeEqual(packageBytes.subarray(0, PACKAGE_MAGIC.byteLength), PACKAGE_MAGIC)) return false;
  const headerLength = packageBytes.readUInt32BE(PACKAGE_MAGIC.byteLength);
  if (headerLength < 2 || headerLength > HEADER_LIMIT_BYTES) return false;
  const start = PACKAGE_MAGIC.byteLength + 4;
  if (start + headerLength > packageBytes.byteLength) return false;
  try {
    return parseHeader(packageBytes.subarray(start, start + headerLength)).cipher === "aes-256-gcm";
  } catch {
    return false;
  }
}

function parseSerializedPackage(value: unknown, contentLimit: number): PortableSessionPackage {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw invalid("Portable Session payload shape is invalid.");
  validateManifest(value.manifest);
  if (value.entries.length > MAX_ENTRY_COUNT) throw invalid("Portable Session package contains too many entries.");
  const paths = new Set<string>();
  let total = 0;
  const entries = value.entries.map((candidate): PortableSessionEntry => {
    if (!isRecord(candidate)) throw invalid("Portable Session entry shape is invalid.");
    const path = validateEntryPath(candidate.path);
    if (paths.has(path)) throw invalid(`Portable Session entry is duplicated: ${path}`);
    paths.add(path);
    validateEntryKind(candidate.kind);
    const mediaType = boundedText(candidate.mediaType, "entry media type", 256);
    if (!Number.isSafeInteger(candidate.byteLength) || (candidate.byteLength as number) < 0) {
      throw invalid("Portable Session entry byte length is invalid.");
    }
    if (typeof candidate.data !== "string" || !isCanonicalBase64(candidate.data)) {
      throw invalid("Portable Session entry data is invalid.");
    }
    const bytes = Buffer.from(candidate.data, "base64");
    if (bytes.byteLength !== candidate.byteLength) throw invalid("Portable Session entry byte length does not match its data.");
    if (typeof candidate.sha256 !== "string" || !safeDigest(bytes, candidate.sha256)) {
      throw invalid("Portable Session entry integrity check failed.");
    }
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > contentLimit) throw contentLimitExceeded(contentLimit);
    return { path, kind: candidate.kind, mediaType, bytes };
  });
  const manifest = value.manifest as unknown as PortableSessionManifest;
  validateEntryReferences(manifest, entries);
  return { manifest, entries };
}

function parseHeader(bytes: Uint8Array): PackageHeader {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw invalid("Portable Session package header is not valid JSON.");
  }
  if (!isRecord(value)) throw invalid("Portable Session package header shape is invalid.");
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new PortableSessionPackageError("UNSUPPORTED_VERSION", "Portable Session package version is not supported.");
  }
  if (value.encoding !== "gzip-json") throw invalid("Portable Session package encoding is invalid.");
  if (!Number.isSafeInteger(value.payloadBytes) || (value.payloadBytes as number) < 0) {
    throw invalid("Portable Session payload length is invalid.");
  }
  validateDigest(value.payloadSha256, "payload digest");
  if (value.cipher === "none") {
    return {
      formatVersion: FORMAT_VERSION,
      encoding: "gzip-json",
      cipher: "none",
      payloadBytes: value.payloadBytes as number,
      payloadSha256: value.payloadSha256 as string
    };
  }
  if (value.cipher !== "aes-256-gcm" || value.kdf !== "scrypt-32768-8-1") {
    throw invalid("Portable Session package encryption settings are invalid.");
  }
  decodeFixedBase64(value.salt, 16, "salt");
  decodeFixedBase64(value.nonce, 12, "nonce");
  decodeFixedBase64(value.tag, 16, "authentication tag");
  return {
    formatVersion: FORMAT_VERSION,
    encoding: "gzip-json",
    cipher: "aes-256-gcm",
    kdf: "scrypt-32768-8-1",
    salt: value.salt as string,
    nonce: value.nonce as string,
    tag: value.tag as string,
    payloadBytes: value.payloadBytes as number,
    payloadSha256: value.payloadSha256 as string
  };
}

function encryptedAuthenticatedFields(
  salt: Uint8Array,
  nonce: Uint8Array,
  payloadBytes: number,
  payloadSha256: string
): Omit<EncryptedHeader, "tag"> {
  return {
    formatVersion: FORMAT_VERSION,
    encoding: "gzip-json",
    cipher: "aes-256-gcm",
    kdf: "scrypt-32768-8-1",
    salt: Buffer.from(salt).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
    payloadBytes,
    payloadSha256
  };
}

function validateManifest(value: unknown): asserts value is PortableSessionManifest {
  if (!isRecord(value)) throw invalid("Portable Session manifest shape is invalid.");
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new PortableSessionPackageError("UNSUPPORTED_VERSION", "Portable Session manifest version is not supported.");
  }
  const exportedAt = boundedText(value.exportedAt, "export time", 64);
  if (!Number.isFinite(Date.parse(exportedAt))) throw invalid("Portable Session export time is invalid.");
  boundedText(value.applicationVersion, "application version", 128);
  boundedText(value.title, "Session title", 512, true);
  if (value.workspaceKind !== "dialogue" && value.workspaceKind !== "project") {
    throw invalid("Portable Session workspace kind is invalid.");
  }
  boundedText(value.backendCapability, "Backend capability", 256);
  if (value.fidelity !== "full" && value.fidelity !== "partial" && value.fidelity !== "product_only") {
    throw invalid("Portable Session fidelity is invalid.");
  }
  nonNegativeInteger(value.messageCount, "message count");
  nonNegativeInteger(value.mediaCount, "media count");
  if (value.nativeHistoryEntry !== undefined) validateEntryPath(value.nativeHistoryEntry);
  if (value.workers !== undefined) {
    if (!Array.isArray(value.workers) || value.workers.length > MAXIMUM_PORTABLE_SESSION_WORKERS) throw invalid("Portable Session Worker list is invalid.");
    const ids = new Set<string>();
    for (const worker of value.workers) {
      if (!isRecord(worker)) throw invalid("Portable Session Worker shape is invalid.");
      const id = boundedText(worker.id, "Worker ID", 256);
      if (ids.has(id)) throw invalid("Portable Session Worker ID is duplicated.");
      ids.add(id);
      boundedText(worker.title, "Worker title", 512, true);
      if (worker.role !== undefined) boundedText(worker.role, "Worker role", 256, true);
      if (worker.label !== undefined) boundedText(worker.label, "Worker label", 256, true);
      if (!["idle", "running", "waiting", "completed", "failed", "cancelled"].includes(String(worker.state))) {
        throw invalid("Portable Session Worker state is invalid.");
      }
      if (typeof worker.focused !== "boolean") throw invalid("Portable Session Worker focus state is invalid.");
      boundedText(worker.backendCapability, "Worker Backend capability", 256);
      if (worker.nativeHistoryEntry !== undefined) validateEntryPath(worker.nativeHistoryEntry);
    }
    if (value.workers.filter((worker) => worker.focused).length > 1) {
      throw invalid("Portable Session package cannot focus more than one Worker.");
    }
  }
}

function validateEntryReferences(
  manifest: PortableSessionManifest,
  entries: readonly Pick<PortableSessionEntry, "path">[]
): void {
  const paths = new Set(entries.map((entry) => validateEntryPath(entry.path)));
  if (manifest.nativeHistoryEntry !== undefined && !paths.has(manifest.nativeHistoryEntry)) {
    throw invalid("Portable Session native history entry is missing.");
  }
  for (const worker of manifest.workers ?? []) {
    if (worker.nativeHistoryEntry !== undefined && !paths.has(worker.nativeHistoryEntry)) {
      throw invalid("Portable Session Worker native history entry is missing.");
    }
  }
}

function validateEntryPath(value: unknown): string {
  const path = boundedText(value, "entry path", MAX_ENTRY_PATH_LENGTH);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw invalid("Portable Session entry path is unsafe.");
  }
  return path;
}

function validateEntryKind(value: unknown): asserts value is PortableSessionEntryKind {
  if (value !== "native_history" && value !== "artifact" && value !== "projection" && value !== "collaboration") {
    throw invalid("Portable Session entry kind is invalid.");
  }
}

function normalizePassword(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("Portable Session password is invalid.");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PASSWORD_BYTES || value.includes("\u0000")) {
    throw invalid("Portable Session password must be non-empty and at most 1,024 bytes.");
  }
  return bytes;
}

function normalizeContentLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_CONTENT_LIMIT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_CONTENT_LIMIT_BYTES) {
    throw invalid(`Portable Session content limit must be an integer from 1 through ${DEFAULT_CONTENT_LIMIT_BYTES}.`);
  }
  return limit;
}

function deriveKey(password: Uint8Array, salt: Uint8Array): Buffer {
  return scryptSync(password, salt, 32, {
    N: KDF_COST,
    r: KDF_BLOCK_SIZE,
    p: KDF_PARALLELISM,
    maxmem: KDF_MAX_MEMORY
  });
}

function decodeFixedBase64(value: unknown, byteLength: number, label: string): Buffer {
  if (typeof value !== "string" || !isCanonicalBase64(value)) throw invalid(`Portable Session ${label} is invalid.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength !== byteLength) throw invalid(`Portable Session ${label} length is invalid.`);
  return bytes;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function safeDigest(bytes: Uint8Array, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;
  return safeEqual(Buffer.from(sha256(bytes), "ascii"), Buffer.from(expected, "ascii"));
}

function validateDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw invalid(`Portable Session ${label} is invalid.`);
  }
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\u0000") || (!allowEmpty && value.trim().length === 0)) {
    throw invalid(`Portable Session ${label} is invalid.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`Portable Session ${label} is invalid.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutputLimitError(error: unknown): boolean {
  return error instanceof Error && /output length|buffer too large|larger than/i.test(error.message);
}

function invalid(message: string): PortableSessionPackageError {
  return new PortableSessionPackageError("INVALID_PACKAGE", message);
}

function contentLimitExceeded(limit: number): PortableSessionPackageError {
  return new PortableSessionPackageError(
    "CONTENT_LIMIT_EXCEEDED",
    `Portable Session package exceeds the ${limit}-byte content limit.`
  );
}
