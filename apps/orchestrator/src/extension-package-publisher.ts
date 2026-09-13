import { createHash } from "node:crypto";
import { open, lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { BlobRef } from "@joko/core";
import { redactSecrets } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import { create as createTarArchive, extract as extractTarArchive, list as listTarArchive } from "tar";

import type { ArtifactStore } from "./artifact-store.js";
import type {
  PiInstalledPackageLease,
  PiInstalledPackageSnapshot,
  PiResourceManager
} from "./resource-manager.js";

export const EXTENSION_PACKAGE_ARCHIVE_FORMAT = "npm-tar-gzip" as const;
export const EXTENSION_PACKAGE_ARCHIVE_MIME_TYPE = "application/gzip" as const;

export type ExtensionPackageExportState =
  | "pending"
  | "snapshotting"
  | "packaging"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled";

export interface ExtensionPackageExportAuthority {
  readonly extensionId: string;
  readonly extensionRevision: bigint;
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly discoveredRevision: string;
  readonly backendId: string;
  readonly backendRevision: bigint;
  readonly backendGeneration: number;
  readonly packageName: string;
  readonly packageVersion?: string;
}

export interface ExtensionPackageExportPreview extends ExtensionPackageExportAuthority {
  readonly archiveFormat: typeof EXTENSION_PACKAGE_ARCHIVE_FORMAT;
  readonly fileName: string;
  readonly maximumEntries: number;
  readonly maximumUncompressedBytes: number;
  readonly localOnly: true;
  readonly activeExport?: ExtensionPackageExportJob;
}

export interface ExtensionPackageExportJob {
  readonly id: string;
  readonly revision: bigint;
  readonly state: ExtensionPackageExportState;
  readonly authority: ExtensionPackageExportAuthority;
  readonly archiveFormat: typeof EXTENSION_PACKAGE_ARCHIVE_FORMAT;
  readonly fileName: string;
  readonly files: number;
  readonly uncompressedBytes: number;
  readonly artifact?: BlobRef;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface PrepareExtensionPackageExportInput {
  readonly exportId: string;
  readonly authority: ExtensionPackageExportAuthority;
}

const preparedExtensionPackageExportBrand = Symbol("PreparedExtensionPackageExport");

export interface PreparedExtensionPackageExport {
  readonly value: ExtensionPackageExportJob;
  readonly [preparedExtensionPackageExportBrand]: true;
}

interface StoredExtensionPackageExportAuthority {
  readonly extensionId: string;
  readonly extensionRevision: string;
  readonly resourceId: string;
  readonly resourceRevision: string;
  readonly discoveredRevision: string;
  readonly backendId: string;
  readonly backendRevision: string;
  readonly backendGeneration: number;
  readonly packageName: string;
  readonly packageVersion?: string;
}

interface StoredExtensionPackageExportJob {
  readonly id: string;
  readonly revision: string;
  readonly state: ExtensionPackageExportState;
  readonly authority: StoredExtensionPackageExportAuthority;
  readonly archiveFormat: typeof EXTENSION_PACKAGE_ARCHIVE_FORMAT;
  readonly fileName: string;
  readonly files: number;
  readonly uncompressedBytes: number;
  readonly artifact?: BlobRef;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

interface StoredExtensionPackageExportCatalog {
  readonly format: 1;
  readonly records: readonly StoredExtensionPackageExportJob[];
}

interface PreparedMutationInternal {
  readonly expected?: StoredExtensionPackageExportJob;
  readonly next: StoredExtensionPackageExportJob;
  readonly pruned: readonly StoredExtensionPackageExportJob[];
  completed: boolean;
}

interface ActiveExport {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

export interface ExtensionPackagePublisherOptions {
  readonly store: OperationalStore;
  readonly resources: PiResourceManager;
  readonly artifacts: ArtifactStore;
  readonly rootDirectory: string;
  readonly scopeId?: string;
  readonly now?: () => number;
  readonly maximumRecords?: number;
  readonly maximumConcurrentExports?: number;
  /** Deterministic owning-test seam; production leaves it undefined. */
  readonly afterStatePersisted?: (job: ExtensionPackageExportJob) => void | Promise<void>;
}

type AuthorityAssertion = () => void | Promise<void>;

const EXPORT_SETTING_KEY = "extension_package_exports";
const EXPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EXTENSION_ID = /^extension_[a-f0-9]{32}$/u;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_REVISION = /^sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const ACTIVE_STATES = new Set<ExtensionPackageExportState>(["pending", "snapshotting", "packaging", "verifying"]);
const TERMINAL_STATES = new Set<ExtensionPackageExportState>(["ready", "failed", "cancelled"]);

/**
 * Local-only publication preparation owner. It creates a standard package
 * Artifact but never claims an account, billing relationship, remote upload,
 * review, listing, or commercial publication result.
 */
export class ExtensionPackagePublisher {
  readonly #store: OperationalStore;
  readonly #resources: PiResourceManager;
  readonly #artifacts: ArtifactStore;
  readonly #rootDirectory: string;
  readonly #workingDirectory: string;
  readonly #scopeId: string;
  readonly #now: () => number;
  readonly #maximumRecords: number;
  readonly #maximumConcurrentExports: number;
  readonly #afterStatePersisted?: ExtensionPackagePublisherOptions["afterStatePersisted"];
  readonly #records = new Map<string, StoredExtensionPackageExportJob>();
  readonly #prepared = new WeakMap<object, PreparedMutationInternal>();
  readonly #active = new Map<string, ActiveExport>();
  #tail: Promise<void> = Promise.resolve();
  #initialized = false;
  #closing = false;
  #recoveredFromCorruption = false;

  constructor(options: ExtensionPackagePublisherOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new Error("Extension package export root must be a normalized absolute path.");
    }
    this.#store = options.store;
    this.#resources = options.resources;
    this.#artifacts = options.artifacts;
    this.#rootDirectory = options.rootDirectory;
    this.#workingDirectory = join(options.rootDirectory, ".working");
    this.#scopeId = options.scopeId ?? "orchestrator";
    this.#now = options.now ?? Date.now;
    this.#maximumRecords = options.maximumRecords ?? 128;
    this.#maximumConcurrentExports = options.maximumConcurrentExports ?? 2;
    this.#afterStatePersisted = options.afterStatePersisted;
    if (!Number.isSafeInteger(this.#maximumRecords) || this.#maximumRecords < 1) {
      throw new Error("Extension package export record limit is invalid.");
    }
    if (!Number.isSafeInteger(this.#maximumConcurrentExports) || this.#maximumConcurrentExports < 1) {
      throw new Error("Extension package export concurrency limit is invalid.");
    }
  }

  get recoveredFromCorruption(): boolean {
    this.#assertInitialized();
    return this.#recoveredFromCorruption;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.#workingDirectory, { recursive: true, mode: 0o700 });
    await assertCanonicalDirectory(this.#rootDirectory, "Extension package export root");
    await assertCanonicalDirectory(this.#workingDirectory, "Extension package export working directory");
    await clearWorkingDirectory(this.#workingDirectory);
    const setting = this.#store.findSetting<unknown>("service", this.#scopeId, EXPORT_SETTING_KEY);
    if (setting !== undefined) {
      try {
        const catalog = validateStoredCatalog(setting.value);
        if (catalog.records.length > this.#maximumRecords) {
          throw new Error("Extension package export catalog exceeds its record limit.");
        }
        for (const raw of catalog.records) {
          const record = validateStoredJob(raw);
          if (this.#records.has(record.id)) throw new Error("Extension package export catalog contains duplicate IDs.");
          this.#records.set(record.id, record);
        }
      } catch {
        this.#records.clear();
        this.#recoveredFromCorruption = true;
        this.#persist();
      }
    }
    let changed = false;
    for (const [id, record] of this.#records) {
      if (ACTIVE_STATES.has(record.state)) {
        this.#records.set(id, failedAfterRestart(record, this.#now()));
        changed = true;
        continue;
      }
      if (record.state === "ready") {
        try {
          const artifact = await this.#artifacts.get(record.artifact!.id);
          assertSameBlob(record.artifact!, artifact);
        } catch {
          this.#records.set(id, failedAfterArtifactLoss(record, this.#now()));
          changed = true;
        }
      }
    }
    if (changed) this.#persist();
    this.#initialized = true;
  }

  preview(authority: ExtensionPackageExportAuthority): ExtensionPackageExportPreview {
    this.#assertInitialized();
    const normalized = normalizeAuthority(authority);
    const activeExport = this.list({ extensionId: normalized.extensionId }).find((job) => ACTIVE_STATES.has(job.state));
    return {
      ...normalized,
      archiveFormat: EXTENSION_PACKAGE_ARCHIVE_FORMAT,
      fileName: extensionPackageArchiveFileName(normalized.packageName, normalized.packageVersion),
      maximumEntries: this.#resources.maximumFiles,
      maximumUncompressedBytes: this.#resources.maximumBytes,
      localOnly: true,
      ...(activeExport === undefined ? {} : { activeExport })
    };
  }

  list(filter: { readonly extensionId?: string } = {}): readonly ExtensionPackageExportJob[] {
    this.#assertInitialized();
    const extensionId = filter.extensionId === undefined ? undefined : normalizedExtensionId(filter.extensionId);
    return [...this.#records.values()]
      .filter((record) => extensionId === undefined || record.authority.extensionId === extensionId)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id, "en"))
      .map(publicJob);
  }

  get(exportId: string): ExtensionPackageExportJob {
    this.#assertInitialized();
    const record = this.#records.get(normalizedExportId(exportId));
    if (record === undefined) throw new Error("Extension package export does not exist.");
    return publicJob(record);
  }

  async prepareStart(input: PrepareExtensionPackageExportInput): Promise<PreparedExtensionPackageExport> {
    this.#assertInitialized();
    if (this.#closing) throw new Error("Extension package publisher is closing.");
    const id = normalizedExportId(input.exportId);
    const authority = storedAuthority(normalizeAuthority(input.authority));
    return this.#mutate(async () => {
      if (this.#records.has(id)) throw new Error("Extension package export ID already exists.");
      const active = [...this.#records.values()].filter((record) => ACTIVE_STATES.has(record.state));
      if (active.some((record) => record.authority.extensionId === authority.extensionId)) {
        throw new Error("This Extension already has an active package export.");
      }
      if (active.length >= this.#maximumConcurrentExports) {
        throw new Error("The local package export concurrency limit has been reached.");
      }
      const now = this.#now();
      const next: StoredExtensionPackageExportJob = {
        id,
        revision: "1",
        state: "pending",
        authority,
        archiveFormat: EXTENSION_PACKAGE_ARCHIVE_FORMAT,
        fileName: extensionPackageArchiveFileName(authority.packageName, authority.packageVersion),
        files: 0,
        uncompressedBytes: 0,
        createdAt: now,
        updatedAt: now
      };
      const terminal = [...this.#records.values()]
        .filter((record) => TERMINAL_STATES.has(record.state))
        .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id, "en"));
      const pruneCount = Math.max(0, this.#records.size + 1 - this.#maximumRecords);
      if (pruneCount > terminal.length) throw new Error("Extension package export history is full of active jobs.");
      const prepared = { value: publicJob(next), [preparedExtensionPackageExportBrand]: true as const };
      this.#prepared.set(prepared, { next, pruned: terminal.slice(0, pruneCount), completed: false });
      return prepared;
    });
  }

  async prepareCancel(exportId: string, expectedRevision: bigint): Promise<PreparedExtensionPackageExport> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const current = this.#records.get(normalizedExportId(exportId));
      if (current === undefined) throw new Error("Extension package export does not exist.");
      if (current.revision !== normalizedRevision(expectedRevision, "Extension package export revision")) {
        throw new Error("Extension package export changed after it was observed.");
      }
      if (!ACTIVE_STATES.has(current.state)) throw new Error("Extension package export is already terminal.");
      const now = this.#now();
      const next: StoredExtensionPackageExportJob = {
        ...current,
        revision: (BigInt(current.revision) + 1n).toString(10),
        state: "cancelled",
        updatedAt: now,
        completedAt: now
      };
      const prepared = { value: publicJob(next), [preparedExtensionPackageExportBrand]: true as const };
      this.#prepared.set(prepared, { expected: current, next, pruned: [], completed: false });
      return prepared;
    });
  }

  async completePreparedMutation<TResult>(
    prepared: PreparedExtensionPackageExport,
    completion: (finalize: (store: OperationalStore) => void) => TResult
  ): Promise<TResult> {
    this.#assertInitialized();
    return this.#mutate(async () => {
      const internal = this.#prepared.get(prepared as object);
      if (internal === undefined) throw new Error("Prepared package export mutation does not belong to this publisher.");
      if (internal.completed) throw new Error("Prepared package export mutation has already completed.");
      const current = this.#records.get(internal.next.id);
      if (current !== internal.expected) throw new Error("Extension package export changed before mutation commit.");
      let adopted = false;
      const finalize = (store: OperationalStore): void => {
        if (store !== this.#store) throw new Error("Prepared package export mutation must use its owning OperationalStore.");
        if (adopted) throw new Error("Prepared package export mutation can only be adopted once.");
        for (const record of internal.pruned) this.#records.delete(record.id);
        this.#records.set(internal.next.id, internal.next);
        try {
          this.#persist(store);
        } catch (error) {
          if (internal.expected === undefined) this.#records.delete(internal.next.id);
          else this.#records.set(internal.next.id, internal.expected);
          for (const record of internal.pruned) this.#records.set(record.id, record);
          throw error;
        }
        adopted = true;
      };
      try {
        const result = completion(finalize);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new Error("Prepared package export completion must be synchronous.");
        }
        if (!adopted) throw new Error("Prepared package export completion did not adopt the state change.");
        internal.completed = true;
        return result;
      } catch (error) {
        if (adopted) {
          if (internal.expected === undefined) this.#records.delete(internal.next.id);
          else this.#records.set(internal.next.id, internal.expected);
          for (const record of internal.pruned) this.#records.set(record.id, record);
        }
        throw error;
      }
    });
  }

  begin(exportId: string, assertAuthority: AuthorityAssertion): void {
    this.#assertInitialized();
    if (this.#closing) return;
    const id = normalizedExportId(exportId);
    if (this.#active.has(id)) return;
    const record = this.#records.get(id);
    if (record === undefined || record.state !== "pending") return;
    const controller = new AbortController();
    const completion = this.#run(id, assertAuthority, controller.signal).finally(() => {
      if (this.#active.get(id)?.controller === controller) this.#active.delete(id);
    });
    this.#active.set(id, { controller, completion });
  }

  abort(exportId: string): void {
    this.#active.get(normalizedExportId(exportId))?.controller.abort();
  }

  async wait(exportId: string): Promise<ExtensionPackageExportJob> {
    const id = normalizedExportId(exportId);
    await this.#active.get(id)?.completion;
    return this.get(id);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.completion));
  }

  async #run(exportId: string, assertAuthority: AuthorityAssertion, signal: AbortSignal): Promise<void> {
    let lease: PiInstalledPackageLease | undefined;
    const working = join(this.#workingDirectory, createHash("sha256").update(exportId).digest("hex"));
    try {
      const initial = this.get(exportId);
      await this.#assertAuthority(assertAuthority, signal);
      await this.#phase(exportId, "snapshotting");
      lease = await this.#resources.acquireInstalledPackage({
        resourceId: initial.authority.resourceId,
        backendId: initial.authority.backendId,
        expectedResourceVersion: initial.authority.resourceRevision,
        expectedDiscoveredRevision: initial.authority.discoveredRevision,
        expectedPackageIdentity: initial.authority.packageName,
        ...(initial.authority.packageVersion === undefined ? {} : { expectedPackageVersion: initial.authority.packageVersion })
      });
      await mkdir(working, { recursive: false, mode: 0o700 });
      const snapshotRoot = join(working, "snapshot");
      const verifyRoot = join(working, "verify");
      await mkdir(snapshotRoot, { recursive: false, mode: 0o700 });
      await mkdir(verifyRoot, { recursive: false, mode: 0o700 });
      const snapshot = await lease.snapshotTo(snapshotRoot, signal);
      if (snapshot.discoveredRevision !== initial.authority.discoveredRevision) {
        throw new Error("Installed package snapshot no longer matches the confirmed Resource revision.");
      }
      await this.#assertAuthority(assertAuthority, signal);
      await this.#phase(exportId, "packaging", { files: snapshot.files, uncompressedBytes: snapshot.bytes });
      const archivePath = join(working, "package.tgz");
      await createPackageArchive(snapshotRoot, archivePath, snapshot, signal);
      await lease.assertCurrent(signal);
      await this.#assertAuthority(assertAuthority, signal);
      await this.#phase(exportId, "verifying", { files: snapshot.files, uncompressedBytes: snapshot.bytes });
      const archiveInfo = await lstat(archivePath);
      if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error("Generated package archive is not a regular file.");
      const archiveHandle = await open(archivePath, "r");
      let artifact: BlobRef;
      try {
        artifact = await this.#artifacts.ingestFileHandle(archiveHandle, {
          expectedSize: archiveInfo.size,
          fileName: initial.fileName,
          mimeType: EXTENSION_PACKAGE_ARCHIVE_MIME_TYPE,
          signal,
          beforeFinalize: async () => {
            await lease!.assertCurrent(signal);
            await this.#assertAuthority(assertAuthority, signal);
          }
        });
      } finally {
        await archiveHandle.close().catch(() => undefined);
      }
      const materialized = await this.#artifacts.readBlob(artifact);
      if (materialized.mimeType !== EXTENSION_PACKAGE_ARCHIVE_MIME_TYPE) {
        throw new Error("Stored package Artifact has an unexpected media type.");
      }
      const materializedPath = join(working, "artifact.tgz");
      await writeFile(materializedPath, materialized.data, { flag: "wx", mode: 0o600 });
      await verifyPackageArchive(materializedPath, verifyRoot, snapshot, initial, this.#resources, signal);
      await lease.assertCurrent(signal);
      await this.#assertAuthority(assertAuthority, signal);
      await this.#ready(exportId, artifact, snapshot);
    } catch (error) {
      if (!this.#closing && !this.#isTerminal(exportId)) {
        await this.#failed(exportId, error).catch(() => undefined);
      }
    } finally {
      await lease?.release().catch(() => undefined);
      await removeOwnedWorkingDirectory(this.#workingDirectory, working).catch(() => undefined);
    }
  }

  async #assertAuthority(assertAuthority: AuthorityAssertion, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await assertAuthority();
    signal.throwIfAborted();
  }

  async #phase(
    exportId: string,
    state: Extract<ExtensionPackageExportState, "snapshotting" | "packaging" | "verifying">,
    progress?: { readonly files: number; readonly uncompressedBytes: number }
  ): Promise<void> {
    const job = await this.#transition(exportId, (current) => ({
      ...current,
      state,
      ...(progress === undefined ? {} : progress),
      revision: (BigInt(current.revision) + 1n).toString(10),
      updatedAt: this.#now()
    }));
    if (job !== undefined) await this.#afterStatePersisted?.(job);
  }

  async #ready(exportId: string, artifact: BlobRef, snapshot: PiInstalledPackageSnapshot): Promise<void> {
    const job = await this.#transition(exportId, (current) => {
      const now = this.#now();
      return {
        ...current,
        state: "ready",
        files: snapshot.files,
        uncompressedBytes: snapshot.bytes,
        artifact: publicBlob(artifact),
        revision: (BigInt(current.revision) + 1n).toString(10),
        updatedAt: now,
        completedAt: now
      };
    });
    if (job !== undefined) await this.#afterStatePersisted?.(job);
  }

  async #failed(exportId: string, error: unknown): Promise<void> {
    const job = await this.#transition(exportId, (current) => {
      const now = this.#now();
      return {
        ...current,
        state: "failed",
        revision: (BigInt(current.revision) + 1n).toString(10),
        updatedAt: now,
        completedAt: now,
        error: publicError(error)
      };
    });
    if (job !== undefined) await this.#afterStatePersisted?.(job);
  }

  async #transition(
    exportId: string,
    update: (current: StoredExtensionPackageExportJob) => StoredExtensionPackageExportJob
  ): Promise<ExtensionPackageExportJob | undefined> {
    return this.#mutate(async () => {
      const current = this.#records.get(exportId);
      if (current === undefined || TERMINAL_STATES.has(current.state)) return undefined;
      const next = validateStoredJob(update(current));
      this.#records.set(exportId, next);
      try {
        this.#persist();
      } catch (error) {
        this.#records.set(exportId, current);
        throw error;
      }
      return publicJob(next);
    });
  }

  #isTerminal(exportId: string): boolean {
    const state = this.#records.get(exportId)?.state;
    return state !== undefined && TERMINAL_STATES.has(state);
  }

  #persist(store: OperationalStore = this.#store): void {
    store.setSetting("service", this.#scopeId, EXPORT_SETTING_KEY, {
      format: 1,
      records: [...this.#records.values()].sort((left, right) => left.id.localeCompare(right.id, "en"))
    } satisfies StoredExtensionPackageExportCatalog);
  }

  #mutate<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.then(callback, callback);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Extension package publisher is not initialized.");
  }
}

