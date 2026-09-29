import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync, statfsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  MaintenanceEffectRecord,
  MaintenanceJobRecord,
  OperationalHistoryMaintenanceCandidate,
  OperationalStore
} from "@joko/store";

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
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const EXTERNAL_EFFECT_ID = "external-cache";

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

export interface HistoryBindingReplacement extends HistoryWorkBindingReplacement {
  readonly operationId: string;
}

export interface HistoryBindingPreparation {
  readonly sessionId: string;
  readonly operationId: string;
  readonly source: HistoryWorkCandidate["binding"];
}

export interface HistoryActiveSessionResetPort {
  prepare(requests: readonly HistoryBindingPreparation[]): Promise<readonly HistoryBindingReplacement[]>;
  recover?(request: HistoryBindingPreparation): Promise<HistoryBindingReplacement | undefined>;
  discard?(replacements: readonly HistoryBindingReplacement[]): Promise<void>;
  finalize?(replacements: readonly HistoryBindingReplacement[]): Promise<void>;
  release(sessionIds: readonly string[]): void;
}

export interface HistoryExternalRecordCleanupPort {
  removeSessionHistory(sessionIds: readonly string[]): Promise<void>;
}

interface DurableHistoryScanPayload {
  readonly projection: HistoryMaintenanceScan;
  readonly candidates: readonly HistoryWorkCandidate[];
}

interface DurableHistoryJobPayload {
  readonly backupEnabled: boolean;
  readonly expectedRevision?: string;
  readonly installationPrepared: boolean;
  readonly productFinalized: boolean;
  readonly workResult?: HistoryWorkCleanupResult;
}

interface DurableHistoryBindingEffect {
  readonly sessionId: string;
  readonly operationId: string;
  readonly source: HistoryWorkCandidate["binding"];
  readonly replacement?: HistoryWorkCandidate["binding"];
}

interface DurableHistoryExternalEffect {
  readonly sessionIds: readonly string[];
}

interface RunningHistoryJob {
  readonly cancellation: AbortController;
  readonly completion: Promise<void>;
}

export class HistoryMaintenance {
  readonly #store: OperationalStore;
  readonly #activeSessions: HistoryActiveSessionResetPort;
  readonly #externalRecords?: HistoryExternalRecordCleanupPort;
  readonly #now: () => number;
  readonly #workDatabase: (input: HistoryWorkInput, controls?: HistoryWorkControls) => Promise<HistoryWorkCleanupResult>;
  readonly #running = new Map<string, RunningHistoryJob>();
  #closing = false;

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

