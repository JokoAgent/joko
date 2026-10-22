import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, unlink, utimes, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const MAXIMUM_FILE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_CACHE_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_CACHE_ENTRIES = 4096;
const KEY = /^([a-f0-9]{64})-([a-f0-9]{64})\.(bin|json)$/;
const STAGING = /^write-[a-f0-9-]{36}\.part$/;
const tails = new Map<string, Promise<unknown>>();

export interface RemoteFileCacheIdentity {
  readonly source: string;
  readonly version: string;
  readonly size: number;
}

interface Entry {
  readonly key: string;
  readonly source: string;
  readonly size: number;
  readonly sha256: string;
  readonly lastUsed: number;
  readonly diskBytes: number;
}

/** Disposable copies of version-attested workspace files. Conversation Blobs
 * retain their existing ArtifactStore ownership and retention. */
export class RemoteFileVersionCache {
  readonly #root: string;
  readonly #maximumBytes: number;
  readonly #maximumEntries: number;
  #ready = false;

  constructor(root: string, options: { maximumBytes?: number; maximumEntries?: number } = {}) {
    this.#root = resolve(root);
    if (!isAbsolute(root) || this.#root !== root) throw new Error("Remote file cache requires an absolute private root.");
    this.#maximumBytes = options.maximumBytes ?? MAXIMUM_CACHE_BYTES;
    this.#maximumEntries = options.maximumEntries ?? MAXIMUM_CACHE_ENTRIES;
    if (![this.#maximumBytes, this.#maximumEntries].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("Invalid remote file cache budget.");
    }
  }

  async read(identity: RemoteFileCacheIdentity, maximumBytes: number, assertCurrent: () => void): Promise<Buffer | undefined> {
    if (!valid(identity) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0) return undefined;
    return this.#exclusive(async () => {
      await this.#initialize(); assertCurrent();
      const key = `${identity.source}-${identity.version}`;
      const entry = await this.#entry(key);
      if (!entry || entry.size !== identity.size) { await this.#remove(key); return undefined; }
      const file = await open(join(this.#root, `${key}.bin`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let result: Buffer | undefined;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== entry.size) return undefined;
        const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
        const output = Buffer.alloc(Math.min(entry.size, maximumBytes));
        let position = 0;
        for (;;) {
          assertCurrent();
          const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, entry.size - position + 1), position);
          if (bytesRead === 0) break;
          if (position + bytesRead > entry.size) return undefined;
          hash.update(chunk.subarray(0, bytesRead));
          if (position < output.length) chunk.copy(output, position, 0, Math.min(bytesRead, output.length - position));
          position += bytesRead;
        }
        if (position === entry.size && hash.digest("hex") === entry.sha256) result = output;
      } finally { await file.close(); }
      assertCurrent();
      if (!result) { await this.#remove(key); return undefined; }
      const now = new Date();
      await utimes(join(this.#root, `${key}.bin`), now, now).catch(() => undefined);
      assertCurrent();
      return result;
    });
  }

  async write(identity: RemoteFileCacheIdentity, content: Uint8Array, assertCurrent: () => void): Promise<void> {
    if (!valid(identity) || content.byteLength !== identity.size || identity.size + 1024 > this.#maximumBytes) return;
    return this.#exclusive(async () => {
      await this.#initialize(); assertCurrent();
      const key = `${identity.source}-${identity.version}`;
      const sha256 = createHash("sha256").update(content).digest("hex");
      const entries = await this.#scan();
      let used = entries.reduce((sum, entry) => sum + entry.diskBytes, 0), count = entries.length;
      entries.sort((left, right) => Number(right.source === identity.source) - Number(left.source === identity.source)
        || left.lastUsed - right.lastUsed);
      // Reserve before allocating the temporary copy. Superseded versions use
      // the same budget and are disposable even if their last access was recent.
      for (const entry of entries) {
        if (entry.source !== identity.source && used + identity.size + 1024 <= this.#maximumBytes && count < this.#maximumEntries) continue;
        assertCurrent(); await this.#remove(entry.key);
        used -= entry.diskBytes; count--;
      }
      if (used + identity.size + 1024 > this.#maximumBytes || count >= this.#maximumEntries) return;
      const staged = join(this.#root, `write-${randomUUID()}.part`);
      const metadata = join(this.#root, `write-${randomUUID()}.part`);
      try {
        assertCurrent();
        await writeFile(staged, content, { flag: "wx", mode: 0o600 });
        await writeFile(metadata, JSON.stringify({ format: 1, size: identity.size, sha256 }), { flag: "wx", mode: 0o600 });
        assertCurrent();
        renameSync(staged, join(this.#root, `${key}.bin`));
        renameSync(metadata, join(this.#root, `${key}.json`));
        assertCurrent();
      } finally {
        await Promise.all([unlink(staged).catch(() => undefined), unlink(metadata).catch(() => undefined)]);
      }
    });
  }

  async #initialize(): Promise<void> {
    if (this.#ready) return;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.#root);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(this.#root, await realpath(this.#root)) !== "") {
      throw new Error("Remote file cache root is not canonical.");
    }
    await chmod(this.#root, 0o700);
    for (const name of await readdir(this.#root)) if (STAGING.test(name)) await unlink(join(this.#root, name)).catch(() => undefined);
    await this.#scan();
    this.#ready = true;
  }

  async #entry(key: string): Promise<Entry | undefined> {
    const match = KEY.exec(`${key}.bin`);
    if (!match) return undefined;
    try {
      const metadataPath = join(this.#root, `${key}.json`), blobPath = join(this.#root, `${key}.bin`);
      const [metadataInfo, blob] = await Promise.all([lstat(metadataPath), lstat(blobPath)]);
      if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.size > 1024
        || !blob.isFile() || blob.isSymbolicLink() || blob.size > MAXIMUM_FILE_BYTES) return undefined;
      const handle = await open(metadataPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let value: unknown;
      try {
        const bytes = Buffer.alloc(1025);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 1024) return undefined;
        value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      } finally { await handle.close(); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const record = value as Record<string, unknown>;
      if (record.format !== 1 || record.size !== blob.size || typeof record.sha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(record.sha256) || Object.keys(record).length !== 3) return undefined;
      return { key, source: match[1]!, size: blob.size, sha256: record.sha256, lastUsed: blob.mtimeMs,
        diskBytes: blob.size + metadataInfo.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async #scan(): Promise<Entry[]> {
    const keys = new Set((await readdir(this.#root)).flatMap(name => {
      const match = KEY.exec(name); return match ? [`${match[1]}-${match[2]}`] : [];
    }));
    const result: Entry[] = [];
    for (const key of keys) {
      const entry = await this.#entry(key);
      if (entry) result.push(entry); else await this.#remove(key);
    }
    return result;
  }

  async #remove(key: string): Promise<void> {
    if (!KEY.test(`${key}.bin`)) return;
    await Promise.all(["bin", "json"].map(extension => unlink(join(this.#root, `${key}.${extension}`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (tails.get(this.#root) ?? Promise.resolve()).catch(() => undefined).then(operation);
    tails.set(this.#root, pending);
    try { return await pending; }
    finally { if (tails.get(this.#root) === pending) tails.delete(this.#root); }
  }
}

function valid(identity: RemoteFileCacheIdentity): boolean {
  return /^[a-f0-9]{64}$/.test(identity.source) && /^[a-f0-9]{64}$/.test(identity.version)
    && Number.isSafeInteger(identity.size) && identity.size >= 0 && identity.size <= MAXIMUM_FILE_BYTES;
}