async function createPackageArchive(
  snapshotRoot: string,
  archivePath: string,
  snapshot: PiInstalledPackageSnapshot,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  const entries = snapshot.entries.map((entry) => entry.path);
  if (entries.length === 0) throw new Error("Extension package snapshot is empty.");
  await createTarArchive({
    cwd: snapshotRoot,
    file: archivePath,
    gzip: true,
    portable: true,
    noMtime: true,
    noDirRecurse: true,
    prefix: "package/",
    strict: true,
    follow: false,
    onWriteEntry: () => signal.throwIfAborted()
  }, entries);
  signal.throwIfAborted();
}

async function verifyPackageArchive(
  archivePath: string,
  verifyRoot: string,
  snapshot: PiInstalledPackageSnapshot,
  job: ExtensionPackageExportJob,
  resources: PiResourceManager,
  signal: AbortSignal
): Promise<void> {
  const expected = new Map<string, { readonly kind: "directory" | "file"; readonly mode: number; readonly size: number }>(snapshot.entries.map((entry) => [
    `package/${entry.path}`,
    { kind: entry.kind, mode: entry.mode, size: entry.size }
  ] as const));
  const observed = new Set<string>();
  let totalBytes = 0;
  await listTarArchive({
    file: archivePath,
    strict: true,
    onReadEntry: (entry) => {
      signal.throwIfAborted();
      const path = normalizedArchivePath(entry.path);
      const expectedEntry = expected.get(path);
      if (expectedEntry === undefined || observed.has(path)) throw new Error("Generated package archive contains an unexpected or duplicate entry.");
      const kind = tarEntryKind(entry);
      if (kind === undefined || kind !== expectedEntry.kind || entry.size !== expectedEntry.size) {
        throw new Error("Generated package archive entry does not match its snapshot.");
      }
      if ((entry.mode ?? 0) !== expectedEntry.mode) throw new Error("Generated package archive entry mode does not match its snapshot.");
      observed.add(path);
      totalBytes += entry.size;
      if (observed.size > snapshot.entries.length || totalBytes > resources.maximumBytes) {
        throw new Error("Generated package archive exceeds the Resource limits.");
      }
    }
  });
  if (observed.size !== expected.size || [...expected.keys()].some((path) => !observed.has(path))) {
    throw new Error("Generated package archive omitted snapshot entries.");
  }
  await extractTarArchive({
    cwd: verifyRoot,
    file: archivePath,
    strict: true,
    preservePaths: false,
    unlink: true,
    noMtime: true,
    chmod: true,
    processUmask: 0,
    filter: (path, entry) => {
      signal.throwIfAborted();
      const normalized = normalizedArchivePath(path);
      const expectedEntry = expected.get(normalized);
      const kind = tarEntryKind(entry);
      if (expectedEntry === undefined || kind !== expectedEntry.kind) {
        throw new Error("Generated package archive cannot be extracted through the verified package boundary.");
      }
      return true;
    }
  });
  signal.throwIfAborted();
  const packageRoot = join(verifyRoot, "package");
  const inspection = await resources.inspectPackageCandidate(packageRoot, job.authority.backendId, signal);
  if (
    inspection.discoveredRevision !== job.authority.discoveredRevision
    || inspection.discoveredRevision !== snapshot.discoveredRevision
    || inspection.files !== snapshot.files
    || inspection.bytes !== snapshot.bytes
    || inspection.compatibility.name !== job.authority.packageName
    || inspection.compatibility.version !== job.authority.packageVersion
  ) throw new Error("Re-extracted package Artifact does not match the confirmed installed package.");
}

