import type {
  TaskHistoryCleanupProgressView,
  TaskHistoryMaintenanceSupportView,
  TaskHistoryRetentionView,
  TaskHistoryScanView
} from "../model.js";

export const VISUAL_HISTORY_MAINTENANCE_SETTLE_EVENT = "joko-visual-history-maintenance-settle";
let nextFixtureOwner = 0;

export interface VisualHistoryMaintenanceAttempt {
  readonly kind: "scan" | "progress";
  readonly attempt: number;
  readonly scanId: string;
  readonly maintenanceId?: string;
}

export interface VisualHistoryMaintenanceState {
  readonly ownerId: string;
  readonly phase: "ready" | "scanning" | "report" | "running" | "failed" | "cancelled" | "completed";
  readonly scanRequests: number;
  readonly cleanupRequests: number;
  readonly progressReads: number;
  readonly cancelRequests: number;
  readonly failedScans: number;
  readonly completedCleanups: number;
  readonly pending?: VisualHistoryMaintenanceAttempt;
  readonly scan?: { readonly scanId: string; readonly retention: TaskHistoryRetentionView; readonly includeActiveTasks: boolean };
  readonly cleanup?: { readonly scanId: string; readonly maintenanceId: string; readonly backupEnabled: boolean;
    readonly status: TaskHistoryCleanupProgressView["status"]; readonly percent: number; readonly cancellable: boolean };
}

interface PendingBase {
  readonly value: VisualHistoryMaintenanceAttempt;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
type PendingRead =
  | PendingBase & { readonly kind: "scan"; readonly retention: TaskHistoryRetentionView; readonly includeActiveTasks: boolean;
      readonly resolve: (value: TaskHistoryScanView) => void }
  | PendingBase & { readonly kind: "progress"; readonly resolve: (value: TaskHistoryCleanupProgressView) => void };

interface CleanupJob {
  readonly scan: TaskHistoryScanView;
  readonly backupEnabled: boolean;
  progress: TaskHistoryCleanupProgressView;
}

/** Development-only typed backend; it never reads or changes a real database. */
export class VisualHistoryMaintenanceFixture {
  readonly #ownerId = `visual-history-maintenance-owner-${++nextFixtureOwner}`;
  readonly #listeners = new Set<(state: VisualHistoryMaintenanceState) => void>();
  #phase: VisualHistoryMaintenanceState["phase"] = "ready";
  #attempt = 0;
  #scanRequests = 0;
  #cleanupRequests = 0;
  #progressReads = 0;
  #cancelRequests = 0;
  #failedScans = 0;
  #completedCleanups = 0;
  #scan?: TaskHistoryScanView;
  #job?: CleanupJob;
  #pending?: PendingRead;

