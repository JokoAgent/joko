import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeMobileBase64 } from "./mobile-image-annotation";
import { inspectMobileImageGalleryBytes } from "./mobile-image-gallery";
import type { MobileFilesThumbnailContent } from "./mobile-files-thumbnails";

export const MOBILE_FILES_CACHE_MAXIMUM_ENTRIES = 300;
export const MOBILE_FILES_CACHE_MAXIMUM_BYTES = 32 * 1024 * 1024;
export const MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES = 8 * 1024 * 1024;
export interface MobileFilesThumbnailCacheFile { readonly name: string; readonly byteSize: number; readonly modifiedAt: number }
export interface MobileFilesThumbnailCacheDriver {
  list(): Promise<readonly MobileFilesThumbnailCacheFile[]>;
  read(name: string, maximumBytes: number): Promise<Uint8Array | undefined>;
  /** Stage and verify bytes, then check the source immediately before publishing the final file. */
  write(name: string, bytes: Uint8Array, assertCurrent: () => void): Promise<void>;
  remove(name: string): Promise<void>;
}
interface RecordV1 {
  readonly version: 1; readonly ownerDigest: string; readonly sourceDigest: string;
  readonly content: MobileFilesThumbnailContent; readonly payloadSha256Hex: string;
}

/** Disposable device-private copies. A caller must reauthorize its source before calling get. */
export class MobileFilesThumbnailCache {
  #serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly driver: MobileFilesThumbnailCacheDriver) {}
  get(ownerKey: string, sourceKey: string, assertCurrent: () => void): Promise<MobileFilesThumbnailContent | undefined> {
    return this.#ordered(async () => {
      assertCurrent(); const name = recordName(ownerKey, sourceKey); const files = await this.#clean(); assertCurrent();
      if (!files.some((file) => file.name === name)) return undefined;
      const bytes = await this.driver.read(name, MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES); assertCurrent();
      let record: RecordV1;
      try { record = decodeRecord(bytes, ownerKey, sourceKey); }
      catch { await this.driver.remove(name); assertCurrent(); return undefined; }
      // Rewriting a validated record updates its disk LRU time. Cache loss during touch is harmless.
      try { await this.#replace(name, bytes!, assertCurrent); } catch { assertCurrent(); }
      assertCurrent(); return record.content;
    });
  }
  put(ownerKey: string, sourceKey: string, content: MobileFilesThumbnailContent, assertCurrent: () => void): Promise<void> {
    return this.#ordered(async () => {
      assertCurrent(); const checked = validateContent(content);
      const record: RecordV1 = { version: 1, ownerDigest: textDigest(ownerKey), sourceDigest: textDigest(sourceKey), content: checked,
        payloadSha256Hex: textDigest(JSON.stringify(checked)) };
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      if (bytes.length > MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES) return;
      await this.#replace(recordName(ownerKey, sourceKey), bytes, assertCurrent);
    });
  }
  remove(ownerKey: string, sourceKey: string): Promise<void> { return this.#ordered(() => this.driver.remove(recordName(ownerKey, sourceKey))); }
  #ordered<T>(action: () => Promise<T>): Promise<T> { const result = this.#serial.then(action); this.#serial = result.catch(() => undefined); return result; }
  async #clean(): Promise<MobileFilesThumbnailCacheFile[]> {
    const files = await this.driver.list(); const accepted: MobileFilesThumbnailCacheFile[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file.name) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES) {
        await this.driver.remove(file.name);
      } else accepted.push(file);
    }
    accepted.sort((left, right) => (Number.isFinite(left.modifiedAt) ? left.modifiedAt : 0) - (Number.isFinite(right.modifiedAt) ? right.modifiedAt : 0) || left.name.localeCompare(right.name));
    let bytes = accepted.reduce((sum, file) => sum + file.byteSize, 0);
    while (accepted.length > MOBILE_FILES_CACHE_MAXIMUM_ENTRIES || bytes > MOBILE_FILES_CACHE_MAXIMUM_BYTES) {
      const file = accepted.shift()!; await this.driver.remove(file.name); bytes -= file.byteSize;
    }
    return accepted;
  }
  async #replace(name: string, bytes: Uint8Array, assertCurrent: () => void): Promise<void> {
    const files = await this.#clean(); assertCurrent();
    const previous = files.findIndex((file) => file.name === name);
    if (previous >= 0) { await this.driver.remove(name); files.splice(previous, 1); assertCurrent(); }
    let total = files.reduce((sum, file) => sum + file.byteSize, 0);
    // Reserve both stage and destination, even if a native move uses copy-then-delete.
    while (files.length + 2 > MOBILE_FILES_CACHE_MAXIMUM_ENTRIES || total + 2 * bytes.length > MOBILE_FILES_CACHE_MAXIMUM_BYTES) {
      const file = files.shift(); if (!file) throw new Error("The file miniature disk budget was reached.");
      await this.driver.remove(file.name); total -= file.byteSize; assertCurrent();
    }
    try { assertCurrent(); await this.driver.write(name, bytes, assertCurrent); assertCurrent(); }
    catch (error) { await this.driver.remove(name).catch(() => undefined); throw error; }
  }
}