function tarEntryKind(entry: unknown): "directory" | "file" | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  if ("type" in entry) {
    const type = (entry as { readonly type?: unknown }).type;
    return type === "Directory" ? "directory" : type === "File" ? "file" : undefined;
  }
  const stats = entry as { readonly isDirectory?: () => boolean; readonly isFile?: () => boolean };
  if (stats.isDirectory?.()) return "directory";
  if (stats.isFile?.()) return "file";
  return undefined;
}

function normalizedArchivePath(value: string): string {
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    path === ""
    || path.includes("\\")
    || path.includes("\0")
    || path.startsWith("/")
    || !path.startsWith("package/")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("Generated package archive contains an unsafe path.");
  return path;
}

function normalizeAuthority(value: ExtensionPackageExportAuthority): ExtensionPackageExportAuthority {
  const packageVersion = value.packageVersion === undefined ? undefined : bounded(value.packageVersion, "Package version", 128);
  if (!Number.isSafeInteger(value.backendGeneration) || value.backendGeneration < 1) {
    throw new Error("Backend generation is invalid.");
  }
  return {
    extensionId: normalizedExtensionId(value.extensionId),
    extensionRevision: BigInt(normalizedRevision(value.extensionRevision, "Extension revision", true)),
    resourceId: normalizedEntityId(value.resourceId, "Resource ID"),
    resourceRevision: BigInt(normalizedRevision(value.resourceRevision, "Resource revision", true)),
    discoveredRevision: normalizedContentRevision(value.discoveredRevision),
    backendId: normalizedEntityId(value.backendId, "Backend ID"),
    backendRevision: BigInt(normalizedRevision(value.backendRevision, "Backend revision", true)),
    backendGeneration: value.backendGeneration,
    packageName: bounded(value.packageName, "Package name", 214),
    ...(packageVersion === undefined ? {} : { packageVersion })
  };
}

