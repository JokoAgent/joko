import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { BlobRef } from "@joko/core";
import { sanitizeBrowserFileName, type BrowserDownloadHandler, type BrowserDownloadSource, type BrowserLease,
  type BrowserLeaseFence, type BrowserProvider, type BrowserTakeoverFence } from "@joko/tool-browser";

import type { ArtifactStore } from "./artifact-store.js";
import { toProtoTimestamp } from "./proto-mapper.js";

export type BrowserTransferArtifactStore = Pick<ArtifactStore, "resolveBlobFile" | "ingestPath">;

export type BrowserTransferProvider = Pick<BrowserProvider, "generation" | "acquireAgentLease" | "releaseAgentLease" | "uploadFiles" | "recover">;

export interface BrowserTransferConnection {
  readonly id: string;
  readonly documentId: string;
  readonly assertCurrent: () => void;
  readonly humanTakeover?: BrowserTakeoverFence;
}

export interface BrowserTransferCoordinatorOptions {
  readonly artifacts: BrowserTransferArtifactStore;
  readonly provider: BrowserTransferProvider;
  /** Optional durable public-state repository. It must never persist local paths. */
  readonly repository?: BrowserTransferRepository;
  readonly browserProviderId?: string;
  readonly agentLeaseTtlMs?: number;
  readonly maximumRetainedTransfers?: number;
  readonly now?: () => number;
  /** Content-free transition hook for destructive-action quiet-period fencing. */
  readonly onActivityTransition?: () => void;
}

export interface BrowserTransferMetadata {
  readonly toolCallId?: string;
}

export interface BrowserTransferFilter {
  readonly browserProviderId?: string;
  readonly pageId?: string;
  readonly state?: contract.BrowserTransferState;
  readonly direction?: contract.TransferDirection;
}

interface TransferRecord {
  readonly id: string;
  readonly browserProviderId: string;
  readonly pageId: string;
  readonly toolCallId: string;
  readonly direction: contract.TransferDirection;
  readonly initiatedAt: number;
  readonly generation: number;
  readonly fileName?: string;
  state: contract.BrowserTransferState;
  startedAt?: number;
  completedAt?: number;
  blob?: BlobRef;
  artifact?: BrowserTransferArtifact;
  error?: TransferError;
}

export interface BrowserTransferArtifact extends BlobRef {
  readonly createdAt: number;
  readonly expiresAt?: number;
}

/** Public, path-free transfer state suitable for the Operational Store. */
export interface PersistedBrowserTransfer {
  readonly id: string;
  readonly browserProviderId: string;
  readonly pageId: string;
  readonly toolCallId: string;
  readonly direction: contract.TransferDirection;
  readonly initiatedAt: number;
  readonly generation: number;
  readonly fileName?: string;
  readonly state: contract.BrowserTransferState;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly blob?: BlobRef;
  readonly artifact?: BrowserTransferArtifact;
  readonly error?: TransferError;
}

export interface BrowserTransferRepository {
  list(browserProviderId: string): readonly PersistedBrowserTransfer[];
  putMany(records: readonly PersistedBrowserTransfer[]): void;
  delete(browserProviderId: string, browserTransferId: string): void;
}

export interface TransferError {
  readonly code: string;
  readonly phase: string;
  readonly message: string;
  readonly stateMayHaveChanged: boolean;
}

class BrowserGenerationFencedError extends Error {
  constructor() {
    super("Browser generation changed before the transfer could be dispatched.");
    this.name = "BrowserGenerationFencedError";
  }
}

class BrowserUploadAuthorityError extends Error {}

interface ActiveDownload {
  readonly cancel: () => Promise<void>;
  pendingCancellation?: Promise<void>;
}

/**
 * Owns process-local BrowserTransfer state while materialized blobs/artifacts
 * remain durable in ArtifactStore. Uploads are serialized around the provider's
 * exact authenticated human takeover or the exclusive agent lease; downloads
 * may ingest concurrently.
 */
export class BrowserTransferCoordinator {
  readonly #artifacts: BrowserTransferArtifactStore;
  readonly #provider: BrowserTransferProvider;
  readonly #repository: BrowserTransferRepository | undefined;
  readonly #browserProviderId: string;
  readonly #agentLeaseTtlMs: number;
  readonly #maximumRetainedTransfers: number;
  readonly #now: () => number;
  readonly #onActivityTransition: () => void;
  readonly #records = new Map<string, TransferRecord>();
  readonly #activeDownloads = new Map<string, ActiveDownload>();
  #uploadTail: Promise<void> = Promise.resolve();

