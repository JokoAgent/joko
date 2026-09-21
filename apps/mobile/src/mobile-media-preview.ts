import { MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES } from "./network";
import { normalizeMediaType } from "./workspace-files";

export type MobileMediaPreviewKind = "audio" | "video";

export interface MobileMediaPreviewLease {
  readonly leaseId: string;
  readonly profileId: string;
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly mediaKind: MobileMediaPreviewKind;
  readonly localByteSize: number;
  readonly sha256Hex: string;
}

export interface MobileMediaPreviewFileSnapshot {
  readonly uri: string;
  readonly fileName: string;
  readonly byteSize: number;
  readonly bytes: Uint8Array;
}

export interface MobileMediaPreviewFileDriver {
  prepare(): Promise<void>;
  write(fileName: string, bytes: Uint8Array): Promise<MobileMediaPreviewFileSnapshot>;
  remove(snapshot: Pick<MobileMediaPreviewFileSnapshot, "uri" | "fileName">): Promise<void>;
}

interface MobileMediaTypeDescriptor {
  readonly kind: MobileMediaPreviewKind;
  readonly extension: string;
  readonly sourceExtensions: readonly string[];
  readonly signature: "aac" | "flac" | "m4a" | "mp3" | "mp4" | "ogg" | "quicktime" | "wav" | "webm";
}

export interface MobileInspectedMediaPreview {
  readonly mediaType: string;
  readonly mediaKind: MobileMediaPreviewKind;
  readonly extension: string;
}

type DigestBytes = (bytes: Uint8Array) => Promise<string>;

const mediaTypes = new Map<string, MobileMediaTypeDescriptor>([
  ["video/mp4", { kind: "video", extension: "mp4", sourceExtensions: ["mp4", "m4v"], signature: "mp4" }],
  ["video/x-m4v", { kind: "video", extension: "m4v", sourceExtensions: ["m4v"], signature: "mp4" }],
  ["video/quicktime", { kind: "video", extension: "mov", sourceExtensions: ["mov"], signature: "quicktime" }],
  ["video/webm", { kind: "video", extension: "webm", sourceExtensions: ["webm"], signature: "webm" }],
  ["audio/mpeg", { kind: "audio", extension: "mp3", sourceExtensions: ["mp3"], signature: "mp3" }],
  ["audio/mp4", { kind: "audio", extension: "m4a", sourceExtensions: ["m4a"], signature: "m4a" }],
  ["audio/x-m4a", { kind: "audio", extension: "m4a", sourceExtensions: ["m4a"], signature: "m4a" }],
  ["audio/wav", { kind: "audio", extension: "wav", sourceExtensions: ["wav"], signature: "wav" }],
  ["audio/x-wav", { kind: "audio", extension: "wav", sourceExtensions: ["wav"], signature: "wav" }],
  ["audio/vnd.wave", { kind: "audio", extension: "wav", sourceExtensions: ["wav"], signature: "wav" }],
  ["audio/aac", { kind: "audio", extension: "aac", sourceExtensions: ["aac"], signature: "aac" }],
  ["audio/x-aac", { kind: "audio", extension: "aac", sourceExtensions: ["aac"], signature: "aac" }],
  ["audio/ogg", { kind: "audio", extension: "ogg", sourceExtensions: ["ogg"], signature: "ogg" }],
  ["audio/flac", { kind: "audio", extension: "flac", sourceExtensions: ["flac"], signature: "flac" }],
  ["audio/x-flac", { kind: "audio", extension: "flac", sourceExtensions: ["flac"], signature: "flac" }]
]);