function storedAuthority(value: ExtensionPackageExportAuthority): StoredExtensionPackageExportAuthority {
  return {
    ...value,
    extensionRevision: value.extensionRevision.toString(10),
    resourceRevision: value.resourceRevision.toString(10),
    backendRevision: value.backendRevision.toString(10)
  };
}

function publicAuthority(value: StoredExtensionPackageExportAuthority): ExtensionPackageExportAuthority {
  return {
    ...value,
    extensionRevision: BigInt(value.extensionRevision),
    resourceRevision: BigInt(value.resourceRevision),
    backendRevision: BigInt(value.backendRevision)
  };
}

function publicJob(value: StoredExtensionPackageExportJob): ExtensionPackageExportJob {
  return {
    ...value,
    revision: BigInt(value.revision),
    authority: publicAuthority(value.authority),
    ...(value.artifact === undefined ? {} : { artifact: publicBlob(value.artifact) })
  };
}

function publicBlob(value: BlobRef): BlobRef {
  return {
    id: value.id,
    sha256: value.sha256,
    byteLength: value.byteLength,
    mimeType: value.mimeType,
    ...(value.fileName === undefined ? {} : { fileName: value.fileName })
  };
}

function validateStoredCatalog(value: unknown): StoredExtensionPackageExportCatalog {
  const object = strictObject(value, ["format", "records"], "Extension package export catalog");
  if (object.format !== 1 || !Array.isArray(object.records)) throw new Error("Extension package export catalog format is invalid.");
  return { format: 1, records: object.records.map(validateStoredJob) };
}

