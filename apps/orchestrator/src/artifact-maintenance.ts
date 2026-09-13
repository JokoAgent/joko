import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ArtifactRecord, OperationalStore } from "@joko/store";

const ARTIFACT_ROW_PAGE_SIZE = 100_000;
const MAXIMUM_PROTECTED_DIGESTS = 1_000;
const MAXIMUM_ISSUED_SCANS = 256;
const DEFAULT_TEMPORARY_FILE_MINIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_SCAN_TOKEN_TTL_MS = 5 * 60 * 1_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HASH_DIRECTORY_PATTERN = /^[a-f0-9]{2}$/u;

export interface ArtifactStorageStats {
  readonly referenceCount: number;
  readonly uniqueBlobCount: number;
  readonly totalBytes: number;
  readonly cacheReferenceCount: number;
  readonly cacheBytes: number;
  readonly temporaryFileCount: number;
  readonly temporaryBytes: number;
}

export interface ArtifactMaintenanceScan {
  /** Opaque, single-use confirmation fence. */
  readonly token: string;
  readonly expiresAt: number;
  readonly protectedReferenceCount: number;
  readonly expiredReferenceCount: number;
  readonly orphanBlobCount: number;
  readonly orphanBlobBytes: number;
  readonly temporaryFileCount: number;
  readonly temporaryBytes: number;
  readonly missingBlobCount: number;
  readonly unsafeEntryCount: number;
  readonly cleanableBytes: number;
}

export interface ArtifactReconcileResult {
  readonly healthy: boolean;
  readonly missingBlobCount: number;
  readonly orphanBlobCount: number;
  readonly unsafeEntryCount: number;
}

export interface ArtifactCleanupResult {
  readonly expiredReferencesDeleted: number;
  readonly blobsRemoved: number;
  readonly temporaryFilesRemoved: number;
  readonly freedBytes: number;
  readonly skipped: number;
}

export interface ArtifactMaintenanceOptions {
  readonly store: OperationalStore;
  readonly rootDirectory: string;
  readonly now?: () => number;
  readonly temporaryFileMinimumAgeMs?: number;
  readonly scanTokenTtlMs?: number;
}