  async initialize(): Promise<void> {
    for (const job of this.#store.listMaintenanceJobs<DurableHistoryJobPayload, HistoryMaintenanceResult>({
      kind: "history",
      statuses: ["completed"]
    })) await this.#reconcileTerminalReceipts(job.id);
    for (const job of this.#store.listMaintenanceJobs<DurableHistoryJobPayload, HistoryMaintenanceResult>({
      kind: "history",
      statuses: ["failed", "cancelled", "storage_changed", "scan_expired"]
    })) await this.#reconcileAbortedReceipts(job.id);
    const running = this.#store.listMaintenanceJobs<DurableHistoryJobPayload, HistoryMaintenanceResult>({
      kind: "history",
      statuses: ["running"]
    });
    for (const job of running) this.#launch(job.id);
    await Promise.allSettled(running.map(async (job) => {
      await this.#running.get(job.id)?.completion;
    }));
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const running of this.#running.values()) running.cancellation.abort();
    await Promise.allSettled([...this.#running.values()].map((running) => running.completion));
  }

  scan(input: { readonly retention: HistoryRetention; readonly includeActiveTasks: boolean }): HistoryMaintenanceScan {
    if (!this.supported()) throw new Error("Task history maintenance requires a file-backed service database.");
    if (!HISTORY_RETENTION_OPTIONS.includes(input.retention)) throw new Error("Task history retention is invalid.");
    const scannedAt = this.#now();
    const olderThan = retentionCutoff(scannedAt, input.retention);
    const databasePath = resolve(this.#store.filePath);
    const inspection = this.#store.inspectHistoryMaintenance({ olderThan, includeActiveTasks: input.includeActiveTasks });
    const candidates = inspection.candidates.map(toWorkCandidate);
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
    this.#store.createMaintenanceScan<DurableHistoryScanPayload>({
      id: scanId,
      kind: "history",
      payload: { projection, candidates },
      expiresAt: projection.expiresAt,
      createdAt: scannedAt
    });
    return projection;
  }

  beginCleanup(scanId: string, backupEnabled: boolean): HistoryMaintenanceJob {
    const existing = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", scanId);
    if (existing !== undefined) {
      if (historyJobPayload(existing.payload).backupEnabled !== backupEnabled) {
        throw new Error("Task history cleanup was already started with different backup settings.");
      }
      if (existing.status === "running") this.#launch(existing.id);
      return toPublicJob(existing);
    }
    const now = this.#now();
    const created = this.#store.transaction((store) => {
      const scan = store.claimMaintenanceScan<DurableHistoryScanPayload>("history", scanId, now);
      if (scan === undefined) return undefined;
      const payload = historyScanPayload(scan.payload, scanId);
      return store.createMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>({
        id: scanId,
        kind: "history",
        scanId,
        phase: "preparing",
        percent: 1,
        cancellable: true,
        payload: { backupEnabled, installationPrepared: false, productFinalized: false },
        effects: [
          ...payload.candidates.filter((candidate) => candidate.status === "active").map((candidate) => ({
            id: bindingEffectId(candidate.sessionId),
            kind: "history_binding" as const,
            payload: {
              sessionId: candidate.sessionId,
              operationId: bindingOperationId(scanId, candidate.sessionId),
              source: candidate.binding
            } satisfies DurableHistoryBindingEffect
          })),
          {
            id: EXTERNAL_EFFECT_ID,
            kind: "history_external" as const,
            payload: {
              sessionIds: payload.candidates
                .filter((candidate) => candidate.status === "active")
                .map((candidate) => candidate.sessionId)
            } satisfies DurableHistoryExternalEffect
          }
        ],
        createdAt: now
      });
    });
    if (created === undefined) {
      return {
        maintenanceId: scanId,
        status: "scan-expired",
        phase: "preparing",
        percent: 0,
        cancellable: false,
        updatedAt: now
      };
    }
    this.#launch(created.id);
    return toPublicJob(created);
  }

  getCleanup(maintenanceId: string): HistoryMaintenanceJob | undefined {
    const job = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    return job === undefined ? undefined : toPublicJob(job);
  }

  cancelCleanup(maintenanceId: string): HistoryMaintenanceJob | undefined {
    const existing = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>(
      "history",
      maintenanceId
    );
    if (existing === undefined) return undefined;
    const job = existing.status === "running" && existing.cancellable
      ? this.#store.requestMaintenanceCancellation("history", maintenanceId, this.#now())
      : existing;
    if (job.cancelRequested) this.#running.get(maintenanceId)?.cancellation.abort();
    return toPublicJob(job as MaintenanceJobRecord<DurableHistoryJobPayload, HistoryMaintenanceResult>);
  }

  async cleanup(scanId: string, backupEnabled: boolean): Promise<HistoryMaintenanceCleanupOutcome> {
    const started = this.beginCleanup(scanId, backupEnabled);
    if (started.status === "scan-expired") return { outcome: "scan-expired" };
    await this.#running.get(started.maintenanceId)?.completion;
    const final = this.getCleanup(started.maintenanceId);
    if (final?.status === "completed" && final.result !== undefined) return { outcome: "completed", result: final.result };
    if (final?.status === "storage-changed") return { outcome: "storage-changed" };
    if (final?.status === "cancelled") return { outcome: "cancelled" };
    throw new Error("Task history maintenance failed.");
  }

  #launch(maintenanceId: string): void {
    if (this.#closing || this.#running.has(maintenanceId)) return;
    const cancellation = new AbortController();
    const current = this.#store.getMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    if (current.status !== "running") return;
    if (current.cancelRequested) cancellation.abort();
    const completion = this.#execute(maintenanceId, cancellation.signal)
      .catch(async () => {
        const job = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
        if (job?.status === "running" && !this.#closing) await this.#finishBeforeInstall(maintenanceId, "failed");
      })
      .finally(() => { this.#running.delete(maintenanceId); });
    this.#running.set(maintenanceId, { cancellation, completion });
  }

  async #execute(maintenanceId: string, signal: AbortSignal): Promise<void> {
    let activeIds: string[] = [];
    const databasePath = resolve(this.#store.filePath);
    const workingPath = `${databasePath}.history-maintenance.work`;
    try {
      let job = this.#store.getMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
      let payload = historyJobPayload(job.payload);
      if (payload.installationPrepared) {
        await this.#finalizeInstalledJob(maintenanceId);
        return;
      }
      const scan = historyScanPayload(
        this.#store.getMaintenanceScan<DurableHistoryScanPayload>("history", job.scanId).payload,
        job.scanId
      );
      const bindingEffects = this.#bindingEffects(maintenanceId);
      activeIds = bindingEffects.map((effect) => historyBindingEffect(effect.payload).sessionId);
      assertNotCancelled(signal, job.cancelRequested);
      this.#updateProgress(maintenanceId, "preparing", 5, true);
      const replacements = await this.#prepareBindings(maintenanceId, bindingEffects, signal);
      job = this.#store.getMaintenanceJob("history", maintenanceId);
      assertNotCancelled(signal, job.cancelRequested);

      payload = historyJobPayload(job.payload);
      const expectedRevision = payload.expectedRevision === undefined
        ? this.#store.health().revision
        : BigInt(payload.expectedRevision);
      if (this.#store.health().revision !== expectedRevision) {
        await this.#finishBeforeInstall(maintenanceId, "storage_changed");
        return;
      }
      if (payload.expectedRevision === undefined) {
        payload = { ...payload, expectedRevision: expectedRevision.toString(10) };
        this.#replaceJobPayload(job as MaintenanceJobRecord<DurableHistoryJobPayload, HistoryMaintenanceResult>, payload);
      }

      if (scan.candidates.length === 0) {
        const result: HistoryMaintenanceResult = {
          activeTaskCount: 0,
          deletedTaskCount: 0,
          archivedTaskCount: 0,
          messageCount: 0,
          beforeBytes: scan.projection.databaseBytes,
          afterBytes: scan.projection.databaseBytes,
          reclaimedBytes: 0,
          backupCreated: false,
          skippedTaskCount: 0
        };
        this.#completeEmptyJob(maintenanceId, result);
        await this.#reconcileTerminalReceipts(maintenanceId);
        return;
      }

      const freeBytes = volumeFreeBytes(dirname(databasePath));
      if (freeBytes !== undefined && freeBytes < scan.projection.temporaryBytesRequired) {
        throw new Error("The database volume does not have enough free space for safe history maintenance.");
      }
      rmSync(workingPath, { force: true });
      this.#updateProgress(maintenanceId, "copying", 18, true);
      if (!await this.#store.createHistoryMaintenanceCopy({ workingPath, expectedRevision })) {
        await this.#finishBeforeInstall(maintenanceId, "storage_changed");
        return;
      }
      assertNotCancelled(signal, this.#currentCancelRequested(maintenanceId));
      const workResult = await this.#workDatabase({
        workingPath,
        candidates: scan.candidates,
        replacements,
        prunedAt: this.#now()
      }, {
        signal,
        onProgress: (phase, percent) => this.#updateProgress(maintenanceId, phase, percent, true)
      });
      assertNotCancelled(signal, this.#currentCancelRequested(maintenanceId));
      if (this.#store.health().revision !== expectedRevision) {
        await this.#finishBeforeInstall(maintenanceId, "storage_changed");
        return;
      }

      const preparedPayload: DurableHistoryJobPayload = {
        ...historyJobPayload(this.#store.getMaintenanceJob("history", maintenanceId).payload),
        installationPrepared: true,
        workResult
      };
      this.#store.prepareHistoryMaintenanceCopyReceipt({
        workingPath,
        jobId: maintenanceId,
        phase: "installing",
        percent: 96,
        payload: preparedPayload,
        effectUpdates: [{
          id: EXTERNAL_EFFECT_ID,
          state: workResult.affectedSessionIds.length === 0 ? "completed" : "pending",
          payload: { sessionIds: workResult.affectedSessionIds } satisfies DurableHistoryExternalEffect
        }],
        updatedAt: this.#now()
      });
      this.#updateProgress(maintenanceId, "installing", 96, false);
      this.#store.installHistoryMaintenanceCopy({
        workingPath,
        expectedRevision,
        backupEnabled: preparedPayload.backupEnabled
      });
      await this.#finalizeInstalledJob(maintenanceId);
    } catch (error) {
      if (error instanceof HistoryWorkCancelledError || signal.aborted) {
        if (!this.#closing || this.#currentCancelRequested(maintenanceId)) {
          await this.#finishBeforeInstall(maintenanceId, "cancelled");
        }
        return;
      }
      if (!this.#closing) await this.#finishBeforeInstall(maintenanceId, "failed");
      throw error;
    } finally {
      rmSync(workingPath, { force: true });
      if (activeIds.length > 0) this.#activeSessions.release(activeIds);
    }
  }

  async #prepareBindings(
    maintenanceId: string,
    effects: readonly MaintenanceEffectRecord<DurableHistoryBindingEffect>[],
    signal: AbortSignal
  ): Promise<HistoryBindingReplacement[]> {
    const replacements: HistoryBindingReplacement[] = [];
    for (const original of effects) {
      assertNotCancelled(signal, this.#currentCancelRequested(maintenanceId));
      let effect = this.#store.listMaintenanceEffects<DurableHistoryBindingEffect>(maintenanceId)
        .find((candidate) => candidate.id === original.id);
      if (effect === undefined) throw new Error("Task history binding receipt disappeared.");
      let payload = historyBindingEffect(effect.payload);
      if (effect.state === "prepared" && payload.replacement !== undefined) {
          replacements.push({
            sessionId: payload.sessionId,
            operationId: payload.operationId,
            source: payload.source,
            replacement: payload.replacement
          });
        continue;
      }
      const request: HistoryBindingPreparation = {
        sessionId: payload.sessionId,
        operationId: payload.operationId,
        source: payload.source
      };
      if (effect.state === "claimed" || effect.state === "unknown") {
        if (this.#activeSessions.recover === undefined) {
          throw new Error("Task history binding recovery is unavailable for an uncertain native replacement.");
        }
        const recovered = await this.#activeSessions.recover(request);
        if (recovered !== undefined) {
          assertReplacement(request, recovered);
          payload = { ...payload, replacement: recovered.replacement };
          effect = this.#store.updateMaintenanceEffect({
            jobId: maintenanceId, id: effect.id, state: "prepared", payload, updatedAt: this.#now()
          });
          replacements.push(recovered);
          continue;
        }
        effect = this.#store.updateMaintenanceEffect({
          jobId: maintenanceId, id: effect.id, state: "pending", payload, updatedAt: this.#now()
        });
      }
      if (effect.state !== "pending") throw new Error("Task history binding receipt is not recoverable.");
      this.#store.updateMaintenanceEffect({
        jobId: maintenanceId, id: effect.id, state: "claimed", payload, updatedAt: this.#now()
      });
      try {
        const prepared = await this.#activeSessions.prepare([request]);
        if (prepared.length !== 1) throw new Error("Task history binding preparation returned an invalid result.");
        const replacement = prepared[0]!;
        assertReplacement(request, replacement);
        payload = { ...payload, replacement: replacement.replacement };
        this.#store.updateMaintenanceEffect({
          jobId: maintenanceId, id: effect.id, state: "prepared", payload, updatedAt: this.#now()
        });
        replacements.push(replacement);
      } catch (error) {
        const recovered = await this.#activeSessions.recover?.(request).catch(() => undefined);
        if (recovered !== undefined) {
          assertReplacement(request, recovered);
          payload = { ...payload, replacement: recovered.replacement };
          this.#store.updateMaintenanceEffect({
            jobId: maintenanceId, id: effect.id, state: "prepared", payload, updatedAt: this.#now()
          });
          replacements.push(recovered);
          continue;
        }
        this.#store.updateMaintenanceEffect({
          jobId: maintenanceId, id: effect.id, state: "unknown", payload, updatedAt: this.#now()
        });
        throw error;
      }
    }
    return replacements;
  }

  async #finalizeInstalledJob(maintenanceId: string): Promise<void> {
    const job = this.#store.getMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    const payload = historyJobPayload(job.payload);
    if (!payload.installationPrepared || payload.workResult === undefined) {
      throw new Error("Task history installation receipt is incomplete.");
    }
    const databasePath = resolve(this.#store.filePath);
    const scan = historyScanPayload(
      this.#store.getMaintenanceScan<DurableHistoryScanPayload>("history", job.scanId).payload,
      job.scanId
    );
    const afterBytes = databaseFamilyBytes(databasePath);
    const result: HistoryMaintenanceResult = {
      activeTaskCount: payload.workResult.activeTaskCount,
      deletedTaskCount: payload.workResult.deletedTaskCount,
      archivedTaskCount: payload.workResult.archivedTaskCount,
      messageCount: payload.workResult.messageCount,
      beforeBytes: scan.projection.databaseBytes,
      afterBytes,
      reclaimedBytes: Math.max(0, scan.projection.databaseBytes - afterBytes),
      backupCreated: payload.backupEnabled && existsSync(`${databasePath}.history-backup`),
      skippedTaskCount: payload.workResult.skippedTaskCount
    };
    this.#store.transaction((store) => {
      const current = store.getMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
      const currentPayload = historyJobPayload(current.payload);
      if (!currentPayload.productFinalized) {
        for (const sessionId of payload.workResult!.affectedSessionIds) {
          store.publishHistoryPruned({
            sessionId,
            activeContextReset: payload.workResult!.activeSessionIds.includes(sessionId),
            prunedAt: this.#now()
          });
        }
      }
      store.updateMaintenanceJob({
        kind: "history",
        id: maintenanceId,
        status: "completed",
        phase: "installing",
        percent: 100,
        cancellable: false,
        cancelRequested: current.cancelRequested,
        payload: { ...currentPayload, productFinalized: true },
        result,
        updatedAt: this.#now()
      });
    });
    await this.#reconcileTerminalReceipts(maintenanceId);
  }

  #completeEmptyJob(maintenanceId: string, result: HistoryMaintenanceResult): void {
    const current = this.#store.getMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    this.#store.updateMaintenanceJob({
      kind: "history", id: maintenanceId, status: "completed", phase: "installing", percent: 100,
      cancellable: false, cancelRequested: current.cancelRequested,
      payload: { ...historyJobPayload(current.payload), productFinalized: true }, result, updatedAt: this.#now()
    });
    const external = this.#store.listMaintenanceEffects<DurableHistoryExternalEffect>(maintenanceId)
      .find((effect) => effect.id === EXTERNAL_EFFECT_ID);
    if (external !== undefined) this.#store.updateMaintenanceEffect({
      jobId: maintenanceId, id: external.id, state: "completed",
      payload: { sessionIds: [] } satisfies DurableHistoryExternalEffect, updatedAt: this.#now()
    });
  }

  async #finishBeforeInstall(
    maintenanceId: string,
    status: "storage_changed" | "cancelled" | "failed"
  ): Promise<void> {
    const current = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    if (current === undefined || current.status !== "running") return;
    this.#store.updateMaintenanceJob({
      kind: "history", id: maintenanceId, status, phase: asHistoryPhase(current.phase), percent: current.percent,
      cancellable: false, cancelRequested: current.cancelRequested, payload: historyJobPayload(current.payload),
      updatedAt: this.#now()
    });
    await this.#reconcileAbortedReceipts(maintenanceId);
  }

  async #reconcileAbortedReceipts(maintenanceId: string): Promise<void> {
    const job = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    if (job === undefined || job.status === "running" || job.status === "completed") return;
    for (const original of this.#bindingEffects(maintenanceId)) {
      if (original.state === "completed" || original.state === "skipped") continue;
      let payload = historyBindingEffect(original.payload);
      let replacement = payload.replacement === undefined ? undefined : {
        sessionId: payload.sessionId,
        operationId: payload.operationId,
        source: payload.source,
        replacement: payload.replacement
      } satisfies HistoryBindingReplacement;
      try {
        if (replacement === undefined && (original.state === "claimed" || original.state === "unknown")) {
          if (this.#activeSessions.recover === undefined) throw new Error("Task history binding recovery is unavailable.");
          replacement = await this.#activeSessions.recover({
            sessionId: payload.sessionId,
            operationId: payload.operationId,
            source: payload.source
          });
          if (replacement !== undefined) {
            assertReplacement({
              sessionId: payload.sessionId,
              operationId: payload.operationId,
              source: payload.source
            }, replacement);
            payload = { ...payload, replacement: replacement.replacement };
          }
        }
        if (replacement === undefined) {
          this.#store.updateMaintenanceEffect({
            jobId: maintenanceId, id: original.id, state: "skipped", payload, updatedAt: this.#now()
          });
          continue;
        }
        this.#store.updateMaintenanceEffect({
          jobId: maintenanceId, id: original.id, state: "claimed", payload, updatedAt: this.#now()
        });
        if (this.#activeSessions.discard === undefined) throw new Error("Task history binding discard is unavailable.");
        await this.#activeSessions.discard([replacement]);
        this.#store.updateMaintenanceEffect({
          jobId: maintenanceId, id: original.id, state: "skipped", payload, updatedAt: this.#now()
        });
      } catch {
        this.#store.updateMaintenanceEffect({
          jobId: maintenanceId, id: original.id, state: "unknown", payload, updatedAt: this.#now()
        });
      }
    }
    const external = this.#store.listMaintenanceEffects<DurableHistoryExternalEffect>(maintenanceId)
      .find((effect) => effect.id === EXTERNAL_EFFECT_ID);
    if (external !== undefined && external.state !== "completed" && external.state !== "skipped") {
      this.#store.updateMaintenanceEffect({
        jobId: maintenanceId, id: external.id, state: "skipped",
        payload: historyExternalEffect(external.payload), updatedAt: this.#now()
      });
    }
  }

  async #reconcileTerminalReceipts(maintenanceId: string): Promise<void> {
    const job = this.#store.findMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    if (job?.status !== "completed") return;
    const replacements = this.#preparedReplacements(maintenanceId);
    if (replacements.length > 0) {
      try {
        if (this.#activeSessions.finalize === undefined) {
          throw new Error("Task history binding finalization is unavailable.");
        }
        await this.#activeSessions.finalize(replacements);
        for (const effect of this.#bindingEffects(maintenanceId)) {
          if (historyBindingEffect(effect.payload).replacement === undefined) continue;
          this.#store.updateMaintenanceEffect({
            jobId: maintenanceId, id: effect.id, state: "completed", payload: effect.payload, updatedAt: this.#now()
          });
        }
      } catch {
        for (const effect of this.#bindingEffects(maintenanceId)) {
          if (historyBindingEffect(effect.payload).replacement === undefined) continue;
          this.#store.updateMaintenanceEffect({
            jobId: maintenanceId, id: effect.id, state: "unknown", payload: effect.payload, updatedAt: this.#now()
          });
        }
      }
    }
    const external = this.#store.listMaintenanceEffects<DurableHistoryExternalEffect>(maintenanceId)
      .find((effect) => effect.id === EXTERNAL_EFFECT_ID);
    if (external === undefined || external.state === "completed") return;
    const externalPayload = historyExternalEffect(external.payload);
    if (externalPayload.sessionIds.length === 0 || this.#externalRecords === undefined) {
      this.#store.updateMaintenanceEffect({
        jobId: maintenanceId, id: external.id, state: "completed", payload: externalPayload, updatedAt: this.#now()
      });
      return;
    }
    this.#store.updateMaintenanceEffect({
      jobId: maintenanceId, id: external.id, state: "claimed", payload: externalPayload, updatedAt: this.#now()
    });
    try {
      await this.#externalRecords.removeSessionHistory(externalPayload.sessionIds);
      this.#store.updateMaintenanceEffect({
        jobId: maintenanceId, id: external.id, state: "completed", payload: externalPayload, updatedAt: this.#now()
      });
    } catch {
      this.#store.updateMaintenanceEffect({
        jobId: maintenanceId, id: external.id, state: "unknown", payload: externalPayload, updatedAt: this.#now()
      });
    }
  }

  #bindingEffects(maintenanceId: string): MaintenanceEffectRecord<DurableHistoryBindingEffect>[] {
    return this.#store.listMaintenanceEffects<DurableHistoryBindingEffect>(maintenanceId)
      .filter((effect) => effect.kind === "history_binding");
  }

  #preparedReplacements(maintenanceId: string): HistoryBindingReplacement[] {
    return this.#bindingEffects(maintenanceId).flatMap((effect) => {
      const payload = historyBindingEffect(effect.payload);
      return payload.replacement === undefined ? [] : [{
        sessionId: payload.sessionId,
        operationId: payload.operationId,
        source: payload.source,
        replacement: payload.replacement
      }];
    });
  }

  #replaceJobPayload(
    job: MaintenanceJobRecord<DurableHistoryJobPayload, HistoryMaintenanceResult>,
    payload: DurableHistoryJobPayload
  ): void {
    this.#store.updateMaintenanceJob({
      kind: "history", id: job.id, status: job.status, phase: asHistoryPhase(job.phase), percent: job.percent,
      cancellable: job.cancellable, cancelRequested: job.cancelRequested, payload,
      ...(job.result === undefined ? {} : { result: job.result }), updatedAt: this.#now()
    });
  }

  #updateProgress(
    maintenanceId: string,
    phase: HistoryMaintenancePhase,
    percent: number,
    cancellable: boolean
  ): void {
    const current = this.#store.getMaintenanceJob<DurableHistoryJobPayload, HistoryMaintenanceResult>("history", maintenanceId);
    if (current.status !== "running") return;
    this.#store.updateMaintenanceJob({
      kind: "history", id: maintenanceId, status: "running", phase, percent, cancellable,
      cancelRequested: current.cancelRequested, payload: historyJobPayload(current.payload), updatedAt: this.#now()
    });
  }

  #currentCancelRequested(maintenanceId: string): boolean {
    return this.#store.findMaintenanceJob("history", maintenanceId)?.cancelRequested === true;
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