function validateStoredJob(value: unknown): StoredExtensionPackageExportJob {
  const object = strictObject(value, [
    "id", "revision", "state", "authority", "archiveFormat", "fileName", "files", "uncompressedBytes",
    "artifact", "createdAt", "updatedAt", "completedAt", "error"
  ], "Extension package export job");
  const id = normalizedExportId(stringValue(object.id, "Export ID"));
  const revision = normalizedStoredRevision(object.revision, "Export revision", true);
  const state = object.state;
  if (typeof state !== "string" || ![...ACTIVE_STATES, ...TERMINAL_STATES].includes(state as ExtensionPackageExportState)) {
    throw new Error("Extension package export state is invalid.");
  }
  if (object.archiveFormat !== EXTENSION_PACKAGE_ARCHIVE_FORMAT) throw new Error("Extension package export format is invalid.");
  const authority = validateStoredAuthority(object.authority);
  const fileName = bounded(stringValue(object.fileName, "Export file name"), "Export file name", 255);
  if (basename(fileName) !== fileName || !fileName.endsWith(".tgz")) throw new Error("Extension package export file name is invalid.");
  const files = nonNegativeSafeInteger(object.files, "Export file count");
  const uncompressedBytes = nonNegativeSafeInteger(object.uncompressedBytes, "Export byte count");
  const createdAt = finiteTime(object.createdAt, "Export created time");
  const updatedAt = finiteTime(object.updatedAt, "Export updated time");
  if (updatedAt < createdAt) throw new Error("Extension package export times are invalid.");
  const completedAt = object.completedAt === undefined ? undefined : finiteTime(object.completedAt, "Export completion time");
  if (completedAt !== undefined && completedAt < updatedAt) throw new Error("Extension package export completion time is invalid.");
  const error = object.error === undefined ? undefined : bounded(stringValue(object.error, "Export error"), "Export error", 2_048);
  const artifact = object.artifact === undefined ? undefined : validateBlob(object.artifact);
  if (state === "ready") {
    if (
      artifact === undefined
      || artifact.byteLength < 1
      || artifact.fileName !== fileName
      || completedAt === undefined
      || error !== undefined
    ) throw new Error("Ready package export is incomplete.");
  } else if (state === "failed") {
    if (artifact !== undefined || completedAt === undefined || error === undefined) throw new Error("Failed package export is malformed.");
  } else if (state === "cancelled") {
    if (artifact !== undefined || completedAt === undefined || error !== undefined) throw new Error("Cancelled package export is malformed.");
  } else if (artifact !== undefined || completedAt !== undefined || error !== undefined) {
    throw new Error("Active package export contains terminal fields.");
  }
  return {
    id,
    revision,
    state: state as ExtensionPackageExportState,
    authority,
    archiveFormat: EXTENSION_PACKAGE_ARCHIVE_FORMAT,
    fileName,
    files,
    uncompressedBytes,
    ...(artifact === undefined ? {} : { artifact }),
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(error === undefined ? {} : { error })
  };
}

