import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { BlobRef } from "@joko/core";
import type { BrowserAction, BrowserLease, BrowserLeaseFence, BrowserPageState, BrowserTakeoverFence } from "@joko/tool-browser";

import type { ArtifactRecord } from "./artifact-store.js";
import { toProtoTimestamp } from "./proto-mapper.js";

export interface BrowserTransferArtifactStore {
  resolveBlobPath(blob: BlobRef): Promise<string>;
  ingestPath(sourcePath: string, options?: { fileName?: string; mimeType?: string; expiresAt?: number }): Promise<ArtifactRecord>;
}

export interface BrowserTransferProvider {
  readonly generation: number;
  acquireAgentLease(owner: string, ttlMs?: number): BrowserLease;
  releaseAgentLease(lease: BrowserLeaseFence): Promise<void>;
  act(pageId: string, lease: BrowserLeaseFence, action: BrowserAction): Promise<BrowserPageState>;
  runHumanTakeoverOperation<T>(
    takeover: BrowserTakeoverFence,
    operation: (page: BrowserTakeoverUploadPage) => Promise<T>
  ): Promise<T>;
  recover(): Promise<void>;
}

interface BrowserTakeoverUploadPage {
  setInputFiles(selector: string, files: string[]): Promise<void>;
}

export interface BrowserTransferConnection {
  readonly id: string;
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
  readonly state: contract.BrowserTransferState;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly blob?: BlobRef;
  readonly artifact?: BrowserTransferArtifact;
  readonly error?: TransferError;
}

export interface BrowserTransferRepository {
  list(browserProviderId: string): readonly PersistedBrowserTransfer[];
  put(record: PersistedBrowserTransfer): void;
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
  readonly onDownload = async (pageId: string, verifiedLocalPath: string, sanitizedFileName: string): Promise<void> => {
    const transfer = await this.ingestDownload(pageId, verifiedLocalPath, sanitizedFileName);
    if (transfer.state !== contract.BrowserTransferState.COMPLETED) {
      throw new Error("Browser download artifact ingest failed.");
    }
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
    const record: TransferRecord = {
      id: randomUUID(),
      browserProviderId: this.#browserProviderId,
      pageId,
      toolCallId: metadata.toolCallId ?? "",
      direction: contract.TransferDirection.UPLOAD,
      initiatedAt: this.#now(),
      generation: this.#provider.generation,
      state: contract.BrowserTransferState.PENDING,
      blob: { ...blob }
    };
    this.remember(record);
    return this.queueUpload(() => this.performUpload(record, inputSelector, connection));
  }

  /** Ingest a verified BrowserProvider staging path into durable artifacts. */
  async ingestDownload(
    pageId: string,
    verifiedLocalPath: string,
    sanitizedFileName: string,
    metadata: BrowserTransferMetadata = {}
  ): Promise<contract.BrowserTransfer> {
    const record: TransferRecord = {
      id: randomUUID(),
      browserProviderId: this.#browserProviderId,
      pageId,
      toolCallId: metadata.toolCallId ?? "",
      direction: contract.TransferDirection.DOWNLOAD,
      initiatedAt: this.#now(),
      generation: this.#provider.generation,
      state: contract.BrowserTransferState.RUNNING,
      startedAt: this.#now()
    };
    this.remember(record);
    try {
      validatePageId(pageId);
      validateDownloadName(sanitizedFileName);
      const artifact = await this.#artifacts.ingestPath(verifiedLocalPath, { fileName: sanitizedFileName });
      record.artifact = publicArtifact(artifact);
      record.blob = publicBlob(artifact);
      record.state = contract.BrowserTransferState.COMPLETED;
      record.completedAt = this.#now();
      this.persist(record);
      this.pruneRetained();
    } catch {
      this.fail(record, {
        code: "BROWSER_DOWNLOAD_INGEST_FAILED",
        phase: "artifact_ingest",
        message: "The browser download could not be validated and stored as an artifact.",
        stateMayHaveChanged: false
      });
    }
    return this.present(record);
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
    for (const record of this.#records.values()) {
      if (record.generation >= minimumGeneration || isTerminal(record.state)) continue;
      this.fail(record, generationFencedError(record.state === contract.BrowserTransferState.RUNNING));
    }
  }

  private async performUpload(
    record: TransferRecord,
    inputSelector: string,
    connection: BrowserTransferConnection
  ): Promise<contract.BrowserTransfer> {
    if (isTerminal(record.state)) return this.present(record);
    let phase: "input_validation" | "blob_resolution" | "lease" | "browser_action" = "input_validation";
    let lease: BrowserLease | undefined;
    try {
      validatePageId(record.pageId);
      validateInputSelector(inputSelector);
      validateConnection(connection);
      phase = "blob_resolution";
      const path = await this.#artifacts.resolveBlobPath(record.blob!);
      if (record.generation !== this.#provider.generation) throw new BrowserGenerationFencedError();
      record.state = contract.BrowserTransferState.RUNNING;
      record.startedAt = this.#now();
      this.persist(record);
      phase = "browser_action";
      if (isOwnedTakeoverPage(connection.humanTakeover, record, connection)) {
        await this.#provider.runHumanTakeoverOperation(connection.humanTakeover, (page) =>
          page.setInputFiles(inputSelector, [path])
        );
      } else {
        phase = "lease";
        lease = this.#provider.acquireAgentLease(connection.id, this.#agentLeaseTtlMs);
        if (lease.generation !== record.generation) throw new BrowserGenerationFencedError();
        phase = "browser_action";
        await this.#provider.act(record.pageId, lease, {
          type: "upload",
          selector: inputSelector,
          paths: [path]
        });
      }
      if (!isTerminal(record.state)) {
        record.state = contract.BrowserTransferState.COMPLETED;
        record.completedAt = this.#now();
        this.persist(record);
        this.pruneRetained();
      }
    } catch (error) {
      if (!isTerminal(record.state)) {
        if (error instanceof BrowserGenerationFencedError) {
          this.fail(record, generationFencedError(false));
        } else {
          this.fail(record, uploadErrorForPhase(phase));
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
    return this.present(record);
  }

  private queueUpload(task: () => Promise<contract.BrowserTransfer>): Promise<contract.BrowserTransfer> {
    const queued = this.#uploadTail.then(task, task);
    this.#uploadTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private fail(record: TransferRecord, error: TransferError): void {
    if (isTerminal(record.state)) return;
    record.state = contract.BrowserTransferState.FAILED;
    record.error = error;
    record.completedAt = this.#now();
    this.persist(record);
    this.pruneRetained();
  }

  private remember(record: TransferRecord): void {
    this.#records.set(record.id, record);
    this.persist(record);
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
    this.#repository?.put(persistedRecord(record));
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
}

function validateDownloadName(fileName: string): void {
  if (
    fileName.trim() === "" ||
    fileName.length > 180 ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    /[\u0000-\u001f]/u.test(fileName)
  ) {
    throw new Error("Browser download name was not sanitized.");
  }
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

function uploadErrorForPhase(phase: "input_validation" | "blob_resolution" | "lease" | "browser_action"): TransferError {
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
        stateMayHaveChanged: true
      };
  }
}