  constructor(options: BrowserTransferCoordinatorOptions) {
    if ((options.browserProviderId ?? "browser").trim() === "") throw new Error("browserProviderId must not be empty.");
    const leaseTtl = options.agentLeaseTtlMs ?? 5 * 60 * 1_000;
    if (!Number.isSafeInteger(leaseTtl) || leaseTtl < 1_000 || leaseTtl > 60 * 60 * 1_000) {
      throw new RangeError("agentLeaseTtlMs must be between one second and one hour.");
    }
    const maximumRetained = options.maximumRetainedTransfers ?? 2_000;
    if (!Number.isSafeInteger(maximumRetained) || maximumRetained < 1) {
      throw new RangeError("maximumRetainedTransfers must be a positive safe integer.");
    }
    this.#artifacts = options.artifacts;
    this.#provider = options.provider;
    this.#repository = options.repository;
    this.#browserProviderId = options.browserProviderId ?? "browser";
    this.#agentLeaseTtlMs = leaseTtl;
    this.#maximumRetainedTransfers = maximumRetained;
    this.#now = options.now ?? Date.now;
    this.#onActivityTransition = options.onActivityTransition ?? (() => undefined);
    for (const persisted of this.#repository?.list(this.#browserProviderId) ?? []) {
      const record = restoreRecord(persisted, this.#browserProviderId);
      if (record === undefined) continue;
      if (!isTerminal(record.state)) {
        record.state = contract.BrowserTransferState.FAILED;
        record.completedAt = this.#now();
        record.error = {
          code: "BROWSER_TRANSFER_OUTCOME_UNKNOWN",
          phase: "startup_recovery",
          message: "Orchestrator restarted before this browser transfer reached a durable terminal outcome; retry it explicitly.",
          stateMayHaveChanged: persisted.state === contract.BrowserTransferState.RUNNING
        };
        this.persist(record);
      }
      this.#records.set(record.id, record);
    }
    this.pruneRetained();
  }

  get browserProviderId(): string {
    return this.#browserProviderId;
  }

  /** A BrowserProvider.onDownload-compatible hook. */
  readonly onDownload: BrowserDownloadHandler = async download => {
    const transfer = await this.ingestDownload(download);
    if (transfer.state === contract.BrowserTransferState.CANCELLED) return "cancelled";
    if (transfer.state === contract.BrowserTransferState.COMPLETED) return "completed";
    throw new Error("Browser download artifact ingest failed.");
  };

  /**
   * Resolve a durable blob, acquire a generation-fenced agent lease, and set it
   * on the requested file input. Failed attempts remain queryable.
   */
  async upload(
    blob: BlobRef,
    pageId: string,
    inputSelector: string,
    connection: BrowserTransferConnection,
    metadata: BrowserTransferMetadata = {}
  ): Promise<contract.BrowserTransfer> {
    const [transfer] = await this.uploadBatch([blob], pageId, inputSelector, connection, metadata);
    return transfer!;
  }

  async uploadBatch(
    blobs: readonly BlobRef[],
    pageId: string,
    inputSelector: string,
    connection: BrowserTransferConnection,
    metadata: BrowserTransferMetadata = {}
  ): Promise<readonly contract.BrowserTransfer[]> {
    if (blobs.length === 0 || blobs.length > 16) throw new Error("A Browser upload requires between one and sixteen files.");
    const records = blobs.map((blob): TransferRecord => ({
      id: randomUUID(),
      browserProviderId: this.#browserProviderId,
      pageId,
      toolCallId: metadata.toolCallId ?? "",
      direction: contract.TransferDirection.UPLOAD,
      initiatedAt: this.#now(),
      generation: this.#provider.generation,
      state: contract.BrowserTransferState.PENDING,
      blob: { ...blob }
    }));
    this.remember(records);
    return this.queueUpload(() => this.performUpload(records, inputSelector, connection));
  }

  /** Record the original native download before waiting for its bytes. */
  async ingestDownload(
    download: BrowserDownloadSource,
    metadata: BrowserTransferMetadata = {}
  ): Promise<contract.BrowserTransfer> {
    const { pageId, fileName, generation } = download;
    const displayName = isSanitizedDownloadName(fileName) ? fileName : undefined;
    const record: TransferRecord = {
      id: randomUUID(),
      browserProviderId: this.#browserProviderId,
      pageId,
      toolCallId: metadata.toolCallId ?? "",
      direction: contract.TransferDirection.DOWNLOAD,
      initiatedAt: this.#now(),
      generation,
      ...(displayName === undefined ? {} : { fileName: displayName }),
      state: contract.BrowserTransferState.RUNNING,
      startedAt: this.#now()
    };
    this.remember([record]);
    const assertCurrent = () => {
      if (isTerminal(record.state) || record.generation !== this.#provider.generation) throw new BrowserGenerationFencedError();
      download.assertCurrent();
    };
    let phase: "download" | "artifact_ingest" = "download";
    try {
      validatePageId(pageId);
      if (displayName === undefined) throw new Error("Browser download name was not sanitized.");
      assertCurrent();
      const active: ActiveDownload = { cancel: download.cancel };
      this.#activeDownloads.set(record.id, active);
      let verifiedLocalPath: string;
      try {
        verifiedLocalPath = await download.stage();
      } finally {
        this.#activeDownloads.delete(record.id);
        if (active.pendingCancellation !== undefined) await active.pendingCancellation.catch(() => undefined);
      }
      assertCurrent();
      phase = "artifact_ingest";
      const artifact = await this.#artifacts.ingestPath(verifiedLocalPath, { fileName: displayName, assertCurrent });
      assertCurrent();
      record.artifact = publicArtifact(artifact);
      record.blob = publicBlob(artifact);
      record.state = contract.BrowserTransferState.COMPLETED;
      record.completedAt = this.#now();
      this.persist(record);
      this.pruneRetained();
    } catch (error) {
      this.fail(record, error instanceof BrowserGenerationFencedError ? generationFencedError(true) : phase === "download" ? {
        code: "BROWSER_DOWNLOAD_FAILED",
        phase,
        message: "The Browser did not finish downloading this file.",
        stateMayHaveChanged: false
      } : {
        code: "BROWSER_DOWNLOAD_INGEST_FAILED",
        phase,
        message: "The browser download could not be validated and stored as an artifact.",
        stateMayHaveChanged: false
      });
    }
    return this.present(record);
  }

  async cancelDownload(transferId: string, pageId: string, generation: number, assertCurrent: () => void): Promise<boolean> {
    const record = this.#records.get(transferId);
    const active = this.#activeDownloads.get(transferId);
    if (record === undefined || active === undefined || record.direction !== contract.TransferDirection.DOWNLOAD
      || record.toolCallId !== "" || record.pageId !== pageId || record.generation !== generation
      || generation !== this.#provider.generation || isTerminal(record.state)) return false;
    assertCurrent();
    const request = active.pendingCancellation ??= (async () => {
      try {
        await active.cancel();
      } catch {
        throw new Error("The Browser could not confirm download cancellation.");
      }
      if (isTerminal(record.state) || generation !== this.#provider.generation) return;
      this.persistRecords([{ ...record, state: contract.BrowserTransferState.CANCELLED, completedAt: this.#now() }], [record]);
      this.pruneRetained();
    })();
    try {
      await request;
    } finally {
      if (active.pendingCancellation === request) delete active.pendingCancellation;
    }
    return record.state === contract.BrowserTransferState.CANCELLED;
  }

  get(browserTransferId: string): contract.BrowserTransfer | undefined {
    const record = this.#records.get(browserTransferId);
    return record === undefined ? undefined : this.present(record);
  }

  list(filter: BrowserTransferFilter = {}): readonly contract.BrowserTransfer[] {
    if (filter.browserProviderId !== undefined && filter.browserProviderId !== "" && filter.browserProviderId !== this.#browserProviderId) return [];
    return [...this.#records.values()]
      .filter((record) =>
        (filter.pageId === undefined || filter.pageId === "" || record.pageId === filter.pageId) &&
        (filter.state === undefined || record.state === filter.state) &&
        (filter.direction === undefined || record.direction === filter.direction)
      )
      .sort((left, right) => right.initiatedAt - left.initiatedAt || right.id.localeCompare(left.id))
      .map((record) => this.present(record));
  }

  hasInFlightActivity(): boolean {
    return [...this.#records.values()].some((record) =>
      record.state === contract.BrowserTransferState.PENDING
      || record.state === contract.BrowserTransferState.RUNNING
    );
  }

  /** Fence queued/running transfers before restarting the provider generation. */
  async recover(): Promise<void> {
    this.fenceBeforeGeneration(this.#provider.generation + 1);
    await this.#provider.recover();
  }

  /** Restart and recover share the same generation-fenced provider primitive. */
  restart(): Promise<void> {
    return this.recover();
  }

  fenceBeforeGeneration(minimumGeneration: number): void {
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0) {
      throw new RangeError("minimumGeneration must be a non-negative safe integer.");
    }
    const retired = [...this.#records.values()].filter(record => record.generation < minimumGeneration && !isTerminal(record.state));
    this.failRecords(retired.filter(record => record.state === contract.BrowserTransferState.RUNNING), generationFencedError(true));
    this.failRecords(retired.filter(record => record.state === contract.BrowserTransferState.PENDING), generationFencedError(false));
  }

  private async performUpload(
    records: readonly TransferRecord[],
    inputSelector: string,
    connection: BrowserTransferConnection
  ): Promise<readonly contract.BrowserTransfer[]> {
    const record = records[0]!;
    if (isTerminal(record.state)) return records.map(member => this.present(member));
    let phase: "input_validation" | "blob_resolution" | "lease" | "browser_action" = "input_validation";
    let lease: BrowserLease | undefined;
    const assertCurrent = () => {
      if (isTerminal(record.state) || record.generation !== this.#provider.generation) throw new BrowserGenerationFencedError();
      try { connection.assertCurrent(); }
      catch { throw new BrowserUploadAuthorityError(); }
    };
    try {
      validatePageId(record.pageId);
      validateInputSelector(inputSelector);
      validateConnection(connection);
      assertCurrent();
      phase = "blob_resolution";
      const files = await Promise.all(records.map(async member => {
        const blob = member.blob!;
        const file = await this.#artifacts.resolveBlobFile(blob);
        return { ...file, sha256: blob.sha256, byteLength: blob.byteLength };
      }));
      assertCurrent();
      let owner: BrowserTakeoverFence | BrowserLeaseFence;
      if (isOwnedTakeoverPage(connection.humanTakeover, record, connection)) owner = connection.humanTakeover;
      else {
        phase = "lease";
        lease = this.#provider.acquireAgentLease(connection.id, this.#agentLeaseTtlMs);
        if (lease.generation !== record.generation) throw new BrowserGenerationFencedError();
        owner = lease;
      }
      phase = "browser_action";
      await this.#provider.uploadFiles(record.pageId, owner, {
        type: "upload", selector: inputSelector, paths: files.map(file => file.path)
      }, {
        documentId: connection.documentId,
        fileIdentities: files,
        assertCurrent,
        markDispatched: () => {
          assertCurrent();
          const startedAt = this.#now();
          for (const [index, member] of records.entries()) {
            member.state = contract.BrowserTransferState.RUNNING;
            member.startedAt = startedAt;
            member.blob = { ...member.blob!, fileName: files[index]!.fileName };
          }
          this.persistRecords(records);
        }
      });
      assertCurrent();
      const completedAt = this.#now();
      this.persistRecords(records.map(member => ({
        ...member, state: contract.BrowserTransferState.COMPLETED, completedAt
      })), records);
      this.pruneRetained();
    } catch (error) {
      if (!isTerminal(record.state)) {
        const dispatched = record.startedAt !== undefined;
        if (error instanceof BrowserGenerationFencedError) {
          this.failRecords(records, generationFencedError(dispatched));
        } else if (error instanceof BrowserUploadAuthorityError) {
          this.failRecords(records, {
            code: "BROWSER_UPLOAD_AUTHORITY_RETIRED",
            phase: "authorization",
            message: "The Browser upload's original connection, task, or host policy is no longer active.",
            stateMayHaveChanged: dispatched
          });
        } else {
          this.failRecords(records, uploadErrorForPhase(phase, dispatched));
        }
      }
    } finally {
      if (lease !== undefined) {
        try {
          await this.#provider.releaseAgentLease(lease);
        } catch {
          // A recover/stop fence is expected to invalidate an in-flight lease.
        }
      }
    }
    return records.map(member => this.present(member));
  }

  private queueUpload(task: () => Promise<readonly contract.BrowserTransfer[]>): Promise<readonly contract.BrowserTransfer[]> {
    const queued = this.#uploadTail.then(task, task);
    this.#uploadTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private fail(record: TransferRecord, error: TransferError): void {
    this.failRecords([record], error);
  }

  private failRecords(records: readonly TransferRecord[], error: TransferError): void {
    const pending = records.filter(record => !isTerminal(record.state));
    if (pending.length === 0) return;
    const completedAt = this.#now();
    for (const record of pending) {
      record.state = contract.BrowserTransferState.FAILED;
      record.error = error;
      record.completedAt = completedAt;
    }
    this.persistRecords(pending);
    this.pruneRetained();
  }

  private remember(records: readonly TransferRecord[]): void {
    for (const record of records) this.#records.set(record.id, record);
    this.persistRecords(records);
    this.pruneRetained();
  }

  private pruneRetained(): void {
    if (this.#records.size <= this.#maximumRetainedTransfers) return;
    for (const [id, candidate] of this.#records) {
      if (!isTerminal(candidate.state)) continue;
      this.#records.delete(id);
      this.#repository?.delete(this.#browserProviderId, id);
      if (this.#records.size <= this.#maximumRetainedTransfers) break;
    }
  }

  private persist(record: TransferRecord): void {
    this.persistRecords([record]);
  }

  private persistRecords(records: readonly TransferRecord[], adoptInto?: readonly TransferRecord[]): void {
    this.#repository?.putMany(records.map(persistedRecord));
    adoptInto?.forEach((record, index) => Object.assign(record, records[index]));
    try {
      this.#onActivityTransition();
    } catch {
      // Observability must not change transfer durability or Provider effects.
    }
  }

  private present(record: TransferRecord): contract.BrowserTransfer {
    return create(contract.BrowserTransferSchema, {
      browserTransferId: record.id,
      browserProviderId: record.browserProviderId,
      pageId: record.pageId,
      toolCallId: record.toolCallId,
      direction: record.direction,
      state: record.state,
      fileName: record.fileName ?? "",
      cancellable: record.direction === contract.TransferDirection.DOWNLOAD && record.toolCallId === ""
        && !isTerminal(record.state) && this.#activeDownloads.has(record.id),
      blob: record.blob === undefined ? undefined : protoBlob(record.blob, record.artifact, record.direction),
      artifact: record.artifact === undefined ? undefined : create(contract.ArtifactRefSchema, {
        artifactId: record.artifact.id,
        blob: protoBlob(record.artifact, record.artifact, record.direction),
        kind: contract.ArtifactKind.FILE,
        title: record.artifact.fileName ?? "Browser download"
      }),
      startedAt: toProtoTimestamp(record.startedAt ?? record.initiatedAt),
      completedAt: record.completedAt === undefined ? undefined : toProtoTimestamp(record.completedAt),
      error: record.error === undefined ? undefined : create(contract.ErrorInfoSchema, {
        code: record.error.code,
        phase: record.error.phase,
        message: record.error.message,
        severity: contract.ErrorSeverity.RETRYABLE,
        retryable: true,
        queueImpact: record.error.stateMayHaveChanged ? contract.StateImpact.MAY_HAVE_CHANGED : contract.StateImpact.UNCHANGED,
        workspaceImpact: contract.StateImpact.UNCHANGED,
        nativeSessionImpact: contract.StateImpact.UNCHANGED
      })
    });
  }
}

function isOwnedTakeoverPage(
  takeover: BrowserTakeoverFence | undefined,
  record: Pick<TransferRecord, "browserProviderId" | "pageId" | "generation">,
  connection: BrowserTransferConnection
): takeover is BrowserTakeoverFence {
  return takeover !== undefined
    && takeover.providerId === record.browserProviderId
    && takeover.pageId === record.pageId
    && takeover.generation === record.generation
    && takeover.owner === connection.id;
}

function protoBlob(blob: BlobRef, artifact: BrowserTransferArtifact | undefined, direction: contract.TransferDirection): contract.BlobRef {
  return create(contract.BlobRefSchema, {
    blobId: blob.id,
    fileName: blob.fileName ?? "",
    mediaType: blob.mimeType,
    byteSize: BigInt(blob.byteLength),
    sha256Hex: blob.sha256.replace(/^sha256:/u, ""),
    createdAt: artifact === undefined ? undefined : toProtoTimestamp(artifact.createdAt),
    expiresAt: artifact?.expiresAt === undefined ? undefined : toProtoTimestamp(artifact.expiresAt),
    disposition: direction === contract.TransferDirection.DOWNLOAD
      ? contract.BlobDisposition.ARTIFACT
      : contract.BlobDisposition.ATTACHMENT
  });
}

function persistedRecord(record: TransferRecord): PersistedBrowserTransfer {
  return {
    id: record.id,
    browserProviderId: record.browserProviderId,
    pageId: record.pageId,
    toolCallId: record.toolCallId,
    direction: record.direction,
    initiatedAt: record.initiatedAt,
    generation: record.generation,
    state: record.state,
    ...(record.fileName === undefined ? {} : { fileName: record.fileName }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.blob === undefined ? {} : { blob: publicBlob(record.blob) }),
    ...(record.artifact === undefined ? {} : { artifact: publicArtifact(record.artifact) }),
    ...(record.error === undefined ? {} : { error: { ...record.error } })
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

function publicArtifact(value: BrowserTransferArtifact): BrowserTransferArtifact {
  return {
    ...publicBlob(value),
    createdAt: value.createdAt,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt })
  };
}

function restoreRecord(value: PersistedBrowserTransfer, browserProviderId: string): TransferRecord | undefined {
  if (
    value.browserProviderId !== browserProviderId ||
    value.id.trim() === "" ||
    value.pageId.trim() === "" ||
    !Number.isSafeInteger(value.initiatedAt) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Object.values(contract.TransferDirection).includes(value.direction) ||
    !Object.values(contract.BrowserTransferState).includes(value.state)
  ) return undefined;
  return {
    id: value.id,
    browserProviderId: value.browserProviderId,
    pageId: value.pageId,
    toolCallId: value.toolCallId,
    direction: value.direction,
    initiatedAt: value.initiatedAt,
    generation: value.generation,
    state: value.state,
    ...(value.direction === contract.TransferDirection.DOWNLOAD && isSanitizedDownloadName(value.fileName)
      ? { fileName: value.fileName } : {}),
    ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }),
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    ...(value.blob === undefined ? {} : { blob: publicBlob(value.blob) }),
    ...(value.artifact === undefined ? {} : { artifact: publicArtifact(value.artifact) }),
    ...(value.error === undefined ? {} : { error: { ...value.error } })
  };
}

function validatePageId(pageId: string): void {
  if (pageId.trim() === "" || pageId.length > 512) throw new Error("A bounded browser page ID is required.");
}

function validateInputSelector(selector: string): void {
  if (selector.trim() === "" || selector.length > 4_096) throw new Error("A bounded browser file-input selector is required.");
}

function validateConnection(connection: BrowserTransferConnection): void {
  if (connection.id.trim() === "" || connection.id.length > 512) throw new Error("An authenticated connection ID is required.");
  if (connection.documentId.trim() === "" || connection.documentId.length > 128) throw new Error("An original Browser document ID is required.");
}

function isSanitizedDownloadName(fileName: unknown): fileName is string {
  return typeof fileName === "string" && fileName.length > 0 && fileName.length <= 180
    && sanitizeBrowserFileName(fileName) === fileName;
}

function isTerminal(state: contract.BrowserTransferState): boolean {
  return state === contract.BrowserTransferState.COMPLETED ||
    state === contract.BrowserTransferState.FAILED ||
    state === contract.BrowserTransferState.CANCELLED;
}

function generationFencedError(stateMayHaveChanged: boolean): TransferError {
  return {
    code: "BROWSER_GENERATION_FENCED",
    phase: "generation_fence",
    message: "The browser restarted before this transfer completed; retry against the current page generation.",
    stateMayHaveChanged
  };
}

function uploadErrorForPhase(phase: "input_validation" | "blob_resolution" | "lease" | "browser_action", dispatched: boolean): TransferError {
  switch (phase) {
    case "input_validation":
      return {
        code: "BROWSER_UPLOAD_INVALID",
        phase,
        message: "The browser upload request is missing a valid page, input selector, or connection.",
        stateMayHaveChanged: false
      };
    case "blob_resolution":
      return {
        code: "BROWSER_UPLOAD_SOURCE_INVALID",
        phase,
        message: "The selected upload artifact is unavailable or failed path validation.",
        stateMayHaveChanged: false
      };
    case "lease":
      return {
        code: "BROWSER_LEASE_UNAVAILABLE",
        phase,
        message: "The browser is controlled by another lease; retry when it is available.",
        stateMayHaveChanged: false
      };
    case "browser_action":
      return {
        code: "BROWSER_UPLOAD_FAILED",
        phase,
        message: "The browser file-input action failed; the page may need to be refreshed before retrying.",
        stateMayHaveChanged: dispatched
      };
  }
}
