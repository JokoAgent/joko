import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { normalizeMediaType } from "./workspace-files";

export interface MobilePdfPreviewLease {
  readonly leaseId: string;
  readonly profileId: string;
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: "application/pdf";
  readonly localByteSize: number;
  readonly sha256Hex: string;
}

export interface MobilePdfPreviewFileSnapshot {
  readonly uri: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface MobilePdfPreviewFileDriver {
  prepare(): Promise<void>;
  write(fileName: string, bytes: Uint8Array): Promise<MobilePdfPreviewFileSnapshot>;
  remove(snapshot: Pick<MobilePdfPreviewFileSnapshot, "uri" | "fileName">): Promise<void>;
}

export interface MobileInspectedPdfPreview {
  readonly mediaType: "application/pdf";
  readonly version: string;
  readonly startXref: number;
  readonly xrefKind: "table" | "stream";
}

type DigestBytes = (bytes: Uint8Array) => Promise<string>;

export class MobilePdfPreviewFiles {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: MobilePdfPreviewFileDriver = expoMobilePdfPreviewFileDriver,
    private readonly digestBytes: DigestBytes = sha256Hex
  ) {}

  async stage(
    profileId: string,
    leaseId: string,
    sourceName: string,
    mediaType: string,
    expectedSha256Hex: string,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<MobilePdfPreviewLease> {
    const exactProfileId = boundedIdentity(profileId, "profile");
    const exactLeaseId = boundedIdentity(leaseId, "preview lease");
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256Hex)) {
      throw new Error("The PDF preview SHA-256 identity is invalid.");
    }
    inspectMobilePdfPreviewBytes(bytes, mediaType, sourceName);
    const fileName = `preview-${exactLeaseId}.pdf`;
    return this.#exclusive(async () => {
      signal?.throwIfAborted();
      const digest = await this.digestBytes(bytes);
      signal?.throwIfAborted();
      if (digest !== expectedSha256Hex) {
        throw new Error("The PDF preview bytes do not match the authenticated SHA-256 identity.");
      }
      await this.driver.prepare();
      signal?.throwIfAborted();
      let snapshot: MobilePdfPreviewFileSnapshot | undefined;
      try {
        snapshot = await this.driver.write(fileName, bytes);
        signal?.throwIfAborted();
        assertSnapshot(snapshot, fileName, bytes.byteLength);
        if (!equalBytes(snapshot.bytes, bytes) || await this.digestBytes(snapshot.bytes) !== expectedSha256Hex) {
          throw new Error("The app-owned PDF preview file failed readback verification.");
        }
        signal?.throwIfAborted();
        return {
          leaseId: exactLeaseId,
          profileId: exactProfileId,
          uri: snapshot.uri,
          fileName,
          mediaType: "application/pdf",
          localByteSize: bytes.byteLength,
          sha256Hex: expectedSha256Hex
        };
      } catch (error) {
        if (snapshot) await this.driver.remove(snapshot).catch(() => undefined);
        throw error;
      }
    });
  }

  async remove(lease: MobilePdfPreviewLease): Promise<void> {
    const exact = assertLease(lease);
    await this.#exclusive(() => this.driver.remove(exact));
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function isMobilePdfPreviewMediaType(mediaType: string): boolean {
  return normalizeMediaType(mediaType) === "application/pdf";
}

export function inspectMobilePdfPreviewBytes(
  bytes: Uint8Array,
  mediaType: string,
  sourceName: string
): MobileInspectedPdfPreview {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 64
    || bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
    throw new Error("The PDF preview bytes exceed the safe mobile preview budget.");
  }
  if (normalizeMediaType(mediaType) !== "application/pdf") {
    throw new Error("The PDF preview requires the canonical application/pdf media type.");
  }
  if (sourceExtension(sourceName) !== "pdf") {
    throw new Error("The PDF preview file extension does not match its canonical media type.");
  }
  if (!asciiAt(bytes, 0, "%PDF-")) throw new Error("The PDF preview header is invalid.");
  const version = ascii(bytes, 5, 3);
  if (!/^1\.[0-7]$|^2\.0$/u.test(version) || !lineBreak(bytes[8])) {
    throw new Error("The PDF preview version header is invalid.");
  }

  const finalByte = lastNonWhitespace(bytes);
  const eofOffset = finalByte - 4;
  if (eofOffset < 0 || !asciiAt(bytes, eofOffset, "%%EOF")) {
    throw new Error("The PDF preview is missing its final EOF marker.");
  }
  const startXrefOffset = lastIndexAscii(bytes, "startxref", Math.max(0, eofOffset - 4_096), eofOffset);
  if (startXrefOffset < 0) throw new Error("The PDF preview is missing its final cross-reference pointer.");
  let cursor = startXrefOffset + 9;
  cursor = skipWhitespace(bytes, cursor, eofOffset);
  const numberStart = cursor;
  while (cursor < eofOffset && bytes[cursor]! >= 0x30 && bytes[cursor]! <= 0x39) cursor += 1;
  if (cursor === numberStart || cursor - numberStart > 15) {
    throw new Error("The PDF preview cross-reference pointer is invalid.");
  }
  const startXref = Number(ascii(bytes, numberStart, cursor - numberStart));
  if (!Number.isSafeInteger(startXref) || startXref <= 8 || startXref >= startXrefOffset) {
    throw new Error("The PDF preview cross-reference pointer is outside the document.");
  }
  cursor = skipWhitespace(bytes, cursor, eofOffset);
  if (cursor !== eofOffset) throw new Error("The PDF preview final cross-reference section is malformed.");

  const xrefKind = asciiAt(bytes, startXref, "xref") && tokenBoundary(bytes[startXref + 4])
    ? "table"
    : isXrefStream(bytes, startXref, startXrefOffset) ? "stream" : undefined;
  if (!xrefKind) throw new Error("The PDF preview cross-reference target is invalid.");
  if (xrefKind === "table" && indexAscii(bytes, "trailer", startXref + 4, startXrefOffset) < 0) {
    throw new Error("The PDF preview cross-reference table has no trailer.");
  }
  if (indexAscii(bytes, " obj", 8, startXrefOffset) < 0
    || indexAscii(bytes, "endobj", 8, startXrefOffset) < 0) {
    throw new Error("The PDF preview contains no complete indirect object.");
  }
  return { mediaType: "application/pdf", version, startXref, xrefKind };
}