function assertNotCancelled(signal: AbortSignal, cancelRequested: boolean): void {
  if (signal.aborted || cancelRequested) throw new HistoryWorkCancelledError();
}

function toWorkCandidate(candidate: OperationalHistoryMaintenanceCandidate): HistoryWorkCandidate {
  return { sessionId: candidate.sessionId, status: candidate.status, updatedAt: candidate.updatedAt, binding: candidate.binding };
}

function bindingEffectId(sessionId: string): string {
  return `binding-${createHash("sha256").update(sessionId).digest("hex")}`;
}

function bindingOperationId(maintenanceId: string, sessionId: string): string {
  return `history-reset-${createHash("sha256").update(`${maintenanceId}\0${sessionId}`).digest("hex")}`;
}

function assertReplacement(request: HistoryBindingPreparation, replacement: HistoryBindingReplacement): void {
  if (
    replacement.sessionId !== request.sessionId
    || replacement.operationId !== request.operationId
    || replacement.source.opaqueRef !== request.source.opaqueRef
    || replacement.source.nativeSessionId !== request.source.nativeSessionId
    || replacement.source.generation !== request.source.generation
    || replacement.replacement.opaqueRef === request.source.opaqueRef
    || replacement.replacement.generation <= request.source.generation
  ) throw new Error("Task history binding replacement does not match its durable effect receipt.");
}

