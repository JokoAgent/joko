import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ImageThumbnailSchema, type BlobRef, type ImageThumbnail } from "@joko/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { MobileConnectionProfile } from "./connection-storage";
import type { VerifiedBlobDownload } from "./network";

export interface MobileMediaCacheFile { readonly name: string; readonly byteSize: number; readonly modifiedAt: number }
export interface MobileMediaCacheDriver {
  list(): Promise<readonly MobileMediaCacheFile[]>;
  read(name: string, maximumBytes: number): Promise<Uint8Array | undefined>;
  write(name: string, bytes: Uint8Array, assertCurrent: () => void): Promise<void>;
  remove(name: string): Promise<void>;
}

const maximumRecordBytes = 32 * 1024 * 1024;
const maximumCacheBytes = 256 * 1024 * 1024;
const maximumEntries = 512;
const namePattern = /^[a-f0-9]{64}-[a-f0-9]{64}\.(?:bytes|thumb)$/u;

/** Disposable local bytes. Callers supply the canonical source and its current owner lease. */
export class MobileMediaByteCache {
  #tail: Promise<unknown> = Promise.resolve();
  #epochs = new Map<string, number>();
  #access = new Map<string, number>();

  constructor(private readonly driver: MobileMediaCacheDriver, private readonly now = Date.now) {}

  captureOwner(profileId: string, assertCurrent: () => void): () => void { return this.#guard(profileId, assertCurrent); }

  async get(owner: MobileConnectionProfile, blob: BlobRef, assertCurrent: () => void): Promise<VerifiedBlobDownload | undefined> {
    const name = fileName(owner, blob, "bytes");
    return this.#read(owner.profileId, name, assertCurrent, (bytes) => {
      assertBlobBytes(blob, bytes);
      return { bytes, mediaType: blob.mediaType };
    });
  }

  async put(owner: MobileConnectionProfile, blob: BlobRef, bytes: Uint8Array, assertCurrent: () => void): Promise<void> {
    assertBlobBytes(blob, bytes);
    return this.#write(owner.profileId, fileName(owner, blob, "bytes"), bytes, assertCurrent);
  }

  async getThumbnail(owner: MobileConnectionProfile, blob: BlobRef, edge: 256 | 1024, assertCurrent: () => void): Promise<ImageThumbnail | undefined> {
    return this.#read(owner.profileId, fileName(owner, blob, "thumb", edge), assertCurrent, (bytes) => {
      const value = fromJson(ImageThumbnailSchema, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      assertThumbnail(value, edge);
      return value;
    });
  }

  async putThumbnail(owner: MobileConnectionProfile, blob: BlobRef, edge: 256 | 1024, thumbnail: ImageThumbnail, assertCurrent: () => void): Promise<void> {
    assertThumbnail(thumbnail, edge);
    const bytes = new TextEncoder().encode(JSON.stringify(toJson(ImageThumbnailSchema, create(ImageThumbnailSchema, thumbnail))));
    return this.#write(owner.profileId, fileName(owner, blob, "thumb", edge), bytes, assertCurrent);
  }

  clear(profileId: string): Promise<void> {
    const prefix = profilePrefix(profileId);
    this.#epochs.set(profileId, (this.#epochs.get(profileId) ?? 0) + 1);
    return this.#ordered(async () => {
      for (const file of await this.driver.list()) {
        if (file.name.startsWith(prefix)) { await this.driver.remove(file.name); this.#access.delete(file.name); }
      }
    });
  }

  #read<T>(profileId: string, name: string, assertCurrent: () => void, decode: (bytes: Uint8Array) => T): Promise<T | undefined> {
    const current = this.#guard(profileId, assertCurrent);
    return this.#ordered(async () => {
      current();
      const files = await this.#prune(); current();
      if (!files.some((file) => file.name === name)) return undefined;
      const bytes = await this.driver.read(name, maximumRecordBytes); current();
      if (!bytes) return undefined;
      let result: T;
      try { result = decode(bytes); }
      catch { await this.driver.remove(name); current(); return undefined; }
      current(); this.#access.set(name, this.now()); return result;
    });
  }

  #write(profileId: string, name: string, bytes: Uint8Array, assertCurrent: () => void): Promise<void> {
    const current = this.#guard(profileId, assertCurrent);
    // A private copy prevents a caller from changing bytes while the write waits for other cache work.
    const copy = bytes.slice();
    return this.#ordered(async () => {
      current(); if (copy.length > maximumRecordBytes) return;
      const files = await this.#prune(); current();
      const existing = files.find((file) => file.name === name);
      if (existing) { await this.driver.remove(name); current(); }
      const others = files.filter((file) => file !== existing);
      let total = others.reduce((sum, file) => sum + file.byteSize, 0);
      // Reserve space for both the staged copy and its destination.
      while (others.length + 2 > maximumEntries || total + 2 * copy.length > maximumCacheBytes) {
        const oldest = others.shift(); if (!oldest) return;
        await this.driver.remove(oldest.name); this.#access.delete(oldest.name); total -= oldest.byteSize; current();
      }
      try { await this.driver.write(name, copy, current); current(); this.#access.set(name, this.now()); }
      catch (error) { await this.driver.remove(name).catch(() => undefined); throw error; }
    });
  }

  #guard(profileId: string, assertCurrent: () => void): () => void {
    const epoch = this.#epochs.get(profileId) ?? 0;
    return () => { assertCurrent(); if ((this.#epochs.get(profileId) ?? 0) !== epoch) throw new Error("The local media owner was cleared."); };
  }

  async #prune(): Promise<MobileMediaCacheFile[]> {
    const files: MobileMediaCacheFile[] = [];
    for (const file of await this.driver.list()) {
      if (!namePattern.test(file.name) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || file.byteSize > maximumRecordBytes) {
        await this.driver.remove(file.name); this.#access.delete(file.name);
      } else files.push(file);
    }
    files.sort((left, right) => (this.#access.get(left.name) ?? left.modifiedAt) - (this.#access.get(right.name) ?? right.modifiedAt)
      || left.name.localeCompare(right.name));
    let total = files.reduce((sum, file) => sum + file.byteSize, 0);
    while (files.length > maximumEntries || total > maximumCacheBytes) {
      const oldest = files.shift()!; await this.driver.remove(oldest.name); this.#access.delete(oldest.name); total -= oldest.byteSize;
    }
    return files;
  }

  #ordered<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action); this.#tail = result.catch(() => undefined); return result;
  }
}