function isXrefStream(bytes: Uint8Array, offset: number, maximum: number): boolean {
  let cursor = offset;
  const first = readUnsignedInteger(bytes, cursor, maximum);
  if (!first) return false;
  cursor = skipWhitespace(bytes, first.end, maximum);
  const generation = readUnsignedInteger(bytes, cursor, maximum);
  if (!generation) return false;
  cursor = skipWhitespace(bytes, generation.end, maximum);
  if (!asciiAt(bytes, cursor, "obj") || !tokenBoundary(bytes[cursor + 3])) return false;
  const dictionaryEnd = Math.min(maximum, cursor + 1_024);
  const type = indexAscii(bytes, "/Type", cursor + 3, dictionaryEnd);
  if (type < 0) return false;
  let value = skipWhitespace(bytes, type + 5, dictionaryEnd);
  if (bytes[value] === 0x2f) value += 1;
  return asciiAt(bytes, value, "XRef") && tokenBoundary(bytes[value + 4]);
}

function readUnsignedInteger(
  bytes: Uint8Array,
  offset: number,
  maximum: number
): { readonly value: number; readonly end: number } | undefined {
  let cursor = offset;
  while (cursor < maximum && bytes[cursor]! >= 0x30 && bytes[cursor]! <= 0x39) cursor += 1;
  if (cursor === offset || cursor - offset > 15) return undefined;
  const value = Number(ascii(bytes, offset, cursor - offset));
  return Number.isSafeInteger(value) ? { value, end: cursor } : undefined;
}