function historyScanPayload(value: DurableHistoryScanPayload, scanId: string): DurableHistoryScanPayload {
  if (value === null || typeof value !== "object" || value.projection?.scanId !== scanId || !Array.isArray(value.candidates)) {
    throw new Error("Task history scan receipt is invalid.");
  }
  return value;
}

function historyJobPayload(value: unknown): DurableHistoryJobPayload {
  if (value === null || typeof value !== "object") throw new Error("Task history job receipt is invalid.");
  const candidate = value as Partial<DurableHistoryJobPayload>;
  if (
    typeof candidate.backupEnabled !== "boolean"
    || typeof candidate.installationPrepared !== "boolean"
    || typeof candidate.productFinalized !== "boolean"
    || (candidate.expectedRevision !== undefined && !/^\d+$/u.test(candidate.expectedRevision))
  ) throw new Error("Task history job receipt is invalid.");
  return candidate as DurableHistoryJobPayload;
}

function historyBindingEffect(value: unknown): DurableHistoryBindingEffect {
  if (value === null || typeof value !== "object") throw new Error("Task history binding receipt is invalid.");
  const candidate = value as Partial<DurableHistoryBindingEffect>;
  if (typeof candidate.sessionId !== "string" || typeof candidate.operationId !== "string" || candidate.source === undefined) {
    throw new Error("Task history binding receipt is invalid.");
  }
  return candidate as DurableHistoryBindingEffect;
}

