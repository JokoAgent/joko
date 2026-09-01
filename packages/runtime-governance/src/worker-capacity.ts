import { randomUUID } from "node:crypto";

import type { CollaborationSettings } from "./settings.js";
import { validateCollaborationSettings } from "./settings.js";

export interface WorkerCapacityLease {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly workerId: string;
  readonly acquiredAt: number;
  readonly softLimitReached: boolean;
}

export interface WorkerCapacitySnapshot {
  readonly active: number;
  readonly idle: number;
  readonly softLimit: number;
  readonly hardLimit: number;
}

export interface WorkerCapacityController {
  acquire(ownerId: string, workerId: string): Promise<WorkerCapacityLease>;
  markActive(leaseId: string): boolean;
  markIdle(leaseId: string): boolean;
  release(leaseId: string): boolean;
  releaseOwner(ownerId: string): number;
  sweepIdle(): Promise<readonly string[]>;
  snapshot(): WorkerCapacitySnapshot;
  close(): Promise<void>;
}

export interface WorkerCapacityControllerOptions {
  readonly readSettings: () => CollaborationSettings;
  readonly releaseIdleWorker: (lease: WorkerCapacityLease) => void | Promise<void>;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly sweepIntervalMs?: number;
}

export class WorkerHardLimitError extends Error {
  readonly code = "WORKER_HARD_LIMIT_REACHED";

  constructor(
    readonly hardLimit: number,
    readonly occupied: number
  ) {
    super(`Worker hard limit ${hardLimit} is already occupied.`);
    this.name = "WorkerHardLimitError";
  }
}

interface InternalLease extends WorkerCapacityLease {
  state: "active" | "idle";
  idleSince?: number;
  releasing: boolean;
}

export function createWorkerCapacityController(options: WorkerCapacityControllerOptions): WorkerCapacityController {
  const now = options.now ?? Date.now;
  const idFactory = options.idFactory ?? randomUUID;
  const leases = new Map<string, InternalLease>();
  const workerKeys = new Map<string, string>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 5_000;
  if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new Error("Worker idle sweep interval must be positive.");
  }
  let closed = false;
  let sweepTail = Promise.resolve<readonly string[]>([]);
  const timer = setInterval(() => { void sweep(); }, sweepIntervalMs);
  timer.unref?.();

  const settings = (): CollaborationSettings => validateCollaborationSettings(options.readSettings());
  const keyOf = (ownerId: string, workerId: string): string => `${ownerId}\u0000${workerId}`;

  const release = (leaseId: string): boolean => {
    const lease = leases.get(leaseId);
    if (lease === undefined) return false;
    leases.delete(leaseId);
    workerKeys.delete(keyOf(lease.ownerId, lease.workerId));
    return true;
  };

  const sweep = (): Promise<readonly string[]> => {
    const task = sweepTail.then(async () => {
      if (closed) return [];
      const configured = settings();
      if (configured.workerIdleReleaseMinutes <= 0) return [];
      const threshold = now() - configured.workerIdleReleaseMinutes * 60_000;
      const released: string[] = [];
      for (const lease of leases.values()) {
        if (lease.state !== "idle" || lease.releasing || (lease.idleSince ?? Number.POSITIVE_INFINITY) > threshold) continue;
        lease.releasing = true;
        try {
          await options.releaseIdleWorker(publicLease(lease));
          if (release(lease.leaseId)) released.push(lease.leaseId);
        } finally {
          const current = leases.get(lease.leaseId);
          if (current !== undefined) current.releasing = false;
        }
      }
      return released;
    });
    sweepTail = task.catch(() => []);
    return task;
  };

  return {
    async acquire(ownerId, workerId) {
      if (closed) throw new Error("Worker capacity controller is closed.");
      const normalizedOwner = boundedIdentifier(ownerId, "Worker owner");
      const normalizedWorker = boundedIdentifier(workerId, "Worker ID");
      await sweep();
      const key = keyOf(normalizedOwner, normalizedWorker);
      const duplicate = workerKeys.get(key);
      if (duplicate !== undefined) return publicLease(leases.get(duplicate)!);
      const configured = settings();
      if (leases.size >= configured.workerHardLimit) {
        throw new WorkerHardLimitError(configured.workerHardLimit, leases.size);
      }
      const lease: InternalLease = {
        leaseId: boundedIdentifier(idFactory(), "Worker lease ID"),
        ownerId: normalizedOwner,
        workerId: normalizedWorker,
        acquiredAt: now(),
        softLimitReached: leases.size + 1 >= configured.workerSoftLimit,
        state: "active",
        releasing: false
      };
      if (leases.has(lease.leaseId)) throw new Error("Worker lease ID collision.");
      leases.set(lease.leaseId, lease);
      workerKeys.set(key, lease.leaseId);
      return publicLease(lease);
    },
    markActive(leaseId) {
      const lease = leases.get(leaseId);
      if (lease === undefined || lease.releasing) return false;
      lease.state = "active";
      lease.idleSince = undefined;
      return true;
    },
    markIdle(leaseId) {
      const lease = leases.get(leaseId);
      if (lease === undefined || lease.releasing) return false;
      lease.state = "idle";
      lease.idleSince = now();
      return true;
    },
    release,
    releaseOwner(ownerId) {
      const normalized = boundedIdentifier(ownerId, "Worker owner");
      let count = 0;
      for (const lease of [...leases.values()]) {
        if (lease.ownerId === normalized && release(lease.leaseId)) count += 1;
      }
      return count;
    },
    sweepIdle: sweep,
    snapshot() {
      const configured = settings();
      let active = 0;
      let idle = 0;
      for (const lease of leases.values()) {
        if (lease.state === "idle") idle += 1;
        else active += 1;
      }
      return { active, idle, softLimit: configured.workerSoftLimit, hardLimit: configured.workerHardLimit };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await sweepTail.catch(() => undefined);
      leases.clear();
      workerKeys.clear();
    }
  };
}

function publicLease(lease: InternalLease): WorkerCapacityLease {
  return {
    leaseId: lease.leaseId,
    ownerId: lease.ownerId,
    workerId: lease.workerId,
    acquiredAt: lease.acquiredAt,
    softLimitReached: lease.softLimitReached
  };
}

function boundedIdentifier(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 1 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}