function validateStoredAuthority(value: unknown): StoredExtensionPackageExportAuthority {
  const object = strictObject(value, [
    "extensionId", "extensionRevision", "resourceId", "resourceRevision", "discoveredRevision",
    "backendId", "backendRevision", "backendGeneration", "packageName", "packageVersion"
  ], "Extension package export authority");
  const packageVersion = object.packageVersion === undefined
    ? undefined
    : bounded(stringValue(object.packageVersion, "Package version"), "Package version", 128);
  return {
    extensionId: normalizedExtensionId(stringValue(object.extensionId, "Extension ID")),
    extensionRevision: normalizedStoredRevision(object.extensionRevision, "Extension revision", true),
    resourceId: normalizedEntityId(stringValue(object.resourceId, "Resource ID"), "Resource ID"),
    resourceRevision: normalizedStoredRevision(object.resourceRevision, "Resource revision", true),
    discoveredRevision: normalizedContentRevision(stringValue(object.discoveredRevision, "Resource content revision")),
    backendId: normalizedEntityId(stringValue(object.backendId, "Backend ID"), "Backend ID"),
    backendRevision: normalizedStoredRevision(object.backendRevision, "Backend revision", true),
    backendGeneration: positiveSafeInteger(object.backendGeneration, "Backend generation"),
    packageName: bounded(stringValue(object.packageName, "Package name"), "Package name", 214),
    ...(packageVersion === undefined ? {} : { packageVersion })
  };
}

