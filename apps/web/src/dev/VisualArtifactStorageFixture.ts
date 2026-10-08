import type {
  ArtifactStorageCleanupView,
  ArtifactStorageMaintenanceView,
  ArtifactStorageReconcileView,
  ArtifactStorageScanView,
  ArtifactStorageStatsView
} from "../model.js";

export const VISUAL_ARTIFACT_STORAGE_SETTLE_EVENT = "joko-visual-artifact-storage-settle";
export const VISUAL_ARTIFACT_STORAGE_DRAFT_TEXT = "draft bytes";
let nextFixtureOwner = 0;

export interface VisualArtifactStorageAttempt {
  readonly kind: "health" | "scan" | "progress";
  readonly attempt: number;
  readonly token?: string;
  readonly maintenanceId?: string;
  readonly protectedSha256: readonly string[];
}

export interface VisualArtifactStorageState {
  readonly ownerId: string;
  readonly phase: "ready" | "checking" | "scanning" | "report" | "running" | "failed" | "completed";
  readonly statsReads: number;
  readonly healthRequests: number;
  readonly scanRequests: number;
  readonly cleanupRequests: number;
  readonly progressReads: number;
  readonly failedScans: number;
  readonly completedCleanups: number;
  readonly stats: ArtifactStorageStatsView;
  readonly protectedSha256: readonly string[];
  readonly pending?: VisualArtifactStorageAttempt;
  readonly scan?: { readonly token: string; readonly protectedSha256: readonly string[];
    readonly protectedReferenceCount: number; readonly missingBlobCount: number; readonly unsafeEntryCount: number };
  readonly cleanup?: { readonly token: string; readonly maintenanceId: string;
    readonly protectedSha256: readonly string[]; readonly status: ArtifactStorageCleanupView["status"]; readonly percent: number };
}

interface PendingBase {
  readonly value: VisualArtifactStorageAttempt;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
type PendingRead =
  | PendingBase & { readonly kind: "health"; readonly resolve: (value: ArtifactStorageReconcileView) => void }
  | PendingBase & { readonly kind: "scan"; readonly resolve: (value: ArtifactStorageScanView) => void }
  | PendingBase & { readonly kind: "progress"; readonly resolve: (value: ArtifactStorageCleanupView) => void };

interface CleanupJob {
  readonly scan: ArtifactStorageScanView;
  readonly protectedSha256: readonly string[];
  progress: ArtifactStorageCleanupView;
}

/** Development-only typed backend; all files and cleanup results remain in memory. */
export class VisualArtifactStorageFixture {
  readonly #ownerId = `visual-artifact-storage-owner-${++nextFixtureOwner}`;
  readonly #listeners = new Set<(state: VisualArtifactStorageState) => void>();
  #phase: VisualArtifactStorageState["phase"] = "ready";
  #attempt = 0;
  #statsReads = 0;
  #healthRequests = 0;
  #scanRequests = 0;
  #cleanupRequests = 0;
  #progressReads = 0;
  #failedScans = 0;
  #completedCleanups = 0;
  #protectedSha256?: readonly string[];
  #scan?: ArtifactStorageScanView;
  #job?: CleanupJob;
  #pending?: PendingRead;

