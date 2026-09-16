import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { DesktopOpenFileRequest, DesktopOpenFileResult } from "./channels.js";
import type { NativeFileActionScope } from "./native-file-clipboard.js";
import { atomicWritePrivateFile, ensurePrivateDirectory, readPrivateFile } from "./secure-files.js";

export const FILE_OPEN_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const FILE_OPEN_TOTAL_BYTES = 512 * 1024 * 1024;
export const FILE_OPEN_MAXIMUM_FILES = 32;
export const FILE_OPEN_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_REQUESTS = 1_024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

interface Entry {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly state: "prepared" | "retained";
  readonly retainUntil?: number;
}

interface Request {
  readonly scope: NativeFileActionScope;
  readonly digest: string;
  readonly abort: AbortController;
  readonly result: Promise<DesktopOpenFileResult>;
}

export interface NativeFileOpenerOptions {
  readonly directory: string;
  readonly openPath: (path: string) => Promise<string>;
  readonly now?: () => number;
}

/** A single app-owned materializer. Renderer requests never contain a path or URL. */
export class NativeFileOpener {
  readonly #options: NativeFileOpenerOptions;
  readonly #requests = new Map<string, Request>();
  readonly #now: () => number;
  readonly #manifest: string;
  #entries: Entry[] = [];
  #initialization: Promise<void> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #pendingBytes = 0;
  #pendingFiles = 0;
  #closed = false;

  constructor(options: NativeFileOpenerOptions) {
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory) {
      throw new Error("Opened-file storage must be an absolute private directory.");
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#manifest = join(options.directory, "files.json");
  }