function validateBlob(value: unknown): BlobRef {
  const object = strictObject(value, ["id", "sha256", "byteLength", "mimeType", "fileName"], "Package Artifact");
  const id = normalizedEntityId(stringValue(object.id, "Artifact ID"), "Artifact ID");
  const sha256 = stringValue(object.sha256, "Artifact SHA-256").toLowerCase();
  if (!SHA256.test(sha256)) throw new Error("Package Artifact digest is invalid.");
  const byteLength = nonNegativeSafeInteger(object.byteLength, "Artifact byte length");
  const mimeType = stringValue(object.mimeType, "Artifact media type");
  if (mimeType !== EXTENSION_PACKAGE_ARCHIVE_MIME_TYPE) throw new Error("Package Artifact media type is invalid.");
  const fileName = object.fileName === undefined ? undefined : bounded(stringValue(object.fileName, "Artifact file name"), "Artifact file name", 255);
  if (fileName !== undefined && basename(fileName) !== fileName) throw new Error("Package Artifact file name is invalid.");
  return { id, sha256, byteLength, mimeType, ...(fileName === undefined ? {} : { fileName }) };
}

function failedAfterRestart(record: StoredExtensionPackageExportJob, at: number): StoredExtensionPackageExportJob {
  return {
    ...record,
    revision: (BigInt(record.revision) + 1n).toString(10),
    state: "failed",
    updatedAt: at,
    completedAt: at,
    error: "Package export was interrupted by service restart. Start a new export from the current Extension."
  };
}