  get state(): VisualArtifactStorageState {
    return {
      ownerId: this.#ownerId, phase: this.#phase, statsReads: this.#statsReads,
      healthRequests: this.#healthRequests, scanRequests: this.#scanRequests, cleanupRequests: this.#cleanupRequests,
      progressReads: this.#progressReads, failedScans: this.#failedScans, completedCleanups: this.#completedCleanups,
      stats: this.#stats(), protectedSha256: this.#protectedSha256 ?? [],
      ...(this.#pending === undefined ? {} : { pending: this.#pending.value }),
      ...(this.#scan === undefined ? {} : { scan: { token: this.#scan.token,
        protectedSha256: this.#protectedSha256 ?? [], protectedReferenceCount: this.#scan.protectedReferenceCount,
        missingBlobCount: this.#scan.missingBlobCount, unsafeEntryCount: this.#scan.unsafeEntryCount } }),
      ...(this.#job === undefined ? {} : { cleanup: { token: this.#job.scan.token,
        maintenanceId: this.#job.progress.maintenanceId, protectedSha256: this.#job.protectedSha256,
        status: this.#job.progress.status, percent: this.#job.progress.percent } })
    };
  }

  subscribe(listener: (state: VisualArtifactStorageState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  readonly getArtifactStorageStats = async (protectedSha256: readonly string[] = []): Promise<ArtifactStorageMaintenanceView> => {
    this.#protection(protectedSha256);
    this.#statsReads += 1;
    this.#publish();
    return { support: "supported", stats: this.#stats() };
  };

  readonly reconcileArtifactStorage = (protectedSha256: readonly string[] = []): Promise<ArtifactStorageReconcileView> => {
    this.#protection(protectedSha256);
    if (this.#pending !== undefined || this.#job?.progress.status === "running") {
      return Promise.reject(new Error("The deterministic storage request is already pending."));
    }
    this.#healthRequests += 1;
    this.#phase = "checking";
    const value: VisualArtifactStorageAttempt = { kind: "health", attempt: ++this.#attempt, protectedSha256: [...protectedSha256] };
    return new Promise((resolve, reject) => {
      this.#pending = { kind: "health", value, resolve, reject, timer: this.#deadline(value) };
      this.#publish();
    });
  };

  readonly scanArtifactStorage = (protectedSha256: readonly string[] = []): Promise<ArtifactStorageScanView> => {
    this.#protection(protectedSha256);
    if (this.#pending !== undefined || this.#job?.progress.status === "running") {
      return Promise.reject(new Error("The deterministic storage request is already pending."));
    }
    this.#scan = undefined;
    this.#job = undefined;
    this.#scanRequests += 1;
    this.#phase = "scanning";
    const value: VisualArtifactStorageAttempt = { kind: "scan", attempt: ++this.#attempt,
      token: "a".repeat(56) + this.#scanRequests.toString(16).padStart(8, "0"), protectedSha256: [...protectedSha256] };
    return new Promise((resolve, reject) => {
      this.#pending = { kind: "scan", value, resolve, reject, timer: this.#deadline(value) };
      this.#publish();
    });
  };

  readonly beginArtifactStorageCleanup = async (token: string, protectedSha256: readonly string[] = []): Promise<ArtifactStorageCleanupView> => {
    this.#protection(protectedSha256);
    const scan = this.#scan;
    if (this.#pending !== undefined || this.#job !== undefined || scan === undefined || scan.token !== token
      || scan.expiresAt <= Date.now() || scan.missingBlobCount > 0 || scan.unsafeEntryCount > 0) {
      throw new Error("The deterministic storage scan is no longer eligible for cleanup.");
    }
    this.#cleanupRequests += 1;
    const progress: ArtifactStorageCleanupView = { maintenanceId: token, status: "running",
      phase: "quarantining", percent: 60, updatedAt: Date.now() };
    this.#job = { scan, protectedSha256: [...protectedSha256], progress };
    this.#phase = "running";
    this.#publish();
    return progress;
  };

  readonly getArtifactStorageCleanup = (maintenanceId: string): Promise<ArtifactStorageCleanupView> => {
    const job = this.#job;
    if (job === undefined || job.progress.maintenanceId !== maintenanceId) {
      return Promise.reject(new Error("The deterministic storage maintenance source changed."));
    }
    if (job.progress.status !== "running") return Promise.resolve(job.progress);
    if (this.#pending !== undefined) return Promise.reject(new Error("The deterministic storage progress read is already pending."));
    this.#progressReads += 1;
    const value: VisualArtifactStorageAttempt = { kind: "progress", attempt: ++this.#attempt,
      token: job.scan.token, maintenanceId, protectedSha256: job.protectedSha256 };
    return new Promise((resolve, reject) => {
      this.#pending = { kind: "progress", value, resolve, reject, timer: this.#deadline(value) };
      this.#publish();
    });
  };

  settle(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const detail = value as Record<string, unknown>;
    const pending = this.#pending;
    if (pending === undefined || detail.ownerId !== this.#ownerId || detail.kind !== pending.value.kind
      || detail.attempt !== pending.value.attempt || detail.token !== pending.value.token
      || detail.maintenanceId !== pending.value.maintenanceId) return false;
    if (pending.kind === "health") {
      if (detail.outcome !== "healthy" && detail.outcome !== "issues" && detail.outcome !== "failure") return false;
      if (detail.outcome === "failure") this.#failPending(new Error("The deterministic storage health read failed."));
      else {
        this.#release(pending);
        this.#phase = "ready";
        this.#publish();
        pending.resolve({ healthy: detail.outcome === "healthy", missingBlobCount: 0,
          orphanBlobCount: detail.outcome === "issues" ? 1 : 0, unsafeEntryCount: 0 });
      }
    } else if (pending.kind === "scan") {
      if (detail.outcome !== "failure" && detail.outcome !== "warning" && detail.outcome !== "success") return false;
      if (detail.outcome === "failure") this.#failPending(new Error("The deterministic storage scan failed."));
      else {
        this.#release(pending);
        const scan: ArtifactStorageScanView = { token: pending.value.token!, expiresAt: Date.now() + 120_000,
          protectedReferenceCount: pending.value.protectedSha256.length, expiredReferenceCount: 1,
          orphanBlobCount: 1, orphanBlobBytes: 11, temporaryFileCount: 0, temporaryBytes: 0,
          missingBlobCount: detail.outcome === "warning" ? 1 : 0, unsafeEntryCount: detail.outcome === "warning" ? 1 : 0,
          cleanableBytes: 11 };
        this.#scan = scan;
        this.#phase = "report";
        this.#publish();
        pending.resolve(scan);
      }
    } else {
      if (detail.outcome !== "completed" && detail.outcome !== "failure") return false;
      const job = this.#job;
      if (job === undefined || job.progress.status !== "running" || job.scan.token !== pending.value.token
        || job.progress.maintenanceId !== pending.value.maintenanceId) return false;
      this.#release(pending);
      if (detail.outcome === "completed") {
        job.progress = { maintenanceId: job.progress.maintenanceId, status: "completed", phase: "reconciling",
          percent: 100, updatedAt: Date.now(), result: { expiredReferencesDeleted: 1, blobsRemoved: 1,
            temporaryFilesRemoved: 0, freedBytes: 11, skipped: 0 } };
        this.#completedCleanups += 1;
        this.#phase = "completed";
      } else {
        job.progress = { ...job.progress, status: "failed", updatedAt: Date.now() };
        this.#phase = "failed";
      }
      this.#publish();
      pending.resolve(job.progress);
    }
    return true;
  }

  /** A StrictMode setup can reuse the fixture, but prior reports and jobs retire. */
  cancelPending(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    this.#scan = undefined;
    this.#job = undefined;
    this.#phase = "ready";
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The deterministic storage owner retired."));
    }
    this.#publish();
  }

  #protection(value: readonly string[]): void {
    if (value.length !== 1 || value.some((digest) => !/^[a-f0-9]{64}$/u.test(digest))) {
      throw new Error("The deterministic storage draft protection is invalid.");
    }
    if (this.#protectedSha256 === undefined) this.#protectedSha256 = [...value];
    else if (value.join(",") !== this.#protectedSha256.join(",")) throw new Error("The deterministic storage draft changed.");
  }
  #stats(): ArtifactStorageStatsView {
    const completed = this.#completedCleanups > 0;
    return { referenceCount: completed ? 1 : 2, uniqueBlobCount: completed ? 1 : 2, totalBytes: completed ? 11 : 22,
      cacheReferenceCount: completed ? 0 : 1, cacheBytes: completed ? 0 : 11, temporaryFileCount: 0, temporaryBytes: 0 };
  }
  #deadline(value: VisualArtifactStorageAttempt): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      if (this.#pending?.value === value) this.#failPending(new Error("The deterministic storage request timed out."));
    }, 60_000);
  }
  #release(pending: PendingRead): void { clearTimeout(pending.timer); this.#pending = undefined; }
  #failPending(error: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#release(pending);
    if (pending.kind === "scan") this.#failedScans += 1;
    this.#phase = "failed";
    this.#publish();
    pending.reject(error);
  }
  #publish(): void { for (const listener of this.#listeners) listener(this.state); }
}