  open(value: unknown, scope: NativeFileActionScope): Promise<DesktopOpenFileResult> {
    const input = parseDesktopOpenFileRequest(value);
    const key = `${scope.id}\0${input.requestId}`;
    const digest = createHash("sha256")
      .update(input.file.name)
      .update("\0")
      .update(input.file.mediaType)
      .update("\0")
      .update(input.file.bytes)
      .digest("hex");
    const existing = this.#requests.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        return Promise.reject(new TypeError("The file open request identity was reused with different content."));
      }
      return existing.result;
    }
    if (this.#closed || !scope.isCurrent()) return Promise.resolve({ status: "cancelled" });
    if (this.#requests.size >= MAXIMUM_REQUESTS || this.#pendingFiles >= FILE_OPEN_MAXIMUM_FILES ||
      this.#pendingBytes + input.file.bytes.byteLength > FILE_OPEN_TOTAL_BYTES) {
      return Promise.resolve({ status: "failed", reason: "capacity" });
    }
    const bytes = Uint8Array.from(input.file.bytes);
    const abort = new AbortController();
    this.#pendingBytes += bytes.byteLength;
    this.#pendingFiles += 1;
    const current = (): boolean => !this.#closed && !abort.signal.aborted && scope.isCurrent();
    const result = this.#tail.then(async (): Promise<DesktopOpenFileResult> => {
      if (!current()) return { status: "cancelled" };
      try {
        await this.#initialize();
        await this.#cleanExpired();
        if (!current()) return { status: "cancelled" };
        if (this.#entries.length + this.#pendingFiles > FILE_OPEN_MAXIMUM_FILES ||
          this.#entries.reduce((total, entry) => total + entry.bytes, 0) + this.#pendingBytes > FILE_OPEN_TOTAL_BYTES) {
          return { status: "failed", reason: "capacity" };
        }
        return await this.#execute(input.file.name, bytes, current);
      } catch {
        return { status: "failed", reason: "storage" };
      }
    }).finally(() => {
      this.#pendingBytes -= bytes.byteLength;
      this.#pendingFiles -= 1;
    });
    this.#tail = result.catch(() => undefined);
    this.#requests.set(key, { scope, digest, abort, result });
    return result;
  }

  cancel(requestId: string, scopeId: string): void {
    if (!UUID.test(requestId)) throw new TypeError("Invalid file open request identity.");
    this.#requests.get(`${scopeId}\0${requestId}`)?.abort.abort();
  }

  retireScope(scopeId: string): void {
    for (const request of this.#requests.values()) if (request.scope.id === scopeId) request.abort.abort();
  }

  cancelPending(): void {
    for (const request of this.#requests.values()) request.abort.abort();
  }

  dispose(): void {
    this.#closed = true;
    this.cancelPending();
  }

  async #initialize(): Promise<void> {
    this.#initialization ??= (async () => {
      await ensurePrivateDirectory(this.#options.directory);
      const bytes = await readPrivateFile(this.#manifest);
      this.#entries = bytes === undefined ? [] : parseManifest(bytes);
      await this.#cleanExpired();
    })();
    return this.#initialization;
  }

  async #persist(): Promise<void> {
    await atomicWritePrivateFile(this.#manifest, Buffer.from(JSON.stringify({ version: 1, entries: this.#entries })));
  }

  async #remove(entry: Entry): Promise<void> {
    const directory = join(this.#options.directory, entry.id);
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info !== undefined) {
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
        throw new Error("Opened-file directory changed.");
      }
      const path = join(directory, entry.name);
      const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (file !== undefined) {
        if (!file.isFile() || file.isSymbolicLink() || !samePath(await realpath(path), path)) {
          throw new Error("Opened file changed.");
        }
        await unlink(path);
      }
      // Never recursively discover or delete paths outside the exact manifest entry.
      await rmdir(directory);
    }
    this.#entries = this.#entries.filter((value) => value !== entry);
    await this.#persist();
  }

  async #cleanExpired(): Promise<void> {
    for (const entry of [...this.#entries]) {
      if (entry.state === "prepared" || (entry.retainUntil !== undefined && entry.retainUntil <= this.#now())) {
        await this.#remove(entry);
      }
    }
  }

  async #execute(name: string, bytes: Uint8Array, current: () => boolean): Promise<DesktopOpenFileResult> {
    let entry: Entry = { id: randomUUID(), name, bytes: bytes.byteLength, state: "prepared" };
    this.#entries.push(entry);
    await this.#persist();
    const directory = join(this.#options.directory, entry.id);
    const path = join(directory, name);
    let dispatched = false;
    let explicitFailure = false;
    try {
      await ensurePrivateDirectory(directory);
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      if (!current()) return { status: "cancelled" };
      const retained: Entry = { ...entry, state: "retained", retainUntil: this.#now() + FILE_OPEN_RETENTION_MS };
      this.#entries[this.#entries.indexOf(entry)] = retained;
      entry = retained;
      await this.#persist();
      if (!current()) return { status: "cancelled" };
      dispatched = true;
      let errorMessage: string;
      try {
        errorMessage = await this.#options.openPath(path);
      } catch {
        return { status: "unknown" };
      }
      if (errorMessage !== "") {
        explicitFailure = true;
        return { status: "failed", reason: "open" };
      }
      return { status: "opened" };
    } catch {
      return dispatched ? { status: "unknown" } : { status: "failed", reason: "storage" };
    } finally {
      if (!dispatched || explicitFailure) await this.#remove(entry).catch(() => undefined);
    }
  }
}

export function parseDesktopOpenFileRequest(value: unknown): DesktopOpenFileRequest {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "file,requestId" ||
    typeof value.requestId !== "string" || !UUID.test(value.requestId) || !isRecord(value.file)) {
    throw new TypeError("Invalid file open request.");
  }
  const file = value.file;
  if (Object.keys(file).sort().join(",") !== "bytes,mediaType,name" || typeof file.name !== "string" ||
    !safeFileName(file.name) || typeof file.mediaType !== "string" || file.mediaType.length > 255 ||
    !/^[\w.+-]+\/[\w.+-]+$/u.test(file.mediaType) || !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength > FILE_OPEN_MAXIMUM_BYTES) {
    throw new TypeError("Invalid file open payload.");
  }
  return { requestId: value.requestId, file: { name: file.name, mediaType: file.mediaType, bytes: file.bytes } };
}

function safeFileName(name: string): boolean {
  return name.length > 0 && name.trim() === name && Buffer.byteLength(name, "utf8") <= 240 &&
    !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(name) && !/[. ]$/u.test(name) && name !== "." && name !== ".." &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}

function parseManifest(bytes: Uint8Array): Entry[] {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > FILE_OPEN_MAXIMUM_FILES) {
    throw new Error("Invalid opened-file manifest.");
  }
  const ids = new Set<string>();
  let total = 0;
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !UUID.test(entry.id) || ids.has(entry.id) ||
      typeof entry.name !== "string" || !safeFileName(entry.name) || typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > FILE_OPEN_MAXIMUM_BYTES ||
      (entry.state !== "prepared" && entry.state !== "retained") ||
      (entry.state === "retained"
        ? typeof entry.retainUntil !== "number" || !Number.isSafeInteger(entry.retainUntil) || entry.retainUntil < 0
        : entry.retainUntil !== undefined)) {
      throw new Error("Invalid opened-file record.");
    }
    ids.add(entry.id);
    total += entry.bytes;
  }
  if (total > FILE_OPEN_TOTAL_BYTES) throw new Error("Opened-file manifest exceeds its capacity.");
  return value.entries as Entry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
