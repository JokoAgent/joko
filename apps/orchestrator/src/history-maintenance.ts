import { randomUUID } from "node:crypto";
import { rmSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { OperationalStore } from "@joko/store";

import {
  HistoryWorkCancelledError,
  runHistoryMaintenanceWorker,
  type HistoryWorkBindingReplacement,
  type HistoryWorkCandidate,
  type HistoryWorkCleanupResult,
  type HistoryWorkControls,
  type HistoryWorkInput,
  type HistoryWorkPhase
} from "./history-maintenance-worker.js";

export const HISTORY_RETENTION_OPTIONS = ["7-days", "1-month", "3-months", "6-months"] as const;
export type HistoryRetention = (typeof HISTORY_RETENTION_OPTIONS)[number];
export const DEFAULT_HISTORY_RETENTION: HistoryRetention = "7-days";

const SCAN_TTL_MS = 10 * 60_000;
const MAXIMUM_SCANS = 8;
const MAXIMUM_JOBS = 8;
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

export interface HistoryMaintenanceScan {
  readonly scanId: string;
  readonly retention: HistoryRetention;
  readonly includeActiveTasks: boolean;
  readonly scannedAt: number;
  readonly olderThan: number;
  readonly activeTaskCount: number;
  readonly deletedTaskCount: number;
  readonly archivedTaskCount: number;
  readonly messageCount: number;
  readonly estimatedHistoryBytes: number;
  readonly databaseBytes: number;
  readonly temporaryBytesRequired: number;
  readonly databaseVolumeFreeBytes?: number;
  readonly expiresAt: number;
}

export interface HistoryMaintenanceResult {
  readonly activeTaskCount: number;
  readonly deletedTaskCount: number;
  readonly archivedTaskCount: number;
  readonly messageCount: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly reclaimedBytes: number;
  readonly backupCreated: boolean;
  readonly skippedTaskCount: number;
}

export type HistoryMaintenanceCleanupOutcome =
  | { readonly outcome: "completed"; readonly result: HistoryMaintenanceResult }
  | { readonly outcome: "scan-expired" }
  | { readonly outcome: "storage-changed" }
  | { readonly outcome: "cancelled" };

export type HistoryMaintenancePhase = "preparing" | "copying" | HistoryWorkPhase | "installing";
export type HistoryMaintenanceJobStatus =
  | "running"
  | "completed"
  | "scan-expired"
  | "storage-changed"
  | "cancelled"
  | "failed";

export interface HistoryMaintenanceJob {
  readonly maintenanceId: string;
  readonly status: HistoryMaintenanceJobStatus;
  readonly phase: HistoryMaintenancePhase;
  readonly percent: number;
  readonly cancellable: boolean;
  readonly updatedAt: number;
  readonly result?: HistoryMaintenanceResult;
}

export type HistoryBindingReplacement = HistoryWorkBindingReplacement;

export interface HistoryActiveSessionResetPort {
  prepare(sessionIds: readonly string[]): Promise<readonly HistoryBindingReplacement[]>;
  release(sessionIds: readonly string[]): void;
}

export interface HistoryExternalRecordCleanupPort {
  removeSessionHistory(sessionIds: readonly string[]): Promise<void>;
}

interface RetainedScan {
  readonly projection: HistoryMaintenanceScan;
  readonly candidates: readonly HistoryWorkCandidate[];
}

interface MutableHistoryMaintenanceJob {
  progress: HistoryMaintenanceJob;
  readonly cancellation: AbortController;
}

interface CleanupControls {
  readonly signal?: AbortSignal;
  readonly onProgress?: (phase: HistoryMaintenancePhase, percent: number, cancellable: boolean) => void;
}

export class HistoryMaintenance {
  readonly #store: OperationalStore;
  readonly #activeSessions: HistoryActiveSessionResetPort;
  readonly #externalRecords?: HistoryExternalRecordCleanupPort;
  readonly #now: () => number;
  readonly #workDatabase: (input: HistoryWorkInput, controls?: HistoryWorkControls) => Promise<HistoryWorkCleanupResult>;
  readonly #scans = new Map<string, RetainedScan>();
  readonly #jobs = new Map<string, MutableHistoryMaintenanceJob>();
  #running = false;

  constructor(input: {
    readonly store: OperationalStore;
    readonly activeSessions: HistoryActiveSessionResetPort;
    readonly externalRecords?: HistoryExternalRecordCleanupPort;
    readonly now?: () => number;
    readonly workDatabase?: (input: HistoryWorkInput, controls?: HistoryWorkControls) => Promise<HistoryWorkCleanupResult>;
  }) {
    this.#store = input.store;
    this.#activeSessions = input.activeSessions;
    this.#externalRecords = input.externalRecords;
    this.#now = input.now ?? Date.now;
    this.#workDatabase = input.workDatabase ?? runHistoryMaintenanceWorker;
  }

  supported(): boolean {
    return this.#store.filePath !== ":memory:" && !this.#store.filePath.startsWith("file:");
  }

  scan(input: { readonly retention: HistoryRetention; readonly includeActiveTasks: boolean }): HistoryMaintenanceScan {
    if (!this.supported()) throw new Error("Task history maintenance requires a file-backed service database.");
    if (!HISTORY_RETENTION_OPTIONS.includes(input.retention)) throw new Error("Task history retention is invalid.");
    const scannedAt = this.#now();
    const olderThan = retentionCutoff(scannedAt, input.retention);
    const databasePath = resolve(this.#store.filePath);
    const inspection = this.#store.inspectHistoryMaintenance({ olderThan, includeActiveTasks: input.includeActiveTasks });
    const candidates = inspection.candidates;
    const databaseBytes = databaseFamilyBytes(databasePath);
    const temporaryBytesRequired = Math.max(0, Math.ceil(databaseBytes * 2 + SPACE_MARGIN_BYTES));
    const freeBytes = volumeFreeBytes(dirname(databasePath));
    const scanId = randomUUID();
    const projection: HistoryMaintenanceScan = {
      scanId,
      retention: input.retention,
      includeActiveTasks: input.includeActiveTasks,
      scannedAt,
      olderThan,
      activeTaskCount: candidates.filter((item) => item.status === "active").length,
      deletedTaskCount: candidates.filter((item) => item.status === "deleted").length,
      archivedTaskCount: candidates.filter((item) => item.status === "archived").length,
      messageCount: inspection.messageCount,
      estimatedHistoryBytes: inspection.estimatedHistoryBytes,
      databaseBytes,
      temporaryBytesRequired,
      ...(freeBytes === undefined ? {} : { databaseVolumeFreeBytes: freeBytes }),
      expiresAt: scannedAt + SCAN_TTL_MS
    };
    this.#pruneScans(scannedAt);
    this.#scans.set(scanId, { projection, candidates });
    while (this.#scans.size > MAXIMUM_SCANS) this.#scans.delete(this.#scans.keys().next().value as string);
    return projection;
  }

  beginCleanup(scanId: string, backupEnabled: boolean): HistoryMaintenanceJob {
    if (this.#running) throw new Error("Task history maintenance is already running.");
    const maintenanceId = randomUUID();
    const cancellation = new AbortController();
    const job: MutableHistoryMaintenanceJob = {
      cancellation,
      progress: {
        maintenanceId,
        status: "running",
        phase: "preparing",
        percent: 1,
        cancellable: true,
        updatedAt: this.#now()
      }
    };
    this.#jobs.set(maintenanceId, job);
    this.#pruneJobs();
    void this.#executeCleanup(scanId, backupEnabled, {
      signal: cancellation.signal,
      onProgress: (phase, percent, cancellable) => {
        if (job.progress.status !== "running") return;
        job.progress = { maintenanceId, status: "running", phase, percent, cancellable, updatedAt: this.#now() };
      }
    }).then((outcome) => {
      if (outcome.outcome === "completed") {
        job.progress = {
          maintenanceId,
          status: "completed",
          phase: "installing",
          percent: 100,
          cancellable: false,
          updatedAt: this.#now(),
          result: outcome.result
        };
      } else {
        job.progress = {
          maintenanceId,
          status: outcome.outcome,
          phase: job.progress.phase,
          percent: job.progress.percent,
          cancellable: false,
          updatedAt: this.#now()
        };
      }
    }).catch(() => {
      job.progress = {
        maintenanceId,
        status: "failed",
        phase: job.progress.phase,
        percent: job.progress.percent,
        cancellable: false,
        updatedAt: this.#now()
      };
    });
    return job.progress;
  }

  getCleanup(maintenanceId: string): HistoryMaintenanceJob | undefined {
    return this.#jobs.get(maintenanceId)?.progress;
  }

  cancelCleanup(maintenanceId: string): HistoryMaintenanceJob | undefined {
    const job = this.#jobs.get(maintenanceId);
    if (job === undefined) return undefined;
    if (job.progress.status === "running" && job.progress.cancellable) job.cancellation.abort();
    return job.progress;
  }

  async cleanup(scanId: string, backupEnabled: boolean): Promise<HistoryMaintenanceCleanupOutcome> {
    return await this.#executeCleanup(scanId, backupEnabled);
  }

  async #executeCleanup(
    scanId: string,
    backupEnabled: boolean,
    controls: CleanupControls = {}
  ): Promise<HistoryMaintenanceCleanupOutcome> {
    if (this.#running) throw new Error("Task history maintenance is already running.");
    const now = this.#now();
    this.#pruneScans(now);
    const retained = this.#scans.get(scanId);
    if (retained === undefined || retained.projection.expiresAt <= now) return { outcome: "scan-expired" };
    this.#scans.delete(scanId);
    if (retained.candidates.length === 0) {
      return { outcome: "completed", result: {
        activeTaskCount: 0,
        deletedTaskCount: 0,
        archivedTaskCount: 0,
        messageCount: 0,
        beforeBytes: retained.projection.databaseBytes,
        afterBytes: retained.projection.databaseBytes,
        reclaimedBytes: 0,
        backupCreated: false,
        skippedTaskCount: 0
      } };
    }
    const databasePath = resolve(this.#store.filePath);
    const freeBytes = volumeFreeBytes(dirname(databasePath));
    if (freeBytes !== undefined && freeBytes < retained.projection.temporaryBytesRequired) {
      throw new Error("The database volume does not have enough free space for safe history maintenance.");
    }

    this.#running = true;
    const activeIds = retained.candidates.filter((item) => item.status === "active").map((item) => item.sessionId);
    const workingPath = `${databasePath}.history-maintenance.work`;
    try {
      assertNotCancelled(controls.signal);
      controls.onProgress?.("preparing", 5, true);
      const replacements = activeIds.length === 0 ? [] : await this.#activeSessions.prepare(activeIds);
      assertNotCancelled(controls.signal);
      const expectedRevision = this.#store.health().revision;
      rmSync(workingPath, { force: true });
      controls.onProgress?.("copying", 18, true);
      if (!await this.#store.createHistoryMaintenanceCopy({ workingPath, expectedRevision })) {
        return { outcome: "storage-changed" };
      }
      assertNotCancelled(controls.signal);

      const workResult = await this.#workDatabase({
        workingPath,
        candidates: retained.candidates,
        replacements,
        prunedAt: this.#now()
      }, {
        signal: controls.signal,
        onProgress: (phase, percent) => controls.onProgress?.(phase, percent, true)
      });
      assertNotCancelled(controls.signal);
      if (this.#store.health().revision !== expectedRevision) {
        rmSync(workingPath, { force: true });
        return { outcome: "storage-changed" };
      }
      controls.onProgress?.("installing", 96, false);
      const installation = this.#store.installHistoryMaintenanceCopy({ workingPath, expectedRevision, backupEnabled });
      for (const sessionId of workResult.affectedSessionIds) {
        this.#store.publishHistoryPruned({
          sessionId,
          activeContextReset: workResult.activeSessionIds.includes(sessionId),
          prunedAt: this.#now()
        });
      }
      if (workResult.activeSessionIds.length > 0) {
        try {
          await this.#externalRecords?.removeSessionHistory(workResult.activeSessionIds);
        } catch {
          // The committed database is authoritative; external snapshot caches are reconciled independently.
        }
      }
      const afterBytes = databaseFamilyBytes(databasePath);
      return { outcome: "completed", result: {
        activeTaskCount: workResult.activeTaskCount,
        deletedTaskCount: workResult.deletedTaskCount,
        archivedTaskCount: workResult.archivedTaskCount,
        messageCount: workResult.messageCount,
        beforeBytes: retained.projection.databaseBytes,
        afterBytes,
        reclaimedBytes: Math.max(0, retained.projection.databaseBytes - afterBytes),
        backupCreated: installation.backupCreated,
        skippedTaskCount: workResult.skippedTaskCount
      } };
    } catch (error) {
      if (error instanceof HistoryWorkCancelledError || controls.signal?.aborted === true) return { outcome: "cancelled" };
      throw error;
    } finally {
      rmSync(workingPath, { force: true });
      if (activeIds.length > 0) this.#activeSessions.release(activeIds);
      this.#running = false;
    }
  }

  #pruneScans(now: number): void {
    for (const [scanId, scan] of this.#scans) {
      if (scan.projection.expiresAt <= now) this.#scans.delete(scanId);
    }
  }

  #pruneJobs(): void {
    while (this.#jobs.size > MAXIMUM_JOBS) {
      const removable = [...this.#jobs].find(([, job]) => job.progress.status !== "running");
      if (removable === undefined) return;
      this.#jobs.delete(removable[0]);
    }
  }
}

function retentionCutoff(now: number, retention: HistoryRetention): number {
  if (retention === "7-days") return now - 7 * 24 * 60 * 60_000;
  const months = retention === "1-month" ? 1 : retention === "3-months" ? 3 : 6;
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
}

function databaseFamilyBytes(databasePath: string): number {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].reduce((total, candidate) => {
    try {
      const info = statSync(candidate);
      return info.isFile() ? total + info.size : total;
    } catch {
      return total;
    }
  }, 0);
}

function volumeFreeBytes(directory: string): number | undefined {
  try {
    const info = statfsSync(directory, { bigint: true });
    const value = info.bavail * info.bsize;
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  } catch {
    return undefined;
  }
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new HistoryWorkCancelledError();
}