function recordName(ownerKey: string, sourceKey: string): string { return textDigest(JSON.stringify([1, ownerKey, sourceKey])) + ".json"; }
function textDigest(value: string): string { return bytesToHex(sha256(new TextEncoder().encode(value))); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The file miniature cache record is invalid."); return value as Record<string, unknown>; }
function decodeRecord(bytes: Uint8Array | undefined, ownerKey: string, sourceKey: string): RecordV1 {
  if (!bytes?.length || bytes.length > MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES) throw new Error("The file miniature cache exceeds its bounds.");
  const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (!exactKeys(value, ["version", "ownerDigest", "sourceDigest", "content", "payloadSha256Hex"]) || value.version !== 1
    || value.ownerDigest !== textDigest(ownerKey) || value.sourceDigest !== textDigest(sourceKey)) throw new Error("The file miniature cache source changed.");
  const content = validateContent(value.content);
  if (value.payloadSha256Hex !== textDigest(JSON.stringify(content))) throw new Error("The file miniature cache payload changed.");
  return { version: 1, ownerDigest: value.ownerDigest as string, sourceDigest: value.sourceDigest as string, content, payloadSha256Hex: value.payloadSha256Hex as string };
}
function validateContent(content: unknown): MobileFilesThumbnailContent {
  const value = object(content);
  if (value.kind === "text") {
    if (!exactKeys(value, ["kind", "text"]) || typeof value.text !== "string" || value.text.length > 2000 || !value.text
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\r]/u.test(value.text)) throw new Error("The file miniature text cache is invalid.");
    return { kind: "text", text: value.text };
  }
  if (value.kind !== "image" || !exactKeys(value, ["kind", "uri", "width", "height", "mediaType", "animated"]) || typeof value.uri !== "string"
    || value.uri.length > MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES || typeof value.mediaType !== "string" || typeof value.animated !== "boolean") throw new Error("The file miniature image cache is invalid.");
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value.uri);
  if (!match || match[1] !== value.mediaType) throw new Error("The file miniature cache MIME changed.");
  const bytes = decodeMobileBase64(match[2]!, MOBILE_FILES_CACHE_MAXIMUM_RECORD_BYTES);
  const decoded = inspectMobileImageGalleryBytes(bytes, value.mediaType);
  if (decoded.width !== value.width || decoded.height !== value.height || (decoded.animated === true) !== value.animated
    || (decoded.previewMediaType ?? decoded.mediaType) !== value.mediaType) throw new Error("The file miniature cache dimensions changed.");
  return { kind: "image", uri: value.uri, width: decoded.width, height: decoded.height, mediaType: value.mediaType, animated: value.animated };
}

const directoryName = "joko-mobile-file-miniatures-v1";
function assertCacheName(name: string): void { if (!name || name === "." || name === ".." || name.length > 255 || /[\\/\u0000-\u001f]/u.test(name)) throw new Error("The private cache filename is invalid."); }
async function cacheDirectory() { const { Directory, Paths } = await import("expo-file-system"); return new Directory(Paths.cache, directoryName); }
export const expoMobileFilesThumbnailCacheDriver: MobileFilesThumbnailCacheDriver = {
  async list() {
    const { File } = await import("expo-file-system"); const directory = await cacheDirectory(); if (!directory.exists) return [];
    return directory.list().map((entry) => {
      if (!(entry instanceof File)) throw new Error("The private file miniature cache contains an unexpected directory.");
      return { name: entry.name, byteSize: entry.size, modifiedAt: entry.modificationTime ?? 0 };
    });
  },
  async read(name, maximumBytes) {
    assertCacheName(name); const { File } = await import("expo-file-system"); const file = new File(await cacheDirectory(), name);
    if (!file.exists) return undefined; if (file.size < 1 || file.size > maximumBytes) throw new Error("The cached file miniature exceeds its byte limit.");
    const bytes = await file.bytes(); if (bytes.length > maximumBytes) throw new Error("The cached file miniature grew during reading."); return bytes;
  },
  async write(name, bytes, assertCurrent) {
    assertCacheName(name); const { File } = await import("expo-file-system"); const directory = await cacheDirectory(); assertCurrent();
    directory.create({ intermediates: true, idempotent: true }); const stageName = name + ".tmp"; const stage = new File(directory, stageName); const destination = new File(directory, name);
    try {
      assertCurrent(); stage.create({ overwrite: true }); stage.write(bytes);
      const written = await stage.bytes(); assertCurrent();
      if (written.length !== bytes.length || bytesToHex(sha256(written)) !== bytesToHex(sha256(bytes))) throw new Error("The staged file miniature cache bytes changed.");
      if (destination.exists) throw new Error("The file miniature cache destination is already in use.");
      assertCurrent(); stage.moveSync(destination); assertCurrent();
    } catch (error) { if (destination.exists) destination.delete(); throw error; }
    finally { const remainder = new File(directory, stageName); if (remainder.exists) remainder.delete(); }
  },
  async remove(name) {
    assertCacheName(name); const { File } = await import("expo-file-system"); const file = new File(await cacheDirectory(), name); if (file.exists) file.delete();
  }
};
export const mobileFilesThumbnailCache = new MobileFilesThumbnailCache(expoMobileFilesThumbnailCacheDriver);
