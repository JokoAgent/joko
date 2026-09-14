import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  statfs,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ExtensionLibraryLimits {
  readonly maximumReadBytes: number;
  readonly maximumWriteBytes: number;
  readonly maximumStreamBytes: number;
  readonly maximumPathCharacters: number;
  readonly maximumPathSegments: number;
  readonly maximumListPageSize: number;
  readonly maximumFiles: number;
  readonly softLimitBytes: number;
  readonly diskReserveBytes: number;
  readonly streamIdleMilliseconds: number;
}

export const EXTENSION_LIBRARY_LIMITS: ExtensionLibraryLimits = Object.freeze({
  maximumReadBytes: 16 * 1024 * 1024,
  maximumWriteBytes: 16 * 1024 * 1024,
  maximumStreamBytes: 8 * 1024 * 1024 * 1024,
  maximumPathCharacters: 512,
  maximumPathSegments: 32,
  maximumListPageSize: 500,
  maximumFiles: 50_000,
  softLimitBytes: 8 * 1024 * 1024 * 1024,
  diskReserveBytes: 1024 * 1024 * 1024,
  streamIdleMilliseconds: 5 * 60_000
});

export type ExtensionLibraryFailureCode =
  | "UNAVAILABLE"
  | "READ_ONLY"
  | "DISK_FULL"
  | "PATH_INVALID"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "TOO_LARGE"
  | "FILE_LIMIT"
  | "SQL_REJECTED"
  | "SQL_FAILED"
  | "RESULT_LIMIT"
  | "CONFLICT"
  | "CORRUPT"
  | "INTERNAL";

export class ExtensionLibraryError extends Error {
  constructor(
    readonly code: ExtensionLibraryFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExtensionLibraryError";
  }
}

export type ExtensionLibraryState = "ready" | "read_only" | "unavailable";

export interface ExtensionLibraryUsage {
  readonly files: number;
  readonly bytes: number;
  readonly revision: bigint;
}

export interface ExtensionLibraryStatus {
  readonly state: ExtensionLibraryState;
  readonly reason?: "metadata_corrupt" | "file_limit" | "io" | "operation_in_progress";
  readonly usage: ExtensionLibraryUsage;
  readonly diskFreeBytes?: number;
  readonly softLimitBytes: number;
  readonly softLimitExceeded: boolean;
  readonly orphaned: boolean;
}

export interface ExtensionLibraryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes: number;
  readonly modifiedAt: number;
}

export interface ExtensionLibraryReadResult {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ExtensionLibraryWriteResult {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface StoredLibraryMetadata {
  readonly format: 1;
  readonly extensionId: string;
  readonly createdAt: number;
  readonly revision: string;
  readonly orphaned?: { readonly at: number; readonly name: string };
}

interface StoredLibraryUsage {
  readonly format: 1;
  readonly files: number;
  readonly bytes: number;
  readonly revision: string;
  readonly updatedAt: number;
}

export interface TreeSnapshot {
  readonly entries: readonly ExtensionLibraryEntry[];
  readonly files: number;
  readonly bytes: number;
}

const HOST_DIRECTORY = ".joko-library";
const METADATA_FILE = "metadata.json";
const METADATA_PREVIOUS_FILE = "metadata.previous.json";
const USAGE_FILE = "usage.json";
const TEMP_DIRECTORY = "tmp";
const HOST_RECORD_MAXIMUM_BYTES = 1024 * 1024;
const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const DECIMAL_REVISION = /^(?:0|[1-9][0-9]*)$/u;
const PORTABLE_SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9_@.+ -]*$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SQLITE_SIDECAR = /\.sqlite-(?:wal|shm|journal)$/iu;

export interface ExtensionLibraryVaultOptions {
  readonly root: string;
  readonly extensionId: string;
  readonly now?: () => number;
  readonly freeBytes?: (root: string) => Promise<number | undefined>;
  readonly limits?: Partial<ExtensionLibraryLimits>;
  readonly beforeFilesystemMutation?: (
    operation: "write" | "staged_write" | "mkdir" | "delete" | "rename" | "sqlite"
  ) => void | Promise<void>;
}

/**
 * Owns one Library root. The hidden host directory is never addressable by an
 * Extension relative key; all mutation methods are serialized by the manager.
 */
export class ExtensionLibraryVault {
  readonly #root: string;
  readonly #extensionId: string;
  readonly #now: () => number;
  readonly #freeBytes: (root: string) => Promise<number | undefined>;
  readonly #limits: ExtensionLibraryLimits;
  readonly #beforeFilesystemMutation: NonNullable<ExtensionLibraryVaultOptions["beforeFilesystemMutation"]>;
  #metadata?: StoredLibraryMetadata;
  #rootIdentity?: BigIntStats;
  #usage: ExtensionLibraryUsage = { files: 0, bytes: 0, revision: 0n };
  #state: ExtensionLibraryState = "unavailable";
  #reason: ExtensionLibraryStatus["reason"] = "io";
  #readonly = false;
  #opened = false;

  constructor(options: ExtensionLibraryVaultOptions) {
    if (!isAbsolute(options.root)) throw new TypeError("Extension Library root must be absolute.");
    if (!EXTENSION_ID.test(options.extensionId)) throw new TypeError("Extension Library identity is invalid.");
    this.#root = resolve(options.root);
    this.#extensionId = options.extensionId;
    this.#now = options.now ?? Date.now;
    this.#freeBytes = options.freeBytes ?? filesystemFreeBytes;
    this.#limits = Object.freeze({ ...EXTENSION_LIBRARY_LIMITS, ...options.limits });
    this.#beforeFilesystemMutation = options.beforeFilesystemMutation ?? (() => undefined);
  }

  get root(): string {
    return this.#root;
  }

  get extensionId(): string {
    return this.#extensionId;
  }

  get limits(): ExtensionLibraryLimits {
    return this.#limits;
  }