interface FileIdentity {
  readonly path: string;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly device: number;
  readonly inode: number;
  readonly birthtimeMs: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface ScanState {
  readonly report: Omit<ArtifactMaintenanceScan, "token" | "expiresAt">;
  readonly fingerprint: string;
  readonly expired: readonly ArtifactRecord[];
  readonly orphanBlobs: readonly FileIdentity[];
  readonly temporaryFiles: readonly FileIdentity[];
}

interface IssuedScan {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly protectedDigestsKey: string;
}

export class ArtifactMaintenanceScanExpiredError extends Error {
  constructor() {
    super("Artifact cleanup scan expired; scan again before cleaning.");
    this.name = "ArtifactMaintenanceScanExpiredError";
  }
}

export class ArtifactMaintenanceScanChangedError extends Error {
  constructor() {
    super("Artifact storage changed after the scan; scan again before cleaning.");
    this.name = "ArtifactMaintenanceScanChangedError";
  }
}

/**
 * Service-owned maintenance for the content-addressed Artifact store.
 *
 * Reports never expose service paths. Cleanup is an explicit second phase and
 * re-runs the complete scan, so an old confirmation cannot delete newly
 * referenced content. Database references are retired before physical files.
 */
export class ArtifactMaintenance {
  readonly #store: OperationalStore;
  readonly #rootDirectory: string;
  readonly #blobsDirectory: string;
  readonly #incomingDirectory: string;
  readonly #trashDirectory: string;
  readonly #now: () => number;
  readonly #temporaryFileMinimumAgeMs: number;
  readonly #scanTokenTtlMs: number;
  readonly #issuedScans = new Map<string, IssuedScan>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ArtifactMaintenanceOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new Error("Artifact maintenance root must be a normalized absolute path.");
    }
    const temporaryFileMinimumAgeMs = options.temporaryFileMinimumAgeMs
      ?? DEFAULT_TEMPORARY_FILE_MINIMUM_AGE_MS;
    if (!Number.isSafeInteger(temporaryFileMinimumAgeMs) || temporaryFileMinimumAgeMs < 60_000) {
      throw new RangeError("Artifact temporary-file age must be at least one minute.");
    }
    const scanTokenTtlMs = options.scanTokenTtlMs ?? DEFAULT_SCAN_TOKEN_TTL_MS;
    if (!Number.isSafeInteger(scanTokenTtlMs) || scanTokenTtlMs < 1_000) {
      throw new RangeError("Artifact scan-token lifetime must be at least one second.");
    }
    this.#store = options.store;
    this.#rootDirectory = options.rootDirectory;
    this.#blobsDirectory = join(options.rootDirectory, "blobs");
    this.#incomingDirectory = join(options.rootDirectory, "incoming");
    this.#trashDirectory = join(options.rootDirectory, ".maintenance-trash");
    this.#now = options.now ?? Date.now;
    this.#temporaryFileMinimumAgeMs = temporaryFileMinimumAgeMs;
    this.#scanTokenTtlMs = scanTokenTtlMs;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#blobsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.#incomingDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.#trashDirectory, { recursive: true, mode: 0o700 })
    ]);
  }

  async stats(protectedSha256: readonly string[] = []): Promise<ArtifactStorageStats> {
    await this.initialize();
    const now = this.#now();
    const protectedDigests = new Set(normalizeProtectedDigests(protectedSha256));
    const records = this.#liveRecords().filter((record) =>
      !isExpired(record, now) || protectedDigests.has(record.blob.sha256));
    const unique = uniqueStorageRecords(records);
    const cache = uniqueStorageRecords(records.filter((record) => expiresAt(record) !== undefined));
    const temporary = await this.#temporaryFiles(now, false);
    return {
      referenceCount: records.length,
      uniqueBlobCount: unique.size,
      totalBytes: sumRecordBytes(unique.values()),
      cacheReferenceCount: records.filter((record) => expiresAt(record) !== undefined).length,
      cacheBytes: sumRecordBytes(cache.values()),
      temporaryFileCount: temporary.files.length,
      temporaryBytes: sumFileBytes(temporary.files)
    };
  }

  async scan(protectedSha256: readonly string[] = []): Promise<ArtifactMaintenanceScan> {
    const protectedDigests = normalizeProtectedDigests(protectedSha256);
    const state = await this.#scanState(protectedDigests);
    const expiresAt = this.#now() + this.#scanTokenTtlMs;
    this.#purgeExpiredScans();
    while (this.#issuedScans.size >= MAXIMUM_ISSUED_SCANS) {
      const oldest = this.#issuedScans.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#issuedScans.delete(oldest);
    }
    const token = createHash("sha256")
      .update(`${randomUUID()}\0${state.fingerprint}\0${expiresAt.toString(10)}`)
      .digest("hex");
    this.#issuedScans.set(token, {
      fingerprint: state.fingerprint,
      expiresAt,
      protectedDigestsKey: protectedDigests.join("\0")
    });
    return { ...state.report, token, expiresAt };
  }

  async reconcile(protectedSha256: readonly string[] = []): Promise<ArtifactReconcileResult> {
    const scan = await this.#scanState(normalizeProtectedDigests(protectedSha256));
    return {
      healthy: scan.report.missingBlobCount === 0
        && scan.report.orphanBlobCount === 0
        && scan.report.unsafeEntryCount === 0,
      missingBlobCount: scan.report.missingBlobCount,
      orphanBlobCount: scan.report.orphanBlobCount,
      unsafeEntryCount: scan.report.unsafeEntryCount
    };
  }

  cleanup(token: string, protectedSha256: readonly string[] = []): Promise<ArtifactCleanupResult> {
    if (!/^[a-f0-9]{64}$/u.test(token)) {
      return Promise.reject(new Error("Artifact cleanup scan token is invalid."));
    }
    return this.#serializeMutation(async () => {
      const protectedDigests = normalizeProtectedDigests(protectedSha256);
      this.#purgeExpiredScans();
      const issued = this.#issuedScans.get(token);
      if (issued === undefined || issued.expiresAt <= this.#now()) throw new ArtifactMaintenanceScanExpiredError();
      if (issued.protectedDigestsKey !== protectedDigests.join("\0")) throw new ArtifactMaintenanceScanChangedError();
      const scan = await this.#scanState(protectedDigests);
      if (scan.fingerprint !== issued.fingerprint) throw new ArtifactMaintenanceScanChangedError();
      this.#issuedScans.delete(token);

      this.#store.transaction((store) => {
        for (const record of scan.expired) store.deleteArtifact(record.blob.id, this.#now());
      });

      const liveStorageKeys = new Set(this.#liveRecords()
        .filter((record) => !isExpired(record, this.#now()))
        .map((record) => resolve(record.storageKey)));
      let blobsRemoved = 0;
      let temporaryFilesRemoved = 0;
      let freedBytes = 0;
      let skipped = 0;

      for (const candidate of scan.orphanBlobs) {
        if (liveStorageKeys.has(resolve(candidate.path))) {
          skipped += 1;
          continue;
        }
        if (await this.#quarantineAndRemove(candidate)) {
          blobsRemoved += 1;
          freedBytes += candidate.byteLength;
        } else {
          skipped += 1;
        }
      }
      for (const candidate of scan.temporaryFiles) {
        if (await this.#quarantineAndRemove(candidate)) {
          temporaryFilesRemoved += 1;
          freedBytes += candidate.byteLength;
        } else {
          skipped += 1;
        }
      }
      await this.#removeEmptyHashDirectories();
      return {
        expiredReferencesDeleted: scan.expired.length,
        blobsRemoved,
        temporaryFilesRemoved,
        freedBytes,
        skipped
      };
    });
  }

  async #scanState(protectedDigests: readonly string[]): Promise<ScanState> {
    await this.initialize();
    const now = this.#now();
    const records = this.#liveRecords();
    const protectedSet = new Set(protectedDigests);
    const protectedRecords = records.filter((record) => isExpired(record, now) && protectedSet.has(record.blob.sha256));
    const expired = records.filter((record) => isExpired(record, now) && !protectedSet.has(record.blob.sha256));
    const active = records.filter((record) => !isExpired(record, now) || protectedSet.has(record.blob.sha256));
    const activeStorageKeys = new Set(active.map((record) => resolve(record.storageKey)));
    const blobWalk = await this.#blobFiles(activeStorageKeys);
    const temporary = await this.#temporaryFiles(now, true);
    const missingBlobCount = await countMissingStorageKeys(activeStorageKeys, this.#blobsDirectory);

    const tokenMaterial = [
      ...expired.map((record) => `expired\0${record.blob.id}\0${record.revision.toString(10)}`),
      ...protectedRecords.map((record) => `protected\0${record.blob.id}\0${record.revision.toString(10)}`),
      ...blobWalk.orphans.map(identityToken),
      ...temporary.files.map(identityToken),
      `missing\0${missingBlobCount}`,
      `unsafe\0${blobWalk.unsafeEntryCount + temporary.unsafeEntryCount}`
    ].sort().join("\n");
    const fingerprint = createHash("sha256").update(tokenMaterial).digest("hex");
    const orphanBlobBytes = sumFileBytes(blobWalk.orphans);
    const temporaryBytes = sumFileBytes(temporary.files);
    return {
      report: {
        protectedReferenceCount: protectedRecords.length,
        expiredReferenceCount: expired.length,
        orphanBlobCount: blobWalk.orphans.length,
        orphanBlobBytes,
        temporaryFileCount: temporary.files.length,
        temporaryBytes,
        missingBlobCount,
        unsafeEntryCount: blobWalk.unsafeEntryCount + temporary.unsafeEntryCount,
        cleanableBytes: orphanBlobBytes + temporaryBytes
      },
      fingerprint,
      expired,
      orphanBlobs: blobWalk.orphans,
      temporaryFiles: temporary.files
    };
  }

  #purgeExpiredScans(): void {
    const now = this.#now();
    for (const [token, scan] of this.#issuedScans) {
      if (scan.expiresAt <= now) this.#issuedScans.delete(token);
    }
  }

  #liveRecords(): ArtifactRecord[] {
    const records: ArtifactRecord[] = [];
    for (let offset = 0; ;) {
      const page = this.#store.listArtifacts({
        includeCleared: true,
        limit: ARTIFACT_ROW_PAGE_SIZE,
        offset
      });
      records.push(...page);
      if (page.length < ARTIFACT_ROW_PAGE_SIZE) return records;
      offset += page.length;
    }
  }

  async #blobFiles(activeStorageKeys: ReadonlySet<string>): Promise<{
    readonly orphans: FileIdentity[];
    readonly unsafeEntryCount: number;
  }> {
    const orphans: FileIdentity[] = [];
    let unsafeEntryCount = 0;
    for (const first of await readdir(this.#blobsDirectory, { withFileTypes: true })) {
      if (!first.isDirectory() || first.isSymbolicLink() || !HASH_DIRECTORY_PATTERN.test(first.name)) {
        unsafeEntryCount += 1;
        continue;
      }
      const firstPath = join(this.#blobsDirectory, first.name);
      for (const second of await readdir(firstPath, { withFileTypes: true })) {
        if (!second.isDirectory() || second.isSymbolicLink() || !HASH_DIRECTORY_PATTERN.test(second.name)) {
          unsafeEntryCount += 1;
          continue;
        }
        const secondPath = join(firstPath, second.name);
        for (const entry of await readdir(secondPath, { withFileTypes: true })) {
          const path = join(secondPath, entry.name);
          if (!entry.isFile() || entry.isSymbolicLink() || !SHA256_PATTERN.test(entry.name)
            || entry.name.slice(0, 2) !== first.name || entry.name.slice(2, 4) !== second.name) {
            unsafeEntryCount += 1;
            continue;
          }
          const identity = await safeFileIdentity(path, this.#rootDirectory);
          if (identity === undefined) {
            unsafeEntryCount += 1;
          } else if (!activeStorageKeys.has(resolve(path))) {
            orphans.push(identity);
          }
        }
      }
    }
    return { orphans: orphans.sort(compareIdentity), unsafeEntryCount };
  }

  async #temporaryFiles(now: number, cleanableOnly: boolean): Promise<{
    readonly files: FileIdentity[];
    readonly unsafeEntryCount: number;
  }> {
    const files: FileIdentity[] = [];
    let unsafeEntryCount = 0;
    for (const entry of await readdir(this.#incomingDirectory, { withFileTypes: true })) {
      const path = join(this.#incomingDirectory, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        unsafeEntryCount += 1;
        continue;
      }
      const identity = await safeFileIdentity(path, this.#rootDirectory);
      if (identity === undefined) {
        unsafeEntryCount += 1;
        continue;
      }
      if (!cleanableOnly || now - identity.mtimeMs >= this.#temporaryFileMinimumAgeMs) files.push(identity);
    }
    return { files: files.sort(compareIdentity), unsafeEntryCount };
  }

  async #quarantineAndRemove(expected: FileIdentity): Promise<boolean> {
    const current = await safeFileIdentity(expected.path, this.#rootDirectory).catch(() => undefined);
    if (current === undefined || !sameIdentity(expected, current)) return false;
    const quarantine = join(this.#trashDirectory, randomUUID());
    try {
      await rename(expected.path, quarantine);
      await rm(quarantine, { force: true });
      return true;
    } catch {
      await rename(quarantine, expected.path).catch(() => undefined);
      return false;
    }
  }

  async #removeEmptyHashDirectories(): Promise<void> {
    for (const first of await readdir(this.#blobsDirectory, { withFileTypes: true })) {
      if (!first.isDirectory() || first.isSymbolicLink() || !HASH_DIRECTORY_PATTERN.test(first.name)) continue;
      const firstPath = join(this.#blobsDirectory, first.name);
      for (const second of await readdir(firstPath, { withFileTypes: true })) {
        if (!second.isDirectory() || second.isSymbolicLink() || !HASH_DIRECTORY_PATTERN.test(second.name)) continue;
        await rmdir(join(firstPath, second.name)).catch(() => undefined);
      }
      await rmdir(firstPath).catch(() => undefined);
    }
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function normalizeProtectedDigests(values: readonly string[]): string[] {
  if (values.length > MAXIMUM_PROTECTED_DIGESTS) {
    throw new RangeError("Too many protected Artifact digests were supplied.");
  }
  const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
  if (normalized.some((value) => !SHA256_PATTERN.test(value))) {
    throw new TypeError("Protected Artifact digests must be SHA-256 values.");
  }
  return normalized;
}

function expiresAt(record: ArtifactRecord): number | undefined {
  const metadata = record.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
  const value = (metadata as { readonly expiresAt?: unknown }).expiresAt;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isExpired(record: ArtifactRecord, now: number): boolean {
  const expiry = expiresAt(record);
  return expiry !== undefined && expiry <= now;
}

function uniqueStorageRecords(records: readonly ArtifactRecord[]): Map<string, ArtifactRecord> {
  const unique = new Map<string, ArtifactRecord>();
  for (const record of records) if (!unique.has(record.storageKey)) unique.set(record.storageKey, record);
  return unique;
}

function sumRecordBytes(records: Iterable<ArtifactRecord>): number {
  let total = 0;
  for (const record of records) total += record.blob.byteLength;
  return total;
}

function sumFileBytes(files: Iterable<FileIdentity>): number {
  let total = 0;
  for (const file of files) total += file.byteLength;
  return total;
}

async function safeFileIdentity(path: string, root: string): Promise<FileIdentity | undefined> {
  const normalizedRoot = resolve(root);
  const normalized = resolve(path);
  if (normalized === normalizedRoot || !normalized.startsWith(`${normalizedRoot}${sep}`)) return undefined;
  const info = await lstat(normalized).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return undefined;
  return {
    path: normalized,
    relativePath: relative(normalizedRoot, normalized).replace(/\\/gu, "/"),
    byteLength: info.size,
    device: info.dev,
    inode: info.ino,
    birthtimeMs: info.birthtimeMs,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs
  };
}

function identityToken(value: FileIdentity): string {
  return ["file", value.relativePath, value.byteLength, value.device, value.inode,
    value.birthtimeMs, value.mtimeMs, value.ctimeMs].join("\0");
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path
    && left.byteLength === right.byteLength
    && left.device === right.device
    && left.inode === right.inode
    && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function compareIdentity(left: FileIdentity, right: FileIdentity): number {
  return left.relativePath.localeCompare(right.relativePath, "en");
}

async function countMissingStorageKeys(keys: ReadonlySet<string>, blobsRoot: string): Promise<number> {
  const normalizedRoot = resolve(blobsRoot);
  let missing = 0;
  for (const key of keys) {
    const normalized = resolve(key);
    if (!normalized.startsWith(`${normalizedRoot}${sep}`)) {
      missing += 1;
      continue;
    }
    const info = await lstat(normalized).catch(() => undefined);
    if (info === undefined || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) missing += 1;
  }
  return missing;
}