function sourceExtension(value: string): string {
  if (typeof value !== "string" || value.length < 5 || value.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  const leaf = value.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const match = /\.([A-Za-z0-9]{1,12})$/u.exec(leaf);
  return match?.[1]?.toLocaleLowerCase() ?? "";
}

function lastNonWhitespace(bytes: Uint8Array): number {
  let offset = bytes.byteLength - 1;
  while (offset >= 0 && whitespace(bytes[offset])) offset -= 1;
  return offset;
}

function skipWhitespace(bytes: Uint8Array, offset: number, maximum: number): number {
  while (offset < maximum && whitespace(bytes[offset])) offset += 1;
  return offset;
}

function whitespace(value: number | undefined): boolean {
  return value === 0 || value === 0x09 || value === 0x0a || value === 0x0c || value === 0x0d || value === 0x20;
}

function lineBreak(value: number | undefined): boolean {
  return value === 0x0a || value === 0x0d;
}

function tokenBoundary(value: number | undefined): boolean {
  return value === undefined || whitespace(value) || value === 0x2f || value === 0x3c || value === 0x3e
    || value === 0x5b || value === 0x5d || value === 0x28 || value === 0x29;
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.byteLength) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = 0; index < length && offset + index < bytes.byteLength; index += 1) {
    value += String.fromCharCode(bytes[offset + index]!);
  }
  return value;
}

function indexAscii(bytes: Uint8Array, expected: string, start: number, end: number): number {
  const maximum = Math.min(end, bytes.byteLength) - expected.length;
  for (let offset = Math.max(0, start); offset <= maximum; offset += 1) {
    if (asciiAt(bytes, offset, expected)) return offset;
  }
  return -1;
}

function lastIndexAscii(bytes: Uint8Array, expected: string, start: number, end: number): number {
  for (let offset = Math.min(end, bytes.byteLength - expected.length); offset >= Math.max(0, start); offset -= 1) {
    if (asciiAt(bytes, offset, expected)) return offset;
  }
  return -1;
}

function assertSnapshot(snapshot: MobilePdfPreviewFileSnapshot, fileName: string, byteSize: number): void {
  if (!snapshot || typeof snapshot !== "object" || snapshot.fileName !== fileName
    || typeof snapshot.uri !== "string" || !snapshot.uri.startsWith("file://")
    || /[\u0000-\u001f\u007f]/u.test(snapshot.uri) || snapshot.uri.length > 4_096
    || snapshot.byteSize !== byteSize || !(snapshot.bytes instanceof Uint8Array)
    || snapshot.bytes.byteLength !== byteSize) {
    throw new Error("The app-owned PDF preview file snapshot is invalid.");
  }
}

function assertLease(lease: MobilePdfPreviewLease): MobilePdfPreviewLease {
  if (!lease || lease.mediaType !== "application/pdf" || lease.fileName !== `preview-${lease.leaseId}.pdf`
    || !lease.uri.startsWith("file://") || !Number.isSafeInteger(lease.localByteSize)
    || lease.localByteSize < 64 || lease.localByteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || !/^[0-9a-f]{64}$/u.test(lease.sha256Hex)) {
    throw new Error("The PDF preview lease is invalid.");
  }
  boundedIdentity(lease.profileId, "profile");
  boundedIdentity(lease.leaseId, "preview lease");
  return lease;
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`The ${label} identity is invalid.`);
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  const value = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes).buffer));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const MOBILE_PDF_PREVIEW_ROOT_DIRECTORY = "joko-pdf-preview";

const expoMobilePdfPreviewFileDriver: MobilePdfPreviewFileDriver = {
  async prepare() {
    const { Directory, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_PDF_PREVIEW_ROOT_DIRECTORY);
    if (root.exists) root.delete();
    root.create({ idempotent: true, intermediates: true });
  },
  async write(fileName, bytes) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_PDF_PREVIEW_ROOT_DIRECTORY);
    root.create({ idempotent: true, intermediates: true });
    const file = new File(root, fileName);
    if (file.exists) throw new Error("The PDF preview file identity is already in use.");
    try {
      file.create();
      file.write(bytes);
      const written = await file.bytes();
      return { uri: file.uri, fileName, byteSize: file.size, bytes: written };
    } catch (error) {
      if (file.exists) file.delete();
      throw error;
    }
  },
  async remove(snapshot) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, MOBILE_PDF_PREVIEW_ROOT_DIRECTORY);
    const file = new File(snapshot.uri);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    if (!file.uri.startsWith(prefix) || file.name !== snapshot.fileName) {
      throw new Error("Refusing to remove a file outside the PDF preview cache.");
    }
    if (file.exists) file.delete();
  }
};

export const mobilePdfPreviewFiles = new MobilePdfPreviewFiles();

export const mobilePdfPreviewTesting = { pdfPreviewRootDirectory: MOBILE_PDF_PREVIEW_ROOT_DIRECTORY };