  get state(): VisualHistoryMaintenanceState {
    return {
      ownerId: this.#ownerId, phase: this.#phase, scanRequests: this.#scanRequests,
      cleanupRequests: this.#cleanupRequests, progressReads: this.#progressReads,
      cancelRequests: this.#cancelRequests, failedScans: this.#failedScans, completedCleanups: this.#completedCleanups,
      ...(this.#pending === undefined ? {} : { pending: this.#pending.value }),
      ...(this.#scan === undefined ? {} : { scan: { scanId: this.#scan.scanId,
        retention: this.#scan.retention, includeActiveTasks: this.#scan.includeActiveTasks } }),
      ...(this.#job === undefined ? {} : { cleanup: { scanId: this.#job.scan.scanId,
        maintenanceId: this.#job.progress.maintenanceId, backupEnabled: this.#job.backupEnabled,
        status: this.#job.progress.status, percent: this.#job.progress.percent, cancellable: this.#job.progress.cancellable } })
    };
  }

  subscribe(listener: (state: VisualHistoryMaintenanceState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  readonly getTaskHistoryMaintenanceSupport = async (): Promise<TaskHistoryMaintenanceSupportView> => ({ supported: true });

  readonly scanTaskHistory = (retention: TaskHistoryRetentionView, includeActiveTasks: boolean): Promise<TaskHistoryScanView> => {
    if (this.#pending !== undefined || this.#job?.progress.status === "running") {
      return Promise.reject(new Error("The deterministic history maintenance request is already pending."));
    }
    if (!["7-days", "1-month", "3-months", "6-months"].includes(retention) || typeof includeActiveTasks !== "boolean") {
      return Promise.reject(new Error("The deterministic history scan options are invalid."));
    }
    this.#scan = undefined;
    this.#job = undefined;
    this.#phase = "scanning";
    this.#scanRequests += 1;
    const value: VisualHistoryMaintenanceAttempt = { kind: "scan", attempt: ++this.#attempt,
      scanId: fixtureId("11111111", this.#scanRequests) };
    return new Promise((resolve, reject) => {
      const timer = this.#deadline(value);
      this.#pending = { kind: "scan", value, retention, includeActiveTasks, resolve, reject, timer };
      this.#publish();
    });
  };

  readonly beginTaskHistoryCleanup = async (scanId: string, backupEnabled: boolean): Promise<TaskHistoryCleanupProgressView> => {
    const scan = this.#scan;
    if (this.#pending !== undefined || this.#job !== undefined || scan === undefined || scan.scanId !== scanId
      || scan.expiresAt <= Date.now() || scan.messageCount === 0 || typeof backupEnabled !== "boolean"
      || (scan.databaseVolumeFreeBytes !== undefined && scan.databaseVolumeFreeBytes < scan.temporaryBytesRequired)) {
      throw new Error("The deterministic history scan is no longer eligible for cleanup.");
    }
    this.#cleanupRequests += 1;
    const progress: TaskHistoryCleanupProgressView = { maintenanceId: fixtureId("22222222", this.#cleanupRequests),
      status: "running", phase: "compacting", percent: 60, cancellable: true, updatedAt: Date.now() };
    this.#job = { scan, backupEnabled, progress };
    this.#phase = "running";
    this.#publish();
    return progress;
  };

  readonly getTaskHistoryCleanup = (maintenanceId: string): Promise<TaskHistoryCleanupProgressView> => {
    const job = this.#job;
    if (job === undefined || job.progress.maintenanceId !== maintenanceId) {
      return Promise.reject(new Error("The deterministic history maintenance source changed."));
    }
    if (job.progress.status !== "running") return Promise.resolve(job.progress);
    if (this.#pending !== undefined) return Promise.reject(new Error("The deterministic history progress read is already pending."));
    this.#progressReads += 1;
    const value: VisualHistoryMaintenanceAttempt = { kind: "progress", attempt: ++this.#attempt,
      scanId: job.scan.scanId, maintenanceId };
    return new Promise((resolve, reject) => {
      const timer = this.#deadline(value);
      this.#pending = { kind: "progress", value, resolve, reject, timer };
      this.#publish();
    });
  };

  readonly cancelTaskHistoryCleanup = async (maintenanceId: string): Promise<TaskHistoryCleanupProgressView> => {
    const job = this.#job;
    if (job === undefined || job.progress.maintenanceId !== maintenanceId
      || job.progress.status !== "running" || !job.progress.cancellable) {
      throw new Error("The deterministic history maintenance cannot be cancelled.");
    }
    this.#cancelRequests += 1;
    job.progress = { ...job.progress, status: "cancelled", cancellable: false, updatedAt: Date.now() };
    this.#phase = "cancelled";
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending?.kind === "progress") {
      clearTimeout(pending.timer);
      pending.resolve(job.progress);
    }
    this.#publish();
    return job.progress;
  };

  settle(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const detail = value as Record<string, unknown>;
    const pending = this.#pending;
    if (pending === undefined || detail.ownerId !== this.#ownerId || detail.kind !== pending.value.kind
      || detail.attempt !== pending.value.attempt || detail.scanId !== pending.value.scanId
      || detail.maintenanceId !== pending.value.maintenanceId) return false;
    if (pending.kind === "scan") {
      if (detail.outcome !== "failure" && detail.outcome !== "success" && detail.outcome !== "insufficient-space") return false;
      if (detail.outcome === "failure") this.#failPending(new Error("The deterministic history scan failed."));
      else {
        clearTimeout(pending.timer);
        this.#pending = undefined;
        const now = Date.now();
        const months = pending.retention === "1-month" ? 1 : pending.retention === "3-months" ? 3 : 6;
        const scan: TaskHistoryScanView = { scanId: pending.value.scanId, retention: pending.retention,
          includeActiveTasks: pending.includeActiveTasks, scannedAt: now,
          olderThan: now - (pending.retention === "7-days" ? 7 : months * 30) * 24 * 60 * 60_000,
          expiresAt: now + 120_000, activeTaskCount: pending.includeActiveTasks ? 1 : 0,
          deletedTaskCount: 2, archivedTaskCount: 3, messageCount: 17, estimatedHistoryBytes: 1_024,
          databaseBytes: 4_096, temporaryBytesRequired: 8_192,
          databaseVolumeFreeBytes: detail.outcome === "insufficient-space" ? 4_096 : 16_384 };
        this.#scan = scan;
        this.#phase = "report";
        this.#publish();
        pending.resolve(scan);
      }
    } else {
      if (detail.outcome !== "completed" && detail.outcome !== "failure") return false;
      const job = this.#job;
      if (job === undefined || job.progress.status !== "running" || job.scan.scanId !== pending.value.scanId
        || job.progress.maintenanceId !== pending.value.maintenanceId) return false;
      clearTimeout(pending.timer);
      this.#pending = undefined;
      if (detail.outcome === "completed") {
        job.progress = { maintenanceId: job.progress.maintenanceId, status: "completed", phase: "installing",
          percent: 100, cancellable: false, updatedAt: Date.now(), result: { outcome: "completed",
            activeTaskCount: job.scan.activeTaskCount, deletedTaskCount: job.scan.deletedTaskCount,
            archivedTaskCount: job.scan.archivedTaskCount, messageCount: job.scan.messageCount,
            beforeBytes: 4_096, afterBytes: 2_048, reclaimedBytes: 2_048, backupCreated: job.backupEnabled, skippedTaskCount: 1 } };
        this.#completedCleanups += 1;
        this.#phase = "completed";
      } else {
        job.progress = { ...job.progress, status: "failed", cancellable: false, updatedAt: Date.now() };
        this.#phase = "failed";
      }
      this.#publish();
      pending.resolve(job.progress);
    }
    return true;
  }

  /** A StrictMode setup can reuse the fixture, but no prior scan or job survives cleanup. */
  cancelPending(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    this.#scan = undefined;
    this.#job = undefined;
    this.#phase = "ready";
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The deterministic history maintenance owner retired."));
    }
    this.#publish();
  }

  #deadline(value: VisualHistoryMaintenanceAttempt): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.#pending?.value === value) this.#failPending(new Error("The deterministic history request timed out."));
    }, 60_000);
  }
  #failPending(error: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    if (pending.kind === "scan") this.#failedScans += 1;
    this.#phase = "failed";
    this.#publish();
    pending.reject(error);
  }
  #publish(): void { for (const listener of this.#listeners) listener(this.state); }
}

function fixtureId(prefix: "11111111" | "22222222", sequence: number): string {
  return `${prefix}-${prefix === "11111111" ? "1111-4111-8111" : "2222-4222-8222"}-${sequence.toString(16).padStart(12, "0")}`;
}
