import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rmdir } from "node:fs/promises";
import { existsSync, lstatSync, renameSync, rmSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ArtifactRecord, MaintenanceEffectRecord, MaintenanceJobRecord, OperationalStore } from "@joko/store";

const ARTIFACT_ROW_PAGE_SIZE = 100_000;
const MAXIMUM_PROTECTED_DIGESTS = 1_000;
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

export type ArtifactCleanupStatus = "running" | "completed" | "scan-expired" | "storage-changed" | "failed";
export type ArtifactCleanupPhase = "preparing" | "quarantining" | "deleting" | "reconciling";
export interface ArtifactCleanupJob {
  readonly maintenanceId: string;
  readonly status: ArtifactCleanupStatus;
  readonly phase: ArtifactCleanupPhase;
  readonly percent: number;
  readonly updatedAt: number;
  readonly result?: ArtifactCleanupResult;
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

interface DurableArtifactScan {
  readonly fingerprint: string;
  readonly protectedDigestsKey: string;
  readonly expired: readonly { readonly id: string; readonly revision: string }[];
  readonly orphanBlobs: readonly FileIdentity[];
  readonly temporaryFiles: readonly FileIdentity[];
}

interface DurableArtifactJob {
  readonly expiredReferencesDeleted: number;
}

interface DurableArtifactEffect {
  readonly identity: FileIdentity;
  readonly quarantineRelativePath: string;
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
  readonly #running = new Map<string, Promise<void>>();
  #mutationTail: Promise<void> = Promise.resolve();
  #closing = false;

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
    await this.#ensureDirectories();
    for (const job of this.#store.listMaintenanceJobs({ kind: "artifact", statuses: ["running"], limit: 256 })) {
      this.#launch(job.id);
    }
    await Promise.allSettled([...this.#running.values()]);
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.allSettled([...this.#running.values()]);
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#rootDirectory);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("Artifact maintenance root is unsafe.");
    }
    await Promise.all([
      mkdir(this.#blobsDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.#incomingDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.#trashDirectory, { recursive: true, mode: 0o700 })
    ]);
    for (const directory of [this.#rootDirectory, this.#blobsDirectory, this.#incomingDirectory, this.#trashDirectory]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Artifact maintenance directory is unsafe.");
    }
  }

  async stats(protectedSha256: readonly string[] = []): Promise<ArtifactStorageStats> {
    await this.#ensureDirectories();
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
    const token = createHash("sha256")
      .update(`${randomUUID()}\0${state.fingerprint}\0${expiresAt.toString(10)}`)
      .digest("hex");
    const payload: DurableArtifactScan = {
      fingerprint: state.fingerprint,
      protectedDigestsKey: protectedDigests.join("\0"),
      expired: state.expired.map((record) => ({ id: record.blob.id, revision: record.revision.toString() })),
      orphanBlobs: state.orphanBlobs,
      temporaryFiles: state.temporaryFiles
    };
    this.#store.createMaintenanceScan({ id: token, kind: "artifact", fingerprint: state.fingerprint,
      payload, expiresAt, createdAt: this.#now() });
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

  beginCleanup(token: string, protectedSha256: readonly string[] = []): Promise<ArtifactCleanupJob> {
    if (!SHA256_PATTERN.test(token)) return Promise.reject(new Error("Artifact cleanup scan token is invalid."));
    return this.#serializeMutation(async () => {
      const protectedDigests = normalizeProtectedDigests(protectedSha256);
      const existing = this.#store.findMaintenanceJob<DurableArtifactJob, ArtifactCleanupResult>("artifact", token);
      if (existing !== undefined) return toCleanupJob(existing);
      const issued = this.#store.findMaintenanceScan<DurableArtifactScan>("artifact", token);
      if (issued === undefined || issued.state !== "available" || issued.expiresAt <= this.#now()) {
        throw new ArtifactMaintenanceScanExpiredError();
      }
      if (issued.payload.protectedDigestsKey !== protectedDigests.join("\0")) {
        throw new ArtifactMaintenanceScanChangedError();
      }
      const revision = this.#store.health().revision;
      const scan = await this.#scanState(protectedDigests);
      if (this.#store.health().revision !== revision || scan.fingerprint !== issued.payload.fingerprint
        || scan.report.unsafeEntryCount !== 0 || scan.report.missingBlobCount !== 0) {
        throw new ArtifactMaintenanceScanChangedError();
      }
      const now = this.#now();
      if (issued.expiresAt <= now) throw new ArtifactMaintenanceScanExpiredError();
      if (this.#store.health().revision !== revision) throw new ArtifactMaintenanceScanChangedError();
      const candidates = [
        ...scan.orphanBlobs.map((identity) => ({ identity, kind: "artifact_blob" as const })),
        ...scan.temporaryFiles.map((identity) => ({ identity, kind: "artifact_temporary" as const }))
      ];
      const created = this.#store.transaction((store) => {
        const claimed = store.claimMaintenanceScan("artifact", token, now);
        if (claimed?.state !== "claimed") throw new ArtifactMaintenanceScanExpiredError();
        const job = store.createMaintenanceJob<DurableArtifactJob, ArtifactCleanupResult>({
          id: token, kind: "artifact", scanId: token, phase: "preparing", percent: 1,
          cancellable: false, payload: { expiredReferencesDeleted: scan.expired.length },
          effects: candidates.map(({ identity, kind }) => {
            const id = createHash("sha256").update(identity.relativePath).digest("hex");
            return { id, kind, payload: {
              identity, quarantineRelativePath: join(".maintenance-trash", token, id)
            } satisfies DurableArtifactEffect };
          }), createdAt: now
        });
        for (const record of scan.expired) {
          const current = store.getArtifact(record.blob.id, true);
          if (current.revision !== record.revision || !isExpired(current, now)) {
            throw new ArtifactMaintenanceScanChangedError();
          }
          store.deleteArtifact(record.blob.id, now);
        }
        return job;
      });
      this.#launch(token);
      return toCleanupJob(created);
    });
  }

  getCleanup(id: string): ArtifactCleanupJob | undefined {
    if (!SHA256_PATTERN.test(id)) return undefined;
    const job = this.#store.findMaintenanceJob<DurableArtifactJob, ArtifactCleanupResult>("artifact", id);
    return job === undefined ? undefined : toCleanupJob(job);
  }

  async #scanState(protectedDigests: readonly string[]): Promise<ScanState> {
    await this.#ensureDirectories();
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
    const trashUnsafeEntryCount = await this.#trashUnsafeEntryCount();

    const tokenMaterial = [
      ...expired.map((record) => `expired\0${record.blob.id}\0${record.revision.toString(10)}`),
      ...protectedRecords.map((record) => `protected\0${record.blob.id}\0${record.revision.toString(10)}`),
      ...blobWalk.orphans.map(identityToken),
      ...temporary.files.map(identityToken),
      `missing\0${missingBlobCount}`,
      `unsafe\0${blobWalk.unsafeEntryCount + temporary.unsafeEntryCount + trashUnsafeEntryCount}`
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
        unsafeEntryCount: blobWalk.unsafeEntryCount + temporary.unsafeEntryCount + trashUnsafeEntryCount,
        cleanableBytes: orphanBlobBytes + temporaryBytes
      },
      fingerprint,
      expired,
      orphanBlobs: blobWalk.orphans,
      temporaryFiles: temporary.files
    };
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

  async #trashUnsafeEntryCount(): Promise<number> {
    let unsafe = 0;
    for (const directory of await readdir(this.#trashDirectory, { withFileTypes: true })) {
      if (!directory.isDirectory() || directory.isSymbolicLink() || !SHA256_PATTERN.test(directory.name)) {
        unsafe += 1;
        continue;
      }
      const job = this.#store.findMaintenanceJob("artifact", directory.name);
      const effects = job === undefined ? new Map<string, MaintenanceEffectRecord<DurableArtifactEffect>>()
        : new Map(this.#store.listMaintenanceEffects<DurableArtifactEffect>(job.id).map((effect) => [effect.id, effect]));
      for (const entry of await readdir(join(this.#trashDirectory, directory.name), { withFileTypes: true })) {
        const effect = effects.get(entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || effect === undefined
          || !["claimed", "quarantined", "prepared"].includes(effect.state)
          || effect.payload.quarantineRelativePath !== join(".maintenance-trash", directory.name, entry.name)) {
          unsafe += 1;
        }
      }
    }
    return unsafe;
  }

  #launch(id: string): void {
    if (this.#running.has(id) || this.#closing) return;
    const completion = this.#execute(id).catch((error: unknown) => {
      const job = this.#store.getMaintenanceJob<DurableArtifactJob, ArtifactCleanupResult>("artifact", id);
      if (job.status !== "running") return;
      this.#store.updateMaintenanceJob({ kind: "artifact", id, status: error instanceof ArtifactMaintenanceScanChangedError
        ? "storage_changed" : "failed", phase: "reconciling", percent: job.percent,
      cancellable: false, cancelRequested: false, payload: job.payload, updatedAt: this.#now() });
    }).finally(() => { this.#running.delete(id); });
    this.#running.set(id, completion);
  }

  async #execute(id: string): Promise<void> {
    const job = this.#store.getMaintenanceJob<DurableArtifactJob, ArtifactCleanupResult>("artifact", id);
    if (job.status !== "running") return;
    const effects = this.#store.listMaintenanceEffects<DurableArtifactEffect>(id);
    for (let index = 0; index < effects.length; index += 1) {
      const effect = effects[index];
      if (effect === undefined) continue;
      this.#updateJob(id, "quarantining", Math.max(1, Math.floor(5 + index * 85 / Math.max(effects.length, 1))));
      await this.#processEffect(effect);
    }
    await this.#removeEmptyHashDirectories();
    await rmdir(join(this.#trashDirectory, id)).catch(() => undefined);
    const finalEffects = this.#store.listMaintenanceEffects<DurableArtifactEffect>(id);
    if (finalEffects.some((effect) => effect.state === "unknown")) throw new ArtifactMaintenanceScanChangedError();
    const result: ArtifactCleanupResult = {
      expiredReferencesDeleted: job.payload.expiredReferencesDeleted,
      blobsRemoved: finalEffects.filter((effect) => effect.kind === "artifact_blob" && effect.state === "completed").length,
      temporaryFilesRemoved: finalEffects.filter((effect) => effect.kind === "artifact_temporary" && effect.state === "completed").length,
      freedBytes: finalEffects.filter((effect) => effect.state === "completed")
        .reduce((total, effect) => total + effect.payload.identity.byteLength, 0),
      skipped: finalEffects.filter((effect) => effect.state === "skipped").length
    };
    this.#store.updateMaintenanceJob({ kind: "artifact", id, status: "completed", phase: "reconciling",
      percent: 100, cancellable: false, cancelRequested: false, payload: job.payload, result,
      updatedAt: this.#now() });
  }

  #updateJob(id: string, phase: ArtifactCleanupPhase, percent: number): void {
    const job = this.#store.getMaintenanceJob<DurableArtifactJob, ArtifactCleanupResult>("artifact", id);
    this.#store.updateMaintenanceJob({ kind: "artifact", id, status: "running", phase, percent,
      cancellable: false, cancelRequested: false, payload: job.payload, updatedAt: this.#now() });
  }

  async #processEffect(effect: MaintenanceEffectRecord<DurableArtifactEffect>): Promise<void> {
    if (effect.state === "completed" || effect.state === "skipped") return;
    if (effect.state === "unknown") throw new ArtifactMaintenanceScanChangedError();
    const { identity, quarantineRelativePath } = effect.payload;
    const expectedId = createHash("sha256").update(identity.relativePath).digest("hex");
    if (expectedId !== effect.id || identity.path !== resolve(this.#rootDirectory, identity.relativePath)
      || quarantineRelativePath !== join(".maintenance-trash", effect.jobId, effect.id)
      || !["artifact_blob", "artifact_temporary"].includes(effect.kind)) {
      throw new ArtifactMaintenanceScanChangedError();
    }
    const quarantine = join(this.#rootDirectory, quarantineRelativePath);
    await mkdir(join(this.#trashDirectory, effect.jobId), { recursive: true, mode: 0o700 });
    const original = await safeFileIdentity(identity.path, this.#rootDirectory);
    const held = await safeFileIdentity(quarantine, this.#rootDirectory);
    if ((original === undefined && await lstat(identity.path).catch(() => undefined) !== undefined)
      || (held === undefined && await lstat(quarantine).catch(() => undefined) !== undefined)) {
      this.#recordEffect(effect, "unknown");
      throw new ArtifactMaintenanceScanChangedError();
    }
    if (held !== undefined && !samePhysicalIdentity(identity, held)) {
      this.#recordEffect(effect, "unknown");
      throw new ArtifactMaintenanceScanChangedError();
    }
    if (held === undefined && original === undefined) {
      if (effect.state === "prepared") {
        this.#recordEffect(effect, "completed");
        return;
      }
      this.#recordEffect(effect, "unknown");
      throw new ArtifactMaintenanceScanChangedError();
    }
    if (held === undefined) {
      if (original === undefined || !sameIdentity(identity, original)) {
        this.#recordEffect(effect, "unknown");
        throw new ArtifactMaintenanceScanChangedError();
      }
      if (effect.kind === "artifact_blob" && this.#store.hasLiveArtifactStorageKey(identity.path)) {
        this.#recordEffect(effect, "skipped");
        return;
      }
      this.#recordEffect(effect, "claimed");
      await rename(identity.path, quarantine);
      this.#recordEffect(effect, "quarantined");
    }
    this.#updateJob(effect.jobId, "deleting", this.#store.getMaintenanceJob("artifact", effect.jobId).percent);
    if (effect.kind === "artifact_blob" && this.#store.hasLiveArtifactStorageKey(identity.path)) {
      if (!existsSync(identity.path)) {
        const current = await safeFileIdentity(quarantine, this.#rootDirectory);
        if (current === undefined || !samePhysicalIdentity(identity, current)) {
          this.#recordEffect(effect, "unknown");
          throw new ArtifactMaintenanceScanChangedError();
        }
        renameSync(quarantine, identity.path);
        this.#recordEffect(effect, "skipped");
        return;
      }
    }
    const finalInfo = lstatSync(quarantine, { throwIfNoEntry: false });
    const parentInfo = lstatSync(join(this.#trashDirectory, effect.jobId), { throwIfNoEntry: false });
    if (finalInfo === undefined || !finalInfo.isFile() || finalInfo.isSymbolicLink() || finalInfo.nlink !== 1
      || !samePhysicalStat(identity, finalInfo) || parentInfo === undefined
      || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      this.#recordEffect(effect, "unknown");
      throw new ArtifactMaintenanceScanChangedError();
    }
    if (effect.kind === "artifact_blob" && this.#store.hasLiveArtifactStorageKey(identity.path)
      && !existsSync(identity.path)) {
      renameSync(quarantine, identity.path);
      this.#recordEffect(effect, "skipped");
      return;
    }
    this.#recordEffect(effect, "prepared");
    rmSync(quarantine);
    this.#recordEffect(effect, "completed");
  }

  #recordEffect(effect: MaintenanceEffectRecord<DurableArtifactEffect>, state: MaintenanceEffectRecord["state"]): void {
    this.#store.updateMaintenanceEffect({ jobId: effect.jobId, id: effect.id, state,
      payload: effect.payload, updatedAt: this.#now() });
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
  const canonicalRoot = await realpath(normalizedRoot).catch(() => undefined);
  const canonicalPath = await realpath(normalized).catch(() => undefined);
  if (canonicalRoot === undefined || canonicalPath === undefined
    || canonicalPath !== resolve(canonicalRoot, relative(normalizedRoot, normalized))) return undefined;
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

function samePhysicalIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.byteLength === right.byteLength && left.device === right.device
    && left.inode === right.inode && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs;
}

function samePhysicalStat(left: FileIdentity, right: Stats): boolean {
  return left.byteLength === right.size && left.device === right.dev
    && left.inode === right.ino && left.birthtimeMs === right.birthtimeMs
    && left.mtimeMs === right.mtimeMs;
}

function toCleanupJob(job: MaintenanceJobRecord<DurableArtifactJob, ArtifactCleanupResult>): ArtifactCleanupJob {
  const status: ArtifactCleanupStatus = job.status === "scan_expired" ? "scan-expired"
    : job.status === "storage_changed" ? "storage-changed"
    : job.status === "cancelled" ? "failed" : job.status;
  return {
    maintenanceId: job.id,
    status,
    phase: job.phase as ArtifactCleanupPhase,
    percent: job.percent,
    updatedAt: job.updatedAt,
    ...(job.result === undefined ? {} : { result: job.result })
  };
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