export class MobileMediaPreviewFiles {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly driver: MobileMediaPreviewFileDriver = expoMobileMediaPreviewFileDriver,
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
  ): Promise<MobileMediaPreviewLease> {
    const exactProfileId = boundedIdentity(profileId, "profile");
    const exactLeaseId = boundedIdentity(leaseId, "preview lease");
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256Hex)) {
      throw new Error("The media preview SHA-256 identity is invalid.");
    }
    const inspected = inspectMobileMediaPreviewBytes(bytes, mediaType, sourceName);
    const fileName = `preview-${exactLeaseId}.${inspected.extension}`;
    return this.#exclusive(async () => {
      signal?.throwIfAborted();
      const digest = await this.digestBytes(bytes);
      signal?.throwIfAborted();
      if (digest !== expectedSha256Hex) {
        throw new Error("The media preview bytes do not match the authenticated SHA-256 identity.");
      }
      await this.driver.prepare();
      signal?.throwIfAborted();
      let snapshot: MobileMediaPreviewFileSnapshot | undefined;
      try {
        snapshot = await this.driver.write(fileName, bytes);
        signal?.throwIfAborted();
        assertSnapshot(snapshot, fileName, bytes.byteLength);
        if (!equalBytes(snapshot.bytes, bytes) || await this.digestBytes(snapshot.bytes) !== expectedSha256Hex) {
          throw new Error("The app-owned media preview file failed readback verification.");
        }
        signal?.throwIfAborted();
        return {
          leaseId: exactLeaseId,
          profileId: exactProfileId,
          uri: snapshot.uri,
          fileName,
          mediaType: inspected.mediaType,
          mediaKind: inspected.mediaKind,
          localByteSize: bytes.byteLength,
          sha256Hex: expectedSha256Hex
        };
      } catch (error) {
        if (snapshot) await this.driver.remove(snapshot).catch(() => undefined);
        throw error;
      }
    });
  }

  async remove(lease: MobileMediaPreviewLease): Promise<void> {
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

export function mobileMediaPreviewKind(mediaType: string): MobileMediaPreviewKind | undefined {
  return mediaTypes.get(normalizeMediaType(mediaType))?.kind;
}

export function inspectMobileMediaPreviewBytes(
  bytes: Uint8Array,
  mediaType: string,
  sourceName: string
): MobileInspectedMediaPreview {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4
    || bytes.byteLength > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) {
    throw new Error("The media preview bytes exceed the safe mobile preview budget.");
  }
  const exactMediaType = normalizeMediaType(mediaType);
  const descriptor = mediaTypes.get(exactMediaType);
  if (!descriptor) throw new Error(`No safe mobile audio/video preview is available for ${exactMediaType || "this media type"}.`);
  const extension = sourceExtension(sourceName);
  if (!descriptor.sourceExtensions.includes(extension)) {
    throw new Error("The media preview file extension does not match its canonical media type.");
  }
  const valid = descriptor.signature === "mp4" ? isIsoMedia(bytes, "video")
    : descriptor.signature === "quicktime" ? isQuickTimeVideo(bytes)
      : descriptor.signature === "m4a" ? isIsoMedia(bytes, "audio")
        : descriptor.signature === "webm" ? isWebmVideo(bytes)
          : descriptor.signature === "mp3" ? isMp3(bytes)
            : descriptor.signature === "wav" ? asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")
              : descriptor.signature === "aac" ? isAac(bytes)
                : descriptor.signature === "ogg" ? isOggAudio(bytes)
                  : asciiAt(bytes, 0, "fLaC");
  if (!valid) throw new Error("The media preview container does not match its canonical media type.");
  return { mediaType: exactMediaType, mediaKind: descriptor.kind, extension: descriptor.extension };
}

function isIsoMedia(bytes: Uint8Array, expected: MobileMediaPreviewKind): boolean {
  if (!validFtyp(bytes)) return false;
  const brand = ascii(bytes, 8, 4);
  if (brand === "qt  ") return false;
  const handlers = isoHandlerTypes(bytes);
  return expected === "video" ? handlers.has("vide") : handlers.has("soun") && !handlers.has("vide");
}

function isQuickTimeVideo(bytes: Uint8Array): boolean {
  return validFtyp(bytes) && ascii(bytes, 8, 4) === "qt  " && isoHandlerTypes(bytes).has("vide");
}

function validFtyp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24 || !asciiAt(bytes, 4, "ftyp")) return false;
  const size = uint32(bytes, 0);
  if (size < 16 || size > bytes.byteLength) return false;
  const brand = ascii(bytes, 8, 4);
  return /^[A-Za-z0-9 ]{4}$/u.test(brand);
}

function isoHandlerTypes(bytes: Uint8Array): Set<string> {
  const handlers = new Set<string>();
  for (let offset = 4; offset + 20 <= bytes.byteLength; offset += 1) {
    if (!asciiAt(bytes, offset, "hdlr")) continue;
    const boxStart = offset - 4;
    const size = uint32(bytes, boxStart);
    if (size < 20 || boxStart + size > bytes.byteLength) continue;
    const handler = ascii(bytes, offset + 12, 4);
    if (handler === "vide" || handler === "soun") handlers.add(handler);
  }
  return handlers;
}

function isWebmVideo(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
    && includesAscii(bytes, "webm") && includesAscii(bytes, "V_");
}