function failedAfterArtifactLoss(record: StoredExtensionPackageExportJob, at: number): StoredExtensionPackageExportJob {
  const { artifact: _artifact, ...base } = record;
  return {
    ...base,
    revision: (BigInt(record.revision) + 1n).toString(10),
    state: "failed",
    updatedAt: at,
    completedAt: at,
    error: "The prepared package Artifact is no longer available or failed integrity verification."
  };
}

function extensionPackageArchiveFileName(packageName: string, version?: string): string {
  const raw = `${packageName.replace(/^@/u, "").replace(/[\\/]+/gu, "-")}${version === undefined ? "" : `-${version}`}`;
  const safe = raw.replace(/[<>:"|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/gu, "").slice(0, 240);
  return `${safe === "" ? "extension-package" : safe}.tgz`;
}

function normalizedExtensionId(value: string): string {
  const id = value.trim();
  if (!EXTENSION_ID.test(id)) throw new Error("Extension ID is invalid.");
  return id;
}

function normalizedExportId(value: string): string {
  const id = value.trim();
  if (!EXPORT_ID.test(id)) throw new Error("Extension package export ID is invalid.");
  return id;
}

function normalizedEntityId(value: string, label: string): string {
  const id = value.trim();
  if (!ENTITY_ID.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function normalizedContentRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!SHA256_REVISION.test(revision)) throw new Error("Resource content revision is invalid.");
  return revision;
}

function normalizedRevision(value: bigint, label: string, nonZero = false): string {
  if (value < 0n || (nonZero && value === 0n)) throw new Error(`${label} is invalid.`);
  return value.toString(10);
}

function normalizedStoredRevision(value: unknown, label: string, nonZero = false): string {
  if (typeof value !== "string" || !DECIMAL.test(value) || (nonZero && value === "0")) throw new Error(`${label} is invalid.`);
  return value;
}

function bounded(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("\0") || normalized.length > maximumLength) throw new Error(`${label} is invalid.`);
  return normalized;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = nonNegativeSafeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} is invalid.`);
  return parsed;
}

function finiteTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function strictObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported current-v1 fields.`);
  return object;
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 2_048) || "Package export failed.";
}

function assertSameBlob(expected: BlobRef, actual: BlobRef): void {
  if (
    expected.id !== actual.id
    || expected.sha256 !== actual.sha256
    || expected.byteLength !== actual.byteLength
    || expected.mimeType !== actual.mimeType
    || expected.fileName !== actual.fileName
  ) throw new Error("Package Artifact identity changed.");
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory.`);
  if (!samePath(await realpath(path), path)) throw new Error(`${label} contains a path alias or junction.`);
}

async function clearWorkingDirectory(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("\0") || entry.name.includes("/") || entry.name.includes("\\")) {
      throw new Error("Extension package export working entry is invalid.");
    }
    const path = join(root, entry.name);
    const info = await lstat(path);
    await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true });
  }
}

async function removeOwnedWorkingDirectory(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const expected = join(canonicalRoot, basename(path));
  if (!samePath(resolve(path), expected) || basename(path) === "" || basename(path) === "." || basename(path) === "..") {
    throw new Error("Extension package export working path escaped its owner.");
  }
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (info.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (info.isDirectory()) {
    const canonical = await realpath(path);
    if (!samePath(canonical, path)) throw new Error("Extension package export working directory was replaced.");
  }
  await rm(path, { recursive: info.isDirectory(), force: true });
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof (value as { readonly then?: unknown }).then === "function";
}