function historyExternalEffect(value: unknown): DurableHistoryExternalEffect {
  if (
    value === null
    || typeof value !== "object"
    || !Array.isArray((value as Partial<DurableHistoryExternalEffect>).sessionIds)
    || !(value as DurableHistoryExternalEffect).sessionIds.every((sessionId) => typeof sessionId === "string")
  ) throw new Error("Task history external cleanup receipt is invalid.");
  return value as DurableHistoryExternalEffect;
}

function asHistoryPhase(value: string): HistoryMaintenancePhase {
  if (!["preparing", "copying", "cleaning", "compacting", "verifying", "installing"].includes(value)) {
    throw new Error("Task history maintenance phase is invalid.");
  }
  return value as HistoryMaintenancePhase;
}

function toPublicJob(
  job: MaintenanceJobRecord<DurableHistoryJobPayload, HistoryMaintenanceResult>
): HistoryMaintenanceJob {
  const status = job.status === "scan_expired"
    ? "scan-expired"
    : job.status === "storage_changed" ? "storage-changed" : job.status;
  return {
    maintenanceId: job.id,
    status,
    phase: asHistoryPhase(job.phase),
    percent: job.percent,
    cancellable: job.cancellable,
    updatedAt: job.updatedAt,
    ...(job.result === undefined ? {} : { result: job.result })
  };
}