function isMp3(bytes: Uint8Array): boolean {
  let start = 0;
  if (asciiAt(bytes, 0, "ID3") && bytes.byteLength >= 10) {
    const sizeBytes = bytes.subarray(6, 10);
    if (sizeBytes.some((value) => value > 0x7f)) return false;
    start = 10 + ((sizeBytes[0]! << 21) | (sizeBytes[1]! << 14) | (sizeBytes[2]! << 7) | sizeBytes[3]!);
    if ((bytes[5]! & 0x10) !== 0) start += 10;
    if (start >= bytes.byteLength - 3) return false;
  }
  for (let offset = start; offset + 3 < bytes.byteLength; offset += 1) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1]!;
    const third = bytes[offset + 2]!;
    if (first === 0xff && (second & 0xe0) === 0xe0 && (second & 0x18) !== 0x08
      && (second & 0x06) !== 0 && (third & 0xf0) !== 0 && (third & 0xf0) !== 0xf0
      && (third & 0x0c) !== 0x0c) return true;
  }
  return false;
}

function isAac(bytes: Uint8Array): boolean {
  return asciiAt(bytes, 0, "ADIF")
    || bytes.byteLength >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
}

function isOggAudio(bytes: Uint8Array): boolean {
  if (!asciiAt(bytes, 0, "OggS")) return false;
  return includesAscii(bytes, "OpusHead") || includesAscii(bytes, "vorbis")
    || includesAscii(bytes, "Speex   ") || includesAscii(bytes, "fLaC");
}

function sourceExtension(value: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  const leaf = value.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const match = /\.([A-Za-z0-9]{1,12})$/u.exec(leaf);
  return match?.[1]?.toLocaleLowerCase() ?? "";
}

function assertSnapshot(snapshot: MobileMediaPreviewFileSnapshot, fileName: string, byteSize: number): void {
  if (!snapshot || typeof snapshot !== "object" || snapshot.fileName !== fileName
    || typeof snapshot.uri !== "string" || !snapshot.uri.startsWith("file://")
    || /[\u0000-\u001f\u007f]/u.test(snapshot.uri) || snapshot.uri.length > 4_096
    || snapshot.byteSize !== byteSize || !(snapshot.bytes instanceof Uint8Array)
    || snapshot.bytes.byteLength !== byteSize) {
    throw new Error("The app-owned media preview file snapshot is invalid.");
  }
}

function assertLease(lease: MobileMediaPreviewLease): MobileMediaPreviewLease {
  const exactProfileId = boundedIdentity(lease?.profileId, "profile");
  const exactLeaseId = boundedIdentity(lease?.leaseId, "preview lease");
  const descriptor = mediaTypes.get(normalizeMediaType(lease?.mediaType ?? ""));
  if (!descriptor || descriptor.kind !== lease.mediaKind || lease.fileName !== `preview-${exactLeaseId}.${descriptor.extension}`
    || typeof lease.uri !== "string" || !lease.uri.startsWith("file://") || lease.uri.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(lease.uri) || !Number.isSafeInteger(lease.localByteSize)
    || lease.localByteSize < 4 || lease.localByteSize > MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES
    || !/^[0-9a-f]{64}$/u.test(lease.sha256Hex)) {
    throw new Error("The media preview lease is invalid.");
  }
  return { ...lease, profileId: exactProfileId, leaseId: exactLeaseId, mediaType: normalizeMediaType(lease.mediaType) };
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`The media preview ${label} identity is invalid.`);
  return value;
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function includesAscii(bytes: Uint8Array, value: string): boolean {
  for (let offset = 0; offset + value.length <= bytes.byteLength; offset += 1) {
    if (asciiAt(bytes, offset, value)) return true;
  }
  return false;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length && offset + index < bytes.byteLength; index += 1) {
    result += String.fromCharCode(bytes[offset + index]!);
  }
  return result;
}

function uint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! * 0x1_000000) + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  const value = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes).buffer));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const mediaPreviewRootDirectory = "joko-media-preview";

const expoMobileMediaPreviewFileDriver: MobileMediaPreviewFileDriver = {
  async prepare() {
    const { Directory, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, mediaPreviewRootDirectory);
    if (root.exists) root.delete();
    root.create({ idempotent: true, intermediates: true });
  },
  async write(fileName, bytes) {
    const { Directory, File, Paths } = await import("expo-file-system");
    const root = new Directory(Paths.cache, mediaPreviewRootDirectory);
    root.create({ idempotent: true, intermediates: true });
    const file = new File(root, fileName);
    if (file.exists) throw new Error("The media preview file identity is already in use.");
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
    const root = new Directory(Paths.cache, mediaPreviewRootDirectory);
    const file = new File(snapshot.uri);
    const prefix = root.uri.endsWith("/") ? root.uri : `${root.uri}/`;
    if (!file.uri.startsWith(prefix) || file.name !== snapshot.fileName) {
      throw new Error("Refusing to remove a file outside the media preview cache.");
    }
    if (file.exists) file.delete();
  }
};

export const mobileMediaPreviewFiles = new MobileMediaPreviewFiles();

export const mobileMediaPreviewTesting = {
  mediaPreviewRootDirectory
};