  async open(options: { readonly create: boolean } = { create: true }): Promise<ExtensionLibraryStatus> {
    if (this.#opened) return this.status();
    const exists = await pathKind(this.#root);
    if (exists === "missing") {
      if (!options.create) {
        return this.#markUnavailable("io", "Extension Library root is missing.");
      }
      await mkdir(this.#root, { recursive: true });
    } else if (exists !== "directory") {
      return this.#markUnavailable("io", "Extension Library root is not a regular directory.");
    }
    await this.#assertRootIdentity();
    const hostRoot = this.#hostRoot();
    const metadataPath = join(hostRoot, METADATA_FILE);
    const metadataKind = await pathKind(metadataPath);
    if (metadataKind === "missing") {
      const tree = await scanTree(this.#root, this.#limits.maximumFiles);
      if (tree.files > 0 || tree.entries.some((entry) => entry.kind === "directory")) {
        return this.#markUnavailable("metadata_corrupt", "Extension Library metadata is missing from a non-empty root.");
      }
      if (!options.create) return this.#markUnavailable("metadata_corrupt", "Extension Library metadata is missing.");
      await mkdir(hostRoot, { recursive: true });
      this.#metadata = {
        format: 1,
        extensionId: this.#extensionId,
        createdAt: this.#now(),
        revision: "1"
      };
      await atomicJson(metadataPath, this.#metadata);
    } else if (metadataKind !== "file") {
      return this.#markUnavailable("metadata_corrupt", "Extension Library metadata is not a regular file.");
    } else {
      try {
        this.#metadata = validateMetadata(JSON.parse((await readBoundedRegularFile(metadataPath)).toString("utf8")), this.#extensionId);
      } catch (error) {
        return this.#markUnavailable("metadata_corrupt", "Extension Library metadata is corrupt.", error);
      }
    }
    let storedUsage: StoredLibraryUsage | undefined;
    try {
      storedUsage = validateUsage(JSON.parse((await readBoundedRegularFile(join(hostRoot, USAGE_FILE))).toString("utf8")));
    } catch {
      storedUsage = undefined;
    }
    try {
      const tree = await scanTree(this.#root, this.#limits.maximumFiles);
      const matches = storedUsage !== undefined && storedUsage.files === tree.files && storedUsage.bytes === tree.bytes;
      this.#usage = {
        files: tree.files,
        bytes: tree.bytes,
        revision: matches && storedUsage !== undefined
          ? BigInt(storedUsage.revision)
          : BigInt(storedUsage?.revision ?? "0") + 1n
      };
      if (!matches) await this.#persistUsage();
    } catch (error) {
      if (error instanceof ExtensionLibraryError && error.code === "FILE_LIMIT") {
        return this.#markUnavailable("file_limit", error.message, error);
      }
      return this.#markUnavailable("io", "Extension Library usage could not be reconciled.", error);
    }
    this.#opened = true;
    this.#state = this.#readonly ? "read_only" : "ready";
    this.#reason = this.#readonly ? "operation_in_progress" : undefined;
    await this.#removeExpiredTemps().catch(() => undefined);
    return this.status();
  }

  async status(): Promise<ExtensionLibraryStatus> {
    const free = await this.#freeBytes(this.#root).catch(() => undefined);
    return {
      state: this.#state,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      usage: { ...this.#usage },
      ...(free === undefined ? {} : { diskFreeBytes: free }),
      softLimitBytes: this.#limits.softLimitBytes,
      softLimitExceeded: this.#usage.bytes > this.#limits.softLimitBytes,
      orphaned: this.#metadata?.orphaned !== undefined
    };
  }

  setReadonly(readonly: boolean): void {
    this.#readonly = readonly;
    if (this.#state === "unavailable") return;
    this.#state = readonly ? "read_only" : "ready";
    this.#reason = readonly ? "operation_in_progress" : undefined;
  }

  async markOrphaned(name: string): Promise<void> {
    await this.#requireOpen();
    if (this.#metadata === undefined || this.#metadata.orphaned !== undefined) return;
    await this.#replaceMetadata({
      ...this.#metadata,
      revision: incrementRevision(this.#metadata.revision),
      orphaned: { at: this.#now(), name: boundedLabel(name) }
    });
  }

  async clearOrphaned(): Promise<void> {
    await this.#requireOpen();
    if (this.#metadata === undefined || this.#metadata.orphaned === undefined) return;
    const { orphaned: _orphaned, ...base } = this.#metadata;
    await this.#replaceMetadata({ ...base, revision: incrementRevision(base.revision) });
  }

  async repairMetadata(): Promise<ExtensionLibraryStatus> {
    await this.#assertRootIdentity();
    if (this.#state !== "unavailable" || this.#reason !== "metadata_corrupt") {
      throw new ExtensionLibraryError("CONFLICT", "Extension Library metadata is not awaiting repair.");
    }
    const previousPath = join(this.#hostRoot(), METADATA_PREVIOUS_FILE);
    const metadataPath = join(this.#hostRoot(), METADATA_FILE);
    let metadata: StoredLibraryMetadata;
    try {
      metadata = validateMetadata(JSON.parse((await readBoundedRegularFile(previousPath)).toString("utf8")), this.#extensionId);
    } catch {
      await scanTree(this.#root, this.#limits.maximumFiles);
      metadata = {
        format: 1,
        extensionId: this.#extensionId,
        createdAt: this.#now(),
        revision: "1"
      };
    }
    await mkdir(this.#hostRoot(), { recursive: true });
    const damagedKind = await pathKind(metadataPath);
    if (damagedKind === "file") {
      const damaged = await readBoundedRegularFile(metadataPath);
      await atomicBytes(join(this.#hostRoot(), `metadata.corrupt.${this.#now()}.${randomUUID()}.json`), damaged);
    } else if (damagedKind !== "missing") {
      const damaged = await lstat(metadataPath, { bigint: true });
      const preserved = join(this.#hostRoot(), `metadata.corrupt.${this.#now()}.${randomUUID()}`);
      await rename(metadataPath, preserved);
      const after = await lstat(preserved, { bigint: true });
      if (!sameFilesystemObject(damaged, after)) {
        throw new ExtensionLibraryError("CONFLICT", "Damaged Library metadata changed while it was preserved.");
      }
      await syncDirectory(this.#hostRoot());
    }
    await atomicJson(metadataPath, metadata);
    this.#metadata = metadata;
    this.#opened = false;
    this.#state = "unavailable";
    this.#reason = "io";
    return this.open({ create: true });
  }

  async read(input: { readonly path: string; readonly offset?: number; readonly length?: number }): Promise<ExtensionLibraryReadResult> {
    await this.#requireReady(false);
    const relativePath = validateExtensionLibraryPath(input.path, this.#limits);
    const target = await this.#resolveExisting(relativePath, "file");
    const before = await lstat(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new ExtensionLibraryError("NOT_FOUND", "Library file was not found.");
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number(before.size)) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library read offset is invalid.");
    }
    const requested = input.length ?? Number(before.size) - offset;
    if (!Number.isSafeInteger(requested) || requested < 0 || requested > this.#limits.maximumReadBytes) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library read exceeds the 16 MiB boundary.");
    }
    const length = Math.min(requested, Number(before.size) - offset);
    let handle: FileHandle | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened)) throw new ExtensionLibraryError("CONFLICT", "Library file changed while it was opened.");
      const bytes = Buffer.alloc(length);
      let consumed = 0;
      while (consumed < length) {
        const result = await handle.read(bytes, consumed, length - consumed, offset + consumed);
        if (result.bytesRead === 0) break;
        consumed += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      await this.#resolveExisting(relativePath, "file");
      const pathAfter = await lstat(target, { bigint: true });
      if (consumed !== length || !sameFile(opened, after) || !sameFile(after, pathAfter)) {
        throw new ExtensionLibraryError("CONFLICT", "Library file changed while it was read.");
      }
      const result = bytes.subarray(0, consumed);
      return { path: relativePath, bytes: result, sha256: sha256(result) };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async write(input: {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly ifNotExists?: boolean;
  }): Promise<ExtensionLibraryWriteResult> {
    await this.#requireReady(true);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > this.#limits.maximumWriteBytes) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library write exceeds the 16 MiB boundary.");
    }
    const relativePath = validateExtensionLibraryPath(input.path, this.#limits);
    await this.#diskGate(input.bytes.byteLength);
    const target = await this.#resolveForWrite(relativePath, false);
    const existing = await pathKind(target);
    if (existing !== "missing" && existing !== "file") {
      throw new ExtensionLibraryError("PATH_INVALID", "Library write target is not a regular file.");
    }
    if (existing === "file" && input.ifNotExists === true) {
      throw new ExtensionLibraryError("ALREADY_EXISTS", "Library file already exists.");
    }
    if (existing === "missing" && this.#usage.files >= this.#limits.maximumFiles) {
      throw new ExtensionLibraryError("FILE_LIMIT", "Extension Library file-count fuse was exceeded.");
    }
    const existingIdentity = existing === "file" ? await regularFileSnapshot(target) : undefined;
    const bytes = Buffer.from(input.bytes);
    const resultHash = sha256(bytes);
    const temporary = join(this.#hostRoot(), TEMP_DIRECTORY, `${randomUUID()}.write`);
    await mkdir(dirname(temporary), { recursive: true });
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      const stagedIdentity = await handle.stat({ bigint: true });
      await handle.close();
      handle = undefined;
      await this.#beforeFilesystemMutation("write");
      await this.#resolveForWrite(relativePath, true);
      await assertPathSnapshot(target, existingIdentity);
      await placeStagedFile(temporary, target, stagedIdentity, existingIdentity !== undefined);
      await this.#resolveExisting(relativePath, "file");
      const after = await lstat(target, { bigint: true });
      if (!after.isFile() || after.isSymbolicLink() || after.size !== BigInt(bytes.byteLength)
        || !sameFilesystemObject(stagedIdentity, after)) {
        throw new ExtensionLibraryError("INTERNAL", "Library write could not be verified.");
      }
      await this.reconcileUsage();
      return { path: relativePath, bytes: bytes.byteLength, sha256: resultHash };
    } catch (error) {
      if (isNoSpace(error)) throw new ExtensionLibraryError("DISK_FULL", "Library disk space is exhausted.", { cause: error });
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async stat(path: string): Promise<ExtensionLibraryEntry> {
    await this.#requireReady(false);
    const relativePath = validateExtensionLibraryPath(path, this.#limits);
    const target = await this.#resolveExisting(relativePath);
    const value = await lstat(target, { bigint: true });
    if (value.isSymbolicLink() || !value.isFile() && !value.isDirectory()) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library entry is not a regular file or directory.");
    }
    return {
      path: relativePath,
      kind: value.isDirectory() ? "directory" : "file",
      bytes: value.isFile() ? safeNumber(value.size) : 0,
      modifiedAt: safeNumber(value.mtimeMs)
    };
  }

  async list(input: {
    readonly path?: string;
    readonly recursive?: boolean;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<{ readonly entries: readonly ExtensionLibraryEntry[]; readonly nextCursor?: string }> {
    await this.#requireReady(false);
    const prefix = input.path === undefined || input.path === ""
      ? ""
      : validateExtensionLibraryPath(input.path, this.#limits);
    const limit = input.limit ?? this.#limits.maximumListPageSize;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.#limits.maximumListPageSize) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library list page size is invalid.");
    }
    if (prefix !== "") await this.#resolveExisting(prefix, "directory");
    const tree = await scanTree(this.#root, this.#limits.maximumFiles);
    const candidates = tree.entries.filter((entry) => {
      if (prefix === "") return input.recursive === true || !entry.path.includes("/");
      if (!entry.path.startsWith(`${prefix}/`)) return false;
      return input.recursive === true || !entry.path.slice(prefix.length + 1).includes("/");
    });
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = parseCursor(input.cursor);
      if (cursor.revision !== this.#usage.revision.toString(10) || cursor.prefix !== prefix
        || cursor.recursive !== (input.recursive === true)) {
        throw new ExtensionLibraryError("CONFLICT", "Library list cursor is stale.");
      }
      offset = cursor.offset;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > candidates.length) {
        throw new ExtensionLibraryError("PATH_INVALID", "Library list cursor is invalid.");
      }
    }
    const entries = candidates.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    return {
      entries,
      ...(nextOffset >= candidates.length ? {} : {
        nextCursor: encodeCursor({
          revision: this.#usage.revision.toString(10),
          prefix,
          recursive: input.recursive === true,
          offset: nextOffset
        })
      })
    };
  }

  async mkdir(path: string): Promise<{ readonly path: string; readonly existed: boolean }> {
    await this.#requireReady(true);
    const relativePath = validateExtensionLibraryPath(path, this.#limits);
    await this.#diskGate(0);
    const target = await this.#resolveForWrite(relativePath, false);
    const existing = await pathKind(target);
    if (existing === "file" || existing === "other") {
      throw new ExtensionLibraryError("PATH_INVALID", "Library directory target is not a directory.");
    }
    if (existing === "missing") {
      await this.#beforeFilesystemMutation("mkdir");
      await this.#resolveForWrite(relativePath, true);
      await mkdir(target, { recursive: true });
    }
    await this.#resolveExisting(relativePath, "directory");
    await this.reconcileUsage();
    return { path: relativePath, existed: existing === "directory" };
  }

  async delete(path: string, recursive = false): Promise<{ readonly path: string; readonly existed: boolean }> {
    await this.#requireReady(true);
    const relativePath = validateExtensionLibraryPath(path, this.#limits);
    const target = join(this.#root, ...relativePath.split("/"));
    const kind = await pathKind(target);
    if (kind === "missing") return { path: relativePath, existed: false };
    await this.#resolveExisting(relativePath);
    const before = await supportedEntrySnapshot(target);
    if (kind === "directory") {
      const nested = await scanTree(target, this.#limits.maximumFiles, false);
      if (!recursive && nested.entries.length > 0) {
        throw new ExtensionLibraryError("CONFLICT", "Library directory is not empty.");
      }
      await this.#beforeFilesystemMutation("delete");
      await this.#resolveExisting(relativePath, "directory");
      await assertPathSnapshot(target, before);
      if (recursive) await rm(target, { recursive: true, force: false });
      else await rmdir(target);
    } else if (kind === "file") {
      await this.#beforeFilesystemMutation("delete");
      await this.#resolveExisting(relativePath, "file");
      await assertPathSnapshot(target, before);
      await unlink(target);
    } else {
      throw new ExtensionLibraryError("PATH_INVALID", "Library entry is not removable.");
    }
    if (await pathKind(target) !== "missing") {
      throw new ExtensionLibraryError("CONFLICT", "Library entry changed while it was removed.");
    }
    await this.reconcileUsage();
    return { path: relativePath, existed: true };
  }

  async rename(input: {
    readonly from: string;
    readonly to: string;
    readonly overwrite?: boolean;
  }): Promise<{ readonly from: string; readonly to: string }> {
    await this.#requireReady(true);
    const from = validateExtensionLibraryPath(input.from, this.#limits);
    const to = validateExtensionLibraryPath(input.to, this.#limits);
    if (from === to || to.startsWith(`${from}/`)) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library rename target is invalid.");
    }
    const source = await this.#resolveExisting(from);
    const sourceKind = await pathKind(source);
    if (sourceKind !== "file" && sourceKind !== "directory") {
      throw new ExtensionLibraryError("PATH_INVALID", "Library rename source is not a supported entry.");
    }
    const sourceIdentity = await supportedEntrySnapshot(source);
    if (sourceKind === "directory") await scanTree(source, this.#limits.maximumFiles, false);
    const target = await this.#resolveForWrite(to, false);
    const targetKind = await pathKind(target);
    const targetIdentity = targetKind === "file" || targetKind === "directory"
      ? await supportedEntrySnapshot(target)
      : undefined;
    if (targetKind !== "missing") {
      if (input.overwrite !== true) throw new ExtensionLibraryError("ALREADY_EXISTS", "Library rename target exists.");
      await this.#resolveExisting(to);
      if (sourceKind !== "file" || targetKind !== "file") {
        throw new ExtensionLibraryError("CONFLICT", "Library directory replacement is not supported.");
      }
    }
    await this.#beforeFilesystemMutation("rename");
    await this.#resolveExisting(from, sourceKind);
    await this.#resolveForWrite(to, true);
    await Promise.all([
      assertPathSnapshot(source, sourceIdentity),
      assertPathSnapshot(target, targetIdentity)
    ]);
    await rename(source, target);
    const after = await supportedEntrySnapshot(await this.#resolveExisting(to, sourceKind));
    if (!sameFilesystemObject(sourceIdentity, after) || await pathKind(source) !== "missing") {
      throw new ExtensionLibraryError("CONFLICT", "Library rename could not be identity-fenced into place.");
    }
    await syncDirectory(dirname(target));
    await this.reconcileUsage();
    return { from, to };
  }

  async reconcileUsage(): Promise<ExtensionLibraryUsage> {
    await this.#requireOpen();
    const tree = await scanTree(this.#root, this.#limits.maximumFiles);
    this.#usage = {
      files: tree.files,
      bytes: tree.bytes,
      revision: this.#usage.revision + 1n
    };
    await this.#persistUsage();
    return { ...this.#usage };
  }

  async snapshot(): Promise<TreeSnapshot> {
    await this.#requireReady(false);
    return scanTree(this.#root, this.#limits.maximumFiles);
  }

  async resolveDatabasePath(
    path: string,
    options: { readonly write?: boolean; readonly create?: boolean; readonly prepare?: boolean } = {}
  ): Promise<string> {
    const write = options.write === true || options.create === true;
    await this.#requireReady(write);
    const relativePath = validateExtensionLibraryPath(path, this.#limits);
    if (!relativePath.toLowerCase().endsWith(".sqlite")) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library database path must end in .sqlite.");
    }
    if (!options.create) {
      const target = await this.#resolveExisting(relativePath, "file");
      if (write) await this.#diskGate(0);
      return target;
    }
    await this.#diskGate(0);
    const target = await this.#resolveForWrite(relativePath, options.prepare === true);
    const existing = await pathKind(target);
    if (existing === "directory" || existing === "other") {
      throw new ExtensionLibraryError("PATH_INVALID", "Library database target is not a regular file.");
    }
    if (existing === "missing" && this.#usage.files >= this.#limits.maximumFiles) {
      throw new ExtensionLibraryError("FILE_LIMIT", "Extension Library file-count fuse was exceeded.");
    }
    return target;
  }

  async assertWritable(incomingBytes = 0): Promise<void> {
    await this.#requireReady(true);
    if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library capacity request is invalid.");
    }
    await this.#diskGate(incomingBytes);
  }

  async assertMutationAuthority(operation: "sqlite"): Promise<void> {
    await this.#requireReady(true);
    await this.#beforeFilesystemMutation(operation);
  }

  async allocateTemporaryPath(suffix: ".sqlite-backup" | ".stream"): Promise<string> {
    await this.#requireReady(true);
    const root = join(this.#hostRoot(), TEMP_DIRECTORY);
    await mkdir(root, { recursive: true });
    return join(root, `${randomUUID()}${suffix}`);
  }

  async commitStagedWrite(input: {
    readonly temporaryPath: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly ifNotExists?: boolean;
  }): Promise<ExtensionLibraryWriteResult> {
    await this.#requireReady(true);
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > this.#limits.maximumStreamBytes
      || !/^[a-f0-9]{64}$/u.test(input.sha256)) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library staged write metadata is invalid.");
    }
    const temporary = this.#assertOwnedTemporaryPath(input.temporaryPath, ".stream");
    const before = await lstat(temporary, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(input.bytes)) {
      throw new ExtensionLibraryError("CONFLICT", "Library staged write identity or size changed.");
    }
    if (await hashOpenFile(temporary, before) !== input.sha256) {
      throw new ExtensionLibraryError("CORRUPT", "Library staged write hash did not match its declared content.");
    }
    return this.#commitVerifiedStagedWrite({
      temporary,
      path: input.path,
      bytes: input.bytes,
      sha256: input.sha256,
      before,
      ifNotExists: input.ifNotExists === true
    });
  }

  async commitSqliteBackup(temporaryPath: string, path: string): Promise<ExtensionLibraryWriteResult> {
    await this.#requireReady(true);
    const relativePath = validateExtensionLibraryPath(path, this.#limits);
    if (!relativePath.toLowerCase().endsWith(".sqlite")) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library database backup path must end in .sqlite.");
    }
    const temporary = this.#assertOwnedTemporaryPath(temporaryPath, ".sqlite-backup");
    const before = await regularFileSnapshot(temporary);
    if (before.size > BigInt(this.#limits.maximumStreamBytes)) {
      throw new ExtensionLibraryError("TOO_LARGE", "Library database backup exceeds the 8 GiB boundary.");
    }
    const bytes = safeNumber(before.size);
    const digest = await hashOpenFile(temporary, before);
    return this.#commitVerifiedStagedWrite({
      temporary,
      path: relativePath,
      bytes,
      sha256: digest,
      before,
      ifNotExists: true
    });
  }

  async #commitVerifiedStagedWrite(input: {
    readonly temporary: string;
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly before: BigIntStats;
    readonly ifNotExists: boolean;
  }): Promise<ExtensionLibraryWriteResult> {
    const relativePath = validateExtensionLibraryPath(input.path, this.#limits);
    const target = await this.#resolveForWrite(relativePath, false);
    const existing = await pathKind(target);
    if (existing !== "missing" && existing !== "file") {
      throw new ExtensionLibraryError("PATH_INVALID", "Library staged write target is not a regular file.");
    }
    if (existing === "file" && input.ifNotExists) {
      throw new ExtensionLibraryError("ALREADY_EXISTS", "Library file already exists.");
    }
    if (existing === "missing" && this.#usage.files >= this.#limits.maximumFiles) {
      throw new ExtensionLibraryError("FILE_LIMIT", "Extension Library file-count fuse was exceeded.");
    }
    const existingIdentity = existing === "file" ? await regularFileSnapshot(target) : undefined;
    await this.#beforeFilesystemMutation("staged_write");
    await this.#resolveForWrite(relativePath, true);
    await Promise.all([
      assertPathSnapshot(input.temporary, input.before),
      assertPathSnapshot(target, existingIdentity)
    ]);
    await placeStagedFile(input.temporary, target, input.before, existingIdentity !== undefined);
    await this.#resolveExisting(relativePath, "file");
    const after = await lstat(target, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.size !== input.before.size
      || !sameFilesystemObject(input.before, after)) {
      throw new ExtensionLibraryError("CONFLICT", "Library staged write could not be identity-fenced into place.");
    }
    await this.reconcileUsage();
    return { path: relativePath, bytes: input.bytes, sha256: input.sha256 };
  }

  async discardTemporaryPath(temporaryPath: string, suffix: ".sqlite-backup" | ".stream"): Promise<void> {
    const temporary = this.#assertOwnedTemporaryPath(temporaryPath, suffix);
    await unlink(temporary).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }

  async #replaceMetadata(metadata: StoredLibraryMetadata): Promise<void> {
    const path = join(this.#hostRoot(), METADATA_FILE);
    const previous = join(this.#hostRoot(), METADATA_PREVIOUS_FILE);
    await mkdir(this.#hostRoot(), { recursive: true });
    try {
      await atomicBytes(previous, await readBoundedRegularFile(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicJson(path, metadata);
    this.#metadata = metadata;
  }

  async #persistUsage(): Promise<void> {
    await mkdir(this.#hostRoot(), { recursive: true });
    await atomicJson(join(this.#hostRoot(), USAGE_FILE), {
      format: 1,
      files: this.#usage.files,
      bytes: this.#usage.bytes,
      revision: this.#usage.revision.toString(10),
      updatedAt: this.#now()
    } satisfies StoredLibraryUsage);
  }

  async #requireOpen(): Promise<void> {
    if (!this.#opened) await this.open({ create: true });
    if (this.#state === "unavailable") {
      throw new ExtensionLibraryError(this.#reason === "metadata_corrupt" ? "CORRUPT" : "UNAVAILABLE", "Extension Library is unavailable.");
    }
  }

  async #requireReady(write: boolean): Promise<void> {
    await this.#requireOpen();
    if (write && (this.#readonly || this.#state === "read_only")) {
      throw new ExtensionLibraryError("READ_ONLY", "Extension Library is temporarily read-only.");
    }
    await this.#assertRootIdentity();
  }

  async #diskGate(incomingBytes: number): Promise<void> {
    const free = await this.#freeBytes(this.#root).catch(() => undefined);
    if (free !== undefined && free - incomingBytes < this.#limits.diskReserveBytes) {
      throw new ExtensionLibraryError("DISK_FULL", "Extension Library disk reserve would be exhausted.");
    }
  }

  async #assertRootIdentity(): Promise<void> {
    let info: BigIntStats;
    try {
      info = await lstat(this.#root, { bigint: true });
    } catch (error) {
      if (isMissing(error)) throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library root is missing.", { cause: error });
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library root identity is invalid.");
    }
    const canonical = await realpath(this.#root);
    if (resolve(canonical) !== this.#root) {
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library root moved through an alias.");
    }
    if (this.#rootIdentity === undefined) this.#rootIdentity = info;
    else if (!sameFilesystemObject(this.#rootIdentity, info)) {
      throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library root was replaced.");
    }
  }

  async #resolveExisting(relativePath: string, expected?: "file" | "directory"): Promise<string> {
    const target = join(this.#root, ...relativePath.split("/"));
    await assertSafeAncestry(this.#root, target, true);
    const kind = await pathKind(target);
    if (kind === "missing") throw new ExtensionLibraryError("NOT_FOUND", "Library entry was not found.");
    await assertSafeAncestry(this.#root, target, false);
    if (kind === "other" || expected !== undefined && kind !== expected) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library entry has an unexpected type.");
    }
    const canonicalRoot = resolve(await realpath(this.#root));
    const canonicalTarget = resolve(await realpath(target));
    if (!inside(canonicalRoot, canonicalTarget)) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library entry escaped its canonical root.");
    }
    return target;
  }

  async #resolveForWrite(relativePath: string, createParent: boolean): Promise<string> {
    const target = join(this.#root, ...relativePath.split("/"));
    await assertSafeAncestry(this.#root, target, true);
    if (createParent) await mkdir(dirname(target), { recursive: true });
    await assertSafeAncestry(this.#root, target, true);
    const kind = await pathKind(target);
    if (kind === "other") throw new ExtensionLibraryError("PATH_INVALID", "Library target is not a regular file or directory.");
    return target;
  }

  #hostRoot(): string {
    return join(this.#root, HOST_DIRECTORY);
  }

  #assertOwnedTemporaryPath(temporaryPath: string, suffix: ".sqlite-backup" | ".stream"): string {
    const expectedRoot = resolve(this.#hostRoot(), TEMP_DIRECTORY);
    const candidate = resolve(temporaryPath);
    if (dirname(candidate) !== expectedRoot || !basename(candidate).endsWith(suffix)
      || !/^[a-f0-9-]{36}\.(?:sqlite-backup|stream)$/u.test(basename(candidate))) {
      throw new ExtensionLibraryError("PATH_INVALID", "Library temporary path is not host-owned.");
    }
    return candidate;
  }

  #markUnavailable(reason: ExtensionLibraryStatus["reason"], message: string, cause?: unknown): ExtensionLibraryStatus {
    this.#opened = true;
    this.#state = "unavailable";
    this.#reason = reason;
    if (cause !== undefined && !(cause instanceof Error)) void message;
    return {
      state: "unavailable",
      ...(reason === undefined ? {} : { reason }),
      usage: { ...this.#usage },
      softLimitBytes: this.#limits.softLimitBytes,
      softLimitExceeded: false,
      orphaned: false
    };
  }

  async #removeExpiredTemps(): Promise<void> {
    const root = join(this.#hostRoot(), TEMP_DIRECTORY);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const cutoff = this.#now() - 24 * 60 * 60_000;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      const info = await lstat(path).catch(() => undefined);
      if (info !== undefined && info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
    }
  }
}

export function validateExtensionLibraryPath(
  value: unknown,
  limits: ExtensionLibraryLimits = EXTENSION_LIBRARY_LIMITS
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limits.maximumPathCharacters
    || value !== value.trim() || value.includes("\\") || value.includes(":") || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)) {
    throw new ExtensionLibraryError("PATH_INVALID", "Library path must be a portable relative key.");
  }
  const segments = value.split("/");
  if (segments.length > limits.maximumPathSegments || segments.some((segment) => segment === "" || segment === "."
    || segment === ".." || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ")
    || !PORTABLE_SEGMENT.test(segment) || WINDOWS_RESERVED.test(segment) || SQLITE_SIDECAR.test(segment))) {
    throw new ExtensionLibraryError("PATH_INVALID", "Library path contains an invalid segment.");
  }
  return value;
}

export async function filesystemFreeBytes(root: string): Promise<number | undefined> {
  try {
    const value = await statfs(root, { bigint: true });
    const bytes = value.bsize * value.bavail;
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes);
  } catch {
    return undefined;
  }
}

async function scanTree(root: string, maximumFiles: number, excludeHost = true): Promise<TreeSnapshot> {
  const entries: ExtensionLibraryEntry[] = [];
  const observed: Array<{ readonly path: string; readonly snapshot: BigIntStats }> = [];
  let files = 0;
  let bytes = 0;
  const canonicalRoot = resolve(await realpath(root));
  const rootSnapshot = await supportedEntrySnapshot(root);
  if (!rootSnapshot.isDirectory()) throw new ExtensionLibraryError("CORRUPT", "Library scan root is not a regular directory.");
  const pending = [{ path: root, snapshot: rootSnapshot }];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await assertPathSnapshot(directory.path, directory.snapshot);
    const canonicalDirectory = resolve(await realpath(directory.path));
    if (!inside(canonicalRoot, canonicalDirectory)) {
      throw new ExtensionLibraryError("CORRUPT", "Library scan escaped its canonical root.");
    }
    const children = await readdir(directory.path, { withFileTypes: true });
    await assertPathSnapshot(directory.path, directory.snapshot);
    observed.push(directory);
    for (const child of children) {
      if (excludeHost && directory.path === root && child.name === HOST_DIRECTORY) continue;
      const path = join(directory.path, child.name);
      const relativePath = relative(root, path).split(sep).join("/");
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) {
        throw new ExtensionLibraryError("CORRUPT", `Library tree contains an unsupported entry: ${relativePath}`);
      }
      const canonical = resolve(await realpath(path));
      if (!inside(canonicalRoot, canonical)) {
        throw new ExtensionLibraryError("CORRUPT", `Library tree escaped its canonical root: ${relativePath}`);
      }
      if (info.isDirectory()) {
        assertPortableTreePath(relativePath);
        entries.push({ path: relativePath, kind: "directory", bytes: 0, modifiedAt: safeNumber(info.mtimeMs) });
        pending.push({ path, snapshot: info });
        continue;
      }
      observed.push({ path, snapshot: info });
      if (SQLITE_SIDECAR.test(child.name)) {
        const databasePath = path.replace(/-(?:wal|shm|journal)$/iu, "");
        assertPortableTreePath(relative(root, databasePath).split(sep).join("/"));
        const database = await lstat(databasePath).catch(() => undefined);
        if (database === undefined || database.isSymbolicLink() || !database.isFile()) {
          throw new ExtensionLibraryError("CORRUPT", `Library tree contains an unowned SQLite sidecar: ${relativePath}`);
        }
        continue;
      }
      assertPortableTreePath(relativePath);
      files += 1;
      if (files > maximumFiles) throw new ExtensionLibraryError("FILE_LIMIT", "Extension Library file-count fuse was exceeded.");
      const size = safeNumber(info.size);
      bytes = safeAdd(bytes, size);
      entries.push({ path: relativePath, kind: "file", bytes: size, modifiedAt: safeNumber(info.mtimeMs) });
    }
  }
  for (const entry of observed) await assertPathSnapshot(entry.path, entry.snapshot);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { entries, files, bytes };
}

async function assertSafeAncestry(root: string, target: string, allowMissing: boolean): Promise<void> {
  const canonicalRoot = await realpath(root);
  const lexical = resolve(target);
  if (!inside(root, lexical) || lexical === resolve(root)) {
    throw new ExtensionLibraryError("PATH_INVALID", "Library path escaped its root.");
  }
  let cursor = lexical;
  const chain: string[] = [];
  while (cursor !== resolve(root)) {
    chain.push(cursor);
    cursor = dirname(cursor);
  }
  chain.reverse();
  for (const entry of chain) {
    try {
      const info = await lstat(entry);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) {
        throw new ExtensionLibraryError("PATH_INVALID", "Library path crosses an unsupported filesystem object.");
      }
      const canonical = await realpath(entry);
      if (!inside(canonicalRoot, canonical)) {
        throw new ExtensionLibraryError("PATH_INVALID", "Library path escaped its canonical root.");
      }
    } catch (error) {
      if (isMissing(error) && allowMissing) continue;
      throw error;
    }
  }
}

async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "other"> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink()) return "other";
    if (value.isFile()) return "file";
    if (value.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicBytes(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

async function atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBoundedRegularFile(path: string): Promise<Buffer> {
  const expected = await regularFileSnapshot(path);
  if (expected.size > BigInt(HOST_RECORD_MAXIMUM_BYTES)) {
    throw new ExtensionLibraryError("CORRUPT", "Library host record exceeds its size boundary.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(expected, opened)) throw new ExtensionLibraryError("CONFLICT", "Library host record changed while it was opened.");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await regularFileSnapshot(path);
    if (offset !== bytes.byteLength || !sameFile(opened, after) || !sameFile(after, pathAfter)) {
      throw new ExtensionLibraryError("CONFLICT", "Library host record changed while it was read.");
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function supportedEntrySnapshot(path: string): Promise<BigIntStats> {
  const value = await lstat(path, { bigint: true });
  if (value.isSymbolicLink() || !value.isFile() && !value.isDirectory()) {
    throw new ExtensionLibraryError("PATH_INVALID", "Library entry is not a regular file or directory.");
  }
  return value;
}

async function regularFileSnapshot(path: string): Promise<BigIntStats> {
  const value = await supportedEntrySnapshot(path);
  if (!value.isFile()) throw new ExtensionLibraryError("PATH_INVALID", "Library entry is not a regular file.");
  return value;
}

async function assertPathSnapshot(path: string, expected: BigIntStats | undefined): Promise<void> {
  if (expected === undefined) {
    if (await pathKind(path) !== "missing") {
      throw new ExtensionLibraryError("CONFLICT", "Library path changed concurrently.");
    }
    return;
  }
  let current: BigIntStats;
  try {
    current = await supportedEntrySnapshot(path);
  } catch (error) {
    if (isMissing(error) || error instanceof ExtensionLibraryError && error.code === "PATH_INVALID") {
      throw new ExtensionLibraryError("CONFLICT", "Library path changed concurrently.", { cause: error });
    }
    throw error;
  }
  if (!sameEntrySnapshot(expected, current)) {
    throw new ExtensionLibraryError("CONFLICT", "Library path changed concurrently.");
  }
}

function assertPortableTreePath(path: string): void {
  try {
    validateExtensionLibraryPath(path);
  } catch (error) {
    throw new ExtensionLibraryError("CORRUPT", `Library tree contains a non-portable entry: ${path}`, { cause: error });
  }
}

async function placeStagedFile(
  temporary: string,
  target: string,
  stagedIdentity: BigIntStats,
  replacing: boolean
): Promise<void> {
  await assertPathSnapshot(temporary, stagedIdentity);
  if (replacing) {
    await rename(temporary, target);
  } else {
    try {
      await link(temporary, target);
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ExtensionLibraryError("CONFLICT", "Library write target appeared concurrently.", { cause: error });
      }
      throw error;
    }
    await unlink(temporary);
  }
  await syncDirectory(dirname(target));
}

function validateMetadata(value: unknown, extensionId: string): StoredLibraryMetadata {
  if (!plainObject(value) || !exactKeys(value, ["format", "extensionId", "createdAt", "revision", "orphaned"])
    || value.format !== 1 || value.extensionId !== extensionId || !Number.isSafeInteger(value.createdAt)
    || typeof value.revision !== "string" || !DECIMAL_REVISION.test(value.revision)) {
    throw new Error("Extension Library metadata has an invalid current-v1 shape.");
  }
  let orphaned: StoredLibraryMetadata["orphaned"];
  if (value.orphaned !== undefined) {
    if (!plainObject(value.orphaned) || !exactKeys(value.orphaned, ["at", "name"])
      || !Number.isSafeInteger(value.orphaned.at) || typeof value.orphaned.name !== "string"
      || value.orphaned.name.length === 0 || value.orphaned.name.length > 256) throw new Error("Extension Library orphan record is invalid.");
    orphaned = { at: value.orphaned.at as number, name: value.orphaned.name };
  }
  return {
    format: 1,
    extensionId,
    createdAt: value.createdAt as number,
    revision: value.revision,
    ...(orphaned === undefined ? {} : { orphaned })
  };
}

function validateUsage(value: unknown): StoredLibraryUsage {
  if (!plainObject(value) || !exactKeys(value, ["format", "files", "bytes", "revision", "updatedAt"])
    || value.format !== 1 || !safeNonnegative(value.files) || !safeNonnegative(value.bytes)
    || typeof value.revision !== "string" || !DECIMAL_REVISION.test(value.revision)
    || !safeNonnegative(value.updatedAt)) throw new Error("Extension Library usage ledger is invalid.");
  return value as unknown as StoredLibraryUsage;
}

function parseCursor(value: string): { revision: string; prefix: string; recursive: boolean; offset: number } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!plainObject(decoded) || !exactKeys(decoded, ["revision", "prefix", "recursive", "offset"])
      || typeof decoded.revision !== "string" || !DECIMAL_REVISION.test(decoded.revision)
      || typeof decoded.prefix !== "string" || typeof decoded.recursive !== "boolean"
      || !safeNonnegative(decoded.offset)) throw new Error("shape");
    return decoded as { revision: string; prefix: string; recursive: boolean; offset: number };
  } catch (error) {
    throw new ExtensionLibraryError("PATH_INVALID", "Library list cursor is invalid.", { cause: error });
  }
}

function encodeCursor(value: { revision: string; prefix: string; recursive: boolean; offset: number }): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashOpenFile(path: string, expected: BigIntStats): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(expected, opened)) throw new ExtensionLibraryError("CONFLICT", "Library file changed while it was opened.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(opened.size) - offset), offset);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (offset !== Number(opened.size) || !sameFile(opened, after) || !sameFile(after, pathAfter)) {
      throw new ExtensionLibraryError("CONFLICT", "Library file changed while it was hashed.");
    }
    return hash.digest("hex");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameFilesystemObject(left: BigIntStats, right: BigIntStats): boolean {
  if (left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory() || left.dev !== right.dev) return false;
  if (left.ino !== 0n && right.ino !== 0n) return left.ino === right.ino;
  return left.ino === 0n && right.ino === 0n && left.birthtimeNs !== 0n && left.birthtimeNs === right.birthtimeNs;
}

function sameEntrySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFilesystemObject(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile() && right.isFile() && sameEntrySnapshot(left, right);
}

function inside(root: string, target: string): boolean {
  const base = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const value = process.platform === "win32" ? resolve(target).toLowerCase() : resolve(target);
  return value === base || value.startsWith(`${base}${sep}`);
}

function safeNumber(value: bigint): number;
function safeNumber(value: number): number;
function safeNumber(value: bigint | number): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 0) throw new ExtensionLibraryError("TOO_LARGE", "Library filesystem value exceeds the supported range.");
  return result;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ExtensionLibraryError("TOO_LARGE", "Extension Library size exceeds the supported range.");
  return result;
}

function safeNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function incrementRevision(value: string): string {
  return (BigInt(value) + 1n).toString(10);
}

function boundedLabel(value: string): string {
  const trimmed = value.trim();
  return (trimmed === "" ? "Extension" : trimmed).slice(0, 256);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isNoSpace(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOSPC";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
