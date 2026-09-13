import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, type FileHandle, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { isWithin } from "@joko/core/policy";
import type { BlobRef } from "@joko/core";

export interface ArtifactRecord extends BlobRef {
  readonly storagePath: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface TransferTicket {
  readonly id: string;
  readonly secretDigest: string;
  readonly direction: "upload" | "download";
  readonly blobId?: string;
  readonly expectedSha256?: string;
  readonly expectedSize?: number;
  readonly maximumSize: number;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly expiresAt: number;
  readonly consumedAt?: number;
}

export interface ArtifactRepository {
  putArtifact(record: ArtifactRecord): Promise<void>;
  getArtifact(id: string): Promise<ArtifactRecord | undefined>;
  findPermanentArtifact(input: { readonly storagePath: string; readonly mimeType: string; readonly fileName?: string }): Promise<ArtifactRecord | undefined>;
  createTransferTicket(ticket: TransferTicket): Promise<void>;
  consumeTransferTicket(id: string, secretDigest: string, direction: TransferTicket["direction"], now: number): Promise<TransferTicket | undefined>;
  deleteExpiredArtifacts(now: number): Promise<readonly ArtifactRecord[]>;
  hasLiveStorageReference(storagePath: string): Promise<boolean>;
}

export interface ArtifactStoreOptions {
  readonly rootDirectory: string;
  readonly repository: ArtifactRepository;
  readonly ingestRoots: readonly string[];
  readonly maximumBlobBytes?: number;
  readonly ticketTtlMs?: number;
  readonly now?: () => number;
}

export interface ArtifactSnapshotDigest {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ArtifactFileHandleIngestOptions {
  readonly expectedSize: number;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly expiresAt?: number;
  readonly signal?: AbortSignal;
  /** Revalidate the source fence after staging but before promotion. */
  readonly beforeFinalize?: (snapshot: ArtifactSnapshotDigest) => Promise<void>;
}

export class ArtifactStore {
  readonly #options: ArtifactStoreOptions;
  readonly #maximumBlobBytes: number;
  readonly #ticketTtlMs: number;
  readonly #now: () => number;
  readonly #permanentIngests = new Map<string, Promise<ArtifactRecord>>();

  constructor(options: ArtifactStoreOptions) {
    this.#options = options;
    this.#maximumBlobBytes = options.maximumBlobBytes ?? 256 * 1024 * 1024;
    this.#ticketTtlMs = options.ticketTtlMs ?? 5 * 60 * 1_000;
    this.#now = options.now ?? Date.now;
  }

  get maximumBlobBytes(): number {
    return this.#maximumBlobBytes;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(join(this.#options.rootDirectory, "blobs"), { recursive: true }),
      mkdir(join(this.#options.rootDirectory, "incoming"), { recursive: true })
    ]);
  }