function digest(bytes: Uint8Array): string { return bytesToHex(sha256(bytes)); }
function profilePrefix(profileId: string): string {
  if (!profileId || profileId.length > 512 || /[\u0000-\u001f]/u.test(profileId)) throw new Error("The local media profile is invalid.");
  return digest(new TextEncoder().encode(profileId)) + "-";
}
function fileName(owner: MobileConnectionProfile, blob: BlobRef, kind: "bytes" | "thumb", edge?: number): string {
  if (![owner.origin, owner.serverId, owner.connectionId, owner.deviceId, blob.blobId].every((value) => value && value.length <= 2048)
    || !/^[a-f0-9]{64}$/u.test(blob.sha256Hex) || blob.byteSize < 0n || blob.byteSize > BigInt(maximumRecordBytes)
    || !blob.mediaType || blob.mediaType.length > 255 || blob.fileName.length > 1024) throw new Error("The local media source is invalid.");
  const source = [1, owner.origin, owner.serverId, owner.connectionId, owner.deviceId,
    blob.blobId, blob.sha256Hex, blob.byteSize.toString(), blob.mediaType, blob.fileName, edge];
  return profilePrefix(owner.profileId) + digest(new TextEncoder().encode(JSON.stringify(source))) + "." + kind;
}
function assertBlobBytes(blob: BlobRef, bytes: Uint8Array): void {
  if (BigInt(bytes.length) !== blob.byteSize || bytes.length > maximumRecordBytes || digest(bytes) !== blob.sha256Hex) {
    throw new Error("The local media bytes do not match their canonical source.");
  }
}
function assertThumbnail(value: ImageThumbnail, edge: number): void {
  if (value.mediaType !== "image/webp" || !value.data.length || value.data.length > 700 * 1024
    || digest(value.data) !== value.sha256Hex || value.widthPixels < 1 || value.heightPixels < 1
    || value.widthPixels > edge || value.heightPixels > edge || value.sourceWidthPixels < 1 || value.sourceHeightPixels < 1
    || value.sourceWidthPixels > 16_384 || value.sourceHeightPixels > 16_384
    || value.sourceWidthPixels * value.sourceHeightPixels > 64 * 1024 * 1024
    || Math.max(value.widthPixels, value.heightPixels) > Math.max(value.sourceWidthPixels, value.sourceHeightPixels)) {
    throw new Error("The local media thumbnail is invalid.");
  }
}

const directoryName = "joko-mobile-media-bytes-v1";
function assertName(name: string): void {
  if (!name || name.length > 255 || name === "." || name === ".." || /[\\/\u0000-\u001f]/u.test(name)) throw new Error("The local media filename is invalid.");
}
async function directory() { const { Directory, Paths } = await import("expo-file-system"); return new Directory(Paths.cache, directoryName); }
export const expoMobileMediaCacheDriver: MobileMediaCacheDriver = {
  async list() {
    const { File } = await import("expo-file-system"); const root = await directory(); if (!root.exists) return [];
    return root.list().map((file) => {
      if (!(file instanceof File)) throw new Error("The local media cache contains an unexpected directory.");
      return { name: file.name, byteSize: file.size, modifiedAt: file.modificationTime ?? 0 };
    });
  },
  async read(name, maximumBytes) {
    assertName(name); const { File } = await import("expo-file-system"); const file = new File(await directory(), name);
    if (!file.exists) return undefined;
    if (file.size > maximumBytes) return undefined;
    const bytes = await file.bytes(); if (bytes.length > maximumBytes) throw new Error("The local media cache grew during reading."); return bytes;
  },
  async write(name, bytes, assertCurrent) {
    assertName(name); const { File } = await import("expo-file-system"); const root = await directory(); assertCurrent();
    root.create({ intermediates: true, idempotent: true }); const stageName = name + ".tmp";
    const stage = new File(root, stageName), destination = new File(root, name);
    try {
      assertCurrent(); stage.create({ overwrite: true }); stage.write(bytes);
      const written = await stage.bytes(); assertCurrent();
      if (written.length !== bytes.length || digest(written) !== digest(bytes)) throw new Error("The local media cache write failed verification.");
      if (destination.exists) throw new Error("The local media destination is already in use.");
      assertCurrent(); stage.moveSync(destination); assertCurrent();
    } catch (error) { if (destination.exists) destination.delete(); throw error; }
    finally { const remainder = new File(root, stageName); if (remainder.exists) remainder.delete(); }
  },
  async remove(name) { assertName(name); const { File } = await import("expo-file-system"); const file = new File(await directory(), name); if (file.exists) file.delete(); }
};

export const mobileMediaByteCache = new MobileMediaByteCache(expoMobileMediaCacheDriver);