  async ingestPath(sourcePath: string, options?: { fileName?: string; mimeType?: string; expiresAt?: number }): Promise<ArtifactRecord> {
    const source = await realpath(sourcePath);
    const roots = await Promise.all(this.#options.ingestRoots.map((root) => realpath(root)));
    if (!roots.some((root) => isWithin(source, root))) throw new Error("Artifact source is outside approved roots.");
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("Artifact source must be a regular file.");
    if (sourceStat.size > this.#maximumBlobBytes) throw new Error("Artifact exceeds the configured size limit.");
    const temporaryPath = join(this.#options.rootDirectory, "incoming", randomUUID());
    try {
      await copyFile(source, temporaryPath);
      return await this.finalizeIncoming(temporaryPath, {
        expectedSize: sourceStat.size,
        fileName: options?.fileName ?? basename(source),
        mimeType: options?.mimeType ?? inferMediaType(source),
        ...(options?.expiresAt === undefined ? {} : { expiresAt: options.expiresAt })
      });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Materialize a trusted, already-open service file without buffering it in
   * a normal RPC payload. The source handle remains owned by the caller.
   */
  async ingestFileHandle(handle: FileHandle, options: ArtifactFileHandleIngestOptions): Promise<ArtifactRecord> {
    if (!Number.isSafeInteger(options.expectedSize) || options.expectedSize < 0) {
      throw new Error("Artifact expected size must be a non-negative safe integer.");
    }
    if (options.expectedSize > this.#maximumBlobBytes) {
      throw new Error("Artifact exceeds the configured size limit.");
    }
    options.signal?.throwIfAborted();
    const temporaryPath = join(this.#options.rootDirectory, "incoming", randomUUID());
    let byteLength = 0;
    const limiter = async function* (chunks: AsyncIterable<Buffer | string>): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > options.expectedSize) {
          throw new Error("Artifact source changed size or exceeds the configured size limit.");
        }
        yield buffer;
      }
    };
    try {
      const source = handle.createReadStream({ autoClose: false, start: 0 });
      if (options.signal === undefined) {
        await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
      } else {
        await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }), { signal: options.signal });
      }
      return await this.finalizeIncoming(temporaryPath, {
        expectedSize: options.expectedSize,
        ...(options.fileName === undefined ? {} : { fileName: options.fileName }),
        ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
        ...(options.beforeFinalize === undefined && options.signal === undefined ? {} : {
          beforeFinalize: async (snapshot: ArtifactSnapshotDigest) => {
            await options.beforeFinalize?.(snapshot);
            options.signal?.throwIfAborted();
          }
        })
      });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Materialize service-produced bytes without routing them through a public upload ticket. */
  async ingestBytes(
    bytes: Uint8Array,
    options?: { fileName?: string; mimeType?: string; expiresAt?: number }
  ): Promise<ArtifactRecord> {
    if (bytes.byteLength > this.#maximumBlobBytes) throw new Error("Artifact exceeds the configured size limit.");
    const temporaryPath = join(this.#options.rootDirectory, "incoming", randomUUID());
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      return await this.finalizeIncoming(temporaryPath, {
        expectedSize: bytes.byteLength,
        ...(options?.fileName === undefined ? {} : { fileName: options.fileName }),
        ...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }),
        ...(options?.expiresAt === undefined ? {} : { expiresAt: options.expiresAt })
      });
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async createUploadTicket(input: {
    expectedSha256?: string;
    expectedSize?: number;
    maximumSize?: number;
    mimeType?: string;
    fileName?: string;
  }): Promise<{ ticketId: string; secret: string; expiresAt: number }> {
    const maximumSize = Math.min(input.maximumSize ?? this.#maximumBlobBytes, this.#maximumBlobBytes);
    if (input.expectedSize !== undefined && input.expectedSize > maximumSize) throw new Error("Expected upload exceeds its size limit.");
    return this.createTicket({ direction: "upload", maximumSize, ...input });
  }

  async createDownloadTicket(blobId: string): Promise<{ ticketId: string; secret: string; expiresAt: number }> {
    const artifact = await this.requireArtifact(blobId);
    return this.createTicket({ direction: "download", maximumSize: artifact.byteLength, blobId });
  }

  /** Return verified metadata without exposing the repository implementation. */
  async get(blobId: string): Promise<ArtifactRecord> {
    const artifact = await this.requireArtifact(blobId);
    await this.verifyStoragePath(artifact);
    return artifact;
  }

  /** Resolve a blob to a verified regular file for a fenced backend process. */
  async resolveBlobPath(blob: BlobRef): Promise<string> {
    const artifact = await this.requireArtifact(blob.id);
    assertBlobIdentity(blob, artifact);
    await this.verifyStoragePath(artifact);
    return artifact.storagePath;
  }

  /** Read a verified blob for Pi's native image RPC payload. */
  async readBlob(blob: BlobRef): Promise<{ readonly data: Uint8Array; readonly mimeType: string }> {
    const artifact = await this.requireArtifact(blob.id);
    assertBlobIdentity(blob, artifact);
    const before = await this.verifyStoragePath(artifact);
    const handle = await open(before.canonical, "r");
    try {
      const opened = await handle.stat();
      if (!sameFileIdentity(before.info, opened)) throw new Error("Artifact changed while it was being opened.");
      const data = await handle.readFile();
      const afterHandle = await handle.stat();
      const after = await this.verifyStoragePath(artifact);
      if (after.canonical !== before.canonical
        || !sameFileIdentity(opened, afterHandle)
        || !sameFileIdentity(opened, after.info)
        || data.byteLength !== artifact.byteLength
        || createHash("sha256").update(data).digest("hex") !== artifact.sha256.toLowerCase()) {
        throw new Error("Artifact content changed after it was registered.");
      }
      return { data, mimeType: artifact.mimeType };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async acceptUpload(ticketId: string, secret: string, source: Readable): Promise<ArtifactRecord> {
    const ticket = await this.consumeTicket(ticketId, secret, "upload");
    const temporaryPath = join(this.#options.rootDirectory, "incoming", randomUUID());
    const handle = await open(temporaryPath, "wx", 0o600);
    await handle.close();
    let bytes = 0;
    const limiter = async function* (chunks: AsyncIterable<Buffer | string>): AsyncGenerator<Buffer> {
      for await (const chunk of chunks) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > ticket.maximumSize) throw new Error("Upload exceeds its size limit.");
        yield buffer;
      }
    };
    try {
      await pipeline(source, limiter, createWriteStream(temporaryPath, { flags: "w" }));
      return await this.finalizeIncoming(temporaryPath, {
        ...(ticket.expectedSha256 === undefined ? {} : { expectedSha256: ticket.expectedSha256 }),
        ...(ticket.expectedSize === undefined ? {} : { expectedSize: ticket.expectedSize }),
        ...(ticket.fileName === undefined ? {} : { fileName: ticket.fileName }),
        ...(ticket.mimeType === undefined ? {} : { mimeType: ticket.mimeType })
      });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async openDownload(ticketId: string, secret: string): Promise<{ artifact: ArtifactRecord; stream: Readable }> {
    const ticket = await this.consumeTicket(ticketId, secret, "download");
    if (ticket.blobId === undefined) throw new Error("Download ticket has no blob binding.");
    const artifact = await this.requireArtifact(ticket.blobId);
    const verified = await this.verifyStoragePath(artifact);
    const handle = await open(verified.canonical, "r");
    try {
      const opened = await handle.stat();
      if (!sameFileIdentity(verified.info, opened)) {
        throw new Error("Artifact changed while its download stream was being opened.");
      }
      // Bind the stream to the verified handle. Opening by path after the
      // verification would leave a replace-with-symlink race between those
      // two operations. autoClose transfers handle ownership to the stream.
      return { artifact, stream: handle.createReadStream({ autoClose: true, start: 0 }) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async garbageCollect(): Promise<number> {
    const records = await this.#options.repository.deleteExpiredArtifacts(this.#now());
    let collected = 0;
    for (const record of records) {
      await this.verifyStoragePath(record);
      if (await this.#options.repository.hasLiveStorageReference(record.storagePath)) continue;
      await rm(record.storagePath, { force: true });
      collected += 1;
    }
    return collected;
  }

  private async createTicket(input: Omit<TransferTicket, "id" | "secretDigest" | "expiresAt">): Promise<{ ticketId: string; secret: string; expiresAt: number }> {
    const ticketId = randomUUID();
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = this.#now() + this.#ticketTtlMs;
    await this.#options.repository.createTransferTicket({
      ...input,
      id: ticketId,
      secretDigest: hashText(secret),
      expiresAt
    });
    return { ticketId, secret, expiresAt };
  }

  private async consumeTicket(id: string, secret: string, direction: TransferTicket["direction"]): Promise<TransferTicket> {
    const ticket = await this.#options.repository.consumeTransferTicket(id, hashText(secret), direction, this.#now());
    if (ticket === undefined) throw new Error("Transfer ticket is invalid, expired, already used, or has the wrong direction.");
    return ticket;
  }

  private async finalizeIncoming(temporaryPath: string, input: {
    expectedSha256?: string;
    expectedSize?: number;
    fileName?: string;
    mimeType?: string;
    expiresAt?: number;
    beforeFinalize?: (snapshot: ArtifactSnapshotDigest) => Promise<void>;
  }): Promise<ArtifactRecord> {
    const { sha256, byteLength } = await hashFile(temporaryPath, this.#maximumBlobBytes);
    if (input.expectedSha256 !== undefined && input.expectedSha256.toLowerCase() !== sha256) {
      await rm(temporaryPath, { force: true });
      throw new Error("Artifact SHA-256 does not match the declared value.");
    }
    if (input.expectedSize !== undefined && input.expectedSize !== byteLength) {
      await rm(temporaryPath, { force: true });
      throw new Error("Artifact size does not match the declared value.");
    }
    await input.beforeFinalize?.({ sha256, byteLength });
    const storagePath = join(this.#options.rootDirectory, "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    await mkdir(dirname(storagePath), { recursive: true });
    try {
      await rename(temporaryPath, storagePath);
    } catch (error) {
      if (!(await exists(storagePath))) throw error;
      await rm(temporaryPath, { force: true });
    }
    const mimeType = input.mimeType ?? "application/octet-stream";
    const fileName = input.fileName === undefined ? undefined : sanitizeFileName(input.fileName);
    const persist = async (): Promise<ArtifactRecord> => {
      if (input.expiresAt === undefined) {
        const existing = await this.#options.repository.findPermanentArtifact({
          storagePath,
          mimeType,
          ...(fileName === undefined ? {} : { fileName })
        });
        if (existing !== undefined) return existing;
      }
      const record: ArtifactRecord = {
        id: randomUUID(),
        sha256,
        byteLength,
        mimeType,
        ...(fileName === undefined ? {} : { fileName }),
        storagePath,
        createdAt: this.#now(),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
      };
      await this.#options.repository.putArtifact(record);
      return record;
    };
    if (input.expiresAt !== undefined) return persist();
    const identity = `${storagePath}\0${mimeType}\0${fileName ?? ""}`;
    const pending = this.#permanentIngests.get(identity);
    if (pending !== undefined) return pending;
    const operation = persist();
    this.#permanentIngests.set(identity, operation);
    try {
      return await operation;
    } finally {
      if (this.#permanentIngests.get(identity) === operation) this.#permanentIngests.delete(identity);
    }
  }

  private async requireArtifact(id: string): Promise<ArtifactRecord> {
    const artifact = await this.#options.repository.getArtifact(id);
    if (artifact === undefined || (artifact.expiresAt !== undefined && artifact.expiresAt <= this.#now())) {
      throw new Error("Artifact does not exist or has expired.");
    }
    return artifact;
  }

  private async verifyStoragePath(artifact: ArtifactRecord): Promise<{
    readonly canonical: string;
    readonly info: Awaited<ReturnType<typeof lstat>>;
  }> {
    const canonicalRoot = await realpath(join(this.#options.rootDirectory, "blobs"));
    const direct = await lstat(artifact.storagePath);
    if (!direct.isFile() || direct.isSymbolicLink() || direct.nlink !== 1) {
      throw new Error("Artifact storage entry is not a private regular file.");
    }
    const canonical = await realpath(artifact.storagePath);
    if (!isWithin(canonical, canonicalRoot)) throw new Error("Artifact storage path escaped its root.");
    const expectedCanonical = resolve(
      canonicalRoot,
      artifact.sha256.slice(0, 2),
      artifact.sha256.slice(2, 4),
      artifact.sha256
    );
    if (resolve(canonical) !== expectedCanonical) {
      throw new Error("Artifact storage path does not match its content-addressed identity.");
    }
    const info = await lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink() || !sameFileIdentity(direct, info)) {
      throw new Error("Artifact storage entry changed during path verification.");
    }
    return { canonical, info };
  }
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function hashFile(path: string, maximumBytes: number): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) throw new Error("Artifact exceeds the configured size limit.");
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inferMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    case ".html": return "text/html";
    case ".json": return "application/json";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function sanitizeFileName(value: string): string {
  const safe = basename(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return safe === "" || safe === "." || safe === ".." ? "artifact" : safe;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertBlobIdentity(expected: BlobRef, actual: ArtifactRecord): void {
  if (
    expected.sha256.toLowerCase() !== actual.sha256.toLowerCase() ||
    expected.byteLength !== actual.byteLength ||
    expected.mimeType !== actual.mimeType
  ) {
    throw new Error("Blob reference does not match the registered artifact metadata.");
  }
}
