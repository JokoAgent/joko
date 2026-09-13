import type {
  OperationalStore,
  ScheduleRuntimeOccurrenceRecord,
  SchedulerRuntimeOwnerRecord
} from "@joko/store";

import {
  SchedulerRuntimeState,
  type ScheduleFireSource,
  type ScheduleRunPhase,
  type ScheduleRuntimeExecutionMode
} from "./scheduler-runtime-state.js";

export const DEFAULT_SCHEDULE_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_SCHEDULE_HEARTBEAT_LEASE_MS = 60_000;
export const DEFAULT_SCHEDULE_RUN_STALL_MS = 60 * 60_000;
export const DEFAULT_SCHEDULE_STALL_ABORT_GRACE_MS = 60_000;

export type ScheduleOccurrenceReleaseReason = "stalled" | "stale-owner";
type OrdinaryScheduleRunPhase = Exclude<ScheduleRunPhase, "stalled" | "recovering">;

export interface ScheduleOccurrenceRecoveryOptions {
  readonly now?: () => number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatLeaseMs?: number;
  readonly runStallMs?: number;
  readonly stallAbortGraceMs?: number;
  readonly staleAbortGraceMs?: number;
  readonly suspendGapMs?: number;
  readonly onAbortStale?: (occurrence: ScheduleRuntimeOccurrenceRecord) => unknown;
  readonly onForceRelease?: (
    occurrence: ScheduleRuntimeOccurrenceRecord,
    reason: ScheduleOccurrenceReleaseReason,
    noProgressMs: number
  ) => void;
  readonly onError?: (error: unknown) => void;
}

interface OccurrenceFence {
  readonly ownerId: string;
  readonly ownerGeneration: number;
}

interface TrackedOccurrence {
  occurrence: ScheduleRuntimeOccurrenceRecord;
  readonly abort: () => unknown;
  readonly forceReleased: Promise<void>;
  readonly resolveForceReleased: () => void;
  stall?: {
    readonly lastProgressAt: number;
    readonly abortRequestedAt: number;
    readonly previousPhase: OrdinaryScheduleRunPhase;
  };
}

interface RecoveringOccurrence {
  occurrence: ScheduleRuntimeOccurrenceRecord;
  readonly deadline: number;
}

export interface ScheduleOccurrenceBeginInput {
  readonly scheduleId: string;
  readonly scheduleName?: string;
  readonly runId: string;
  readonly source: ScheduleFireSource;
  readonly executionMode?: ScheduleRuntimeExecutionMode;
  readonly scheduledAt: number;
  readonly phase?: ScheduleRunPhase;
  readonly abort: () => unknown;
}

export type ScheduleOccurrenceRaceResult<T> =
  | { readonly forceReleased: false; readonly value: T }
  | { readonly forceReleased: true };

/**
 * Couples process-local scheduler slots to content-free durable leases.
 *
 * Every destructive recovery path first takes an atomic generation-fenced
 * claim. A heartbeat or progress update that wins that race prevents the
 * claim, so an actively progressing occurrence cannot be force-released.
 */
export class SchedulerOccurrenceRecovery {
  readonly #store: OperationalStore;
  readonly #runtime: SchedulerRuntimeState;
  readonly #now: () => number;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatLeaseMs: number;
  readonly #runStallMs: number;
  readonly #stallAbortGraceMs: number;
  readonly #staleAbortGraceMs: number;
  readonly #suspendGapMs: number;
  readonly #onAbortStale: (occurrence: ScheduleRuntimeOccurrenceRecord) => unknown;
  readonly #onForceRelease: (
    occurrence: ScheduleRuntimeOccurrenceRecord,
    reason: ScheduleOccurrenceReleaseReason,
    noProgressMs: number
  ) => void;
  readonly #onError: (error: unknown) => void;
  readonly #tracked = new Map<string, TrackedOccurrence>();
  readonly #recovering = new Map<string, RecoveringOccurrence>();
  readonly #forceReleased = new Set<string>();
  #owner: SchedulerRuntimeOwnerRecord | undefined;
  #timer: NodeJS.Timeout | undefined;
  #pulsing = false;
  #lastPulseAt: number | undefined;

  constructor(
    store: OperationalStore,
    runtime: SchedulerRuntimeState,
    options: ScheduleOccurrenceRecoveryOptions = {}
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#now = options.now ?? Date.now;
    this.#heartbeatIntervalMs = positiveDuration(
      options.heartbeatIntervalMs ?? DEFAULT_SCHEDULE_HEARTBEAT_INTERVAL_MS,
      "Schedule heartbeat interval"
    );
    this.#heartbeatLeaseMs = positiveDuration(
      options.heartbeatLeaseMs ?? DEFAULT_SCHEDULE_HEARTBEAT_LEASE_MS,
      "Schedule heartbeat lease"
    );
    if (this.#heartbeatLeaseMs <= this.#heartbeatIntervalMs) {
      throw new Error("Schedule heartbeat lease must exceed its touch interval.");
    }
    this.#runStallMs = positiveDuration(
      options.runStallMs ?? DEFAULT_SCHEDULE_RUN_STALL_MS,
      "Schedule stall threshold"
    );
    this.#stallAbortGraceMs = positiveDuration(
      options.stallAbortGraceMs ?? DEFAULT_SCHEDULE_STALL_ABORT_GRACE_MS,
      "Schedule stall abort grace"
    );
    this.#staleAbortGraceMs = positiveDuration(
      options.staleAbortGraceMs ?? this.#stallAbortGraceMs,
      "Schedule stale-owner abort grace"
    );
    this.#suspendGapMs = nonNegativeDuration(options.suspendGapMs ?? 30_000, "Schedule suspension gap");
    this.#onAbortStale = options.onAbortStale ?? (() => undefined);
    this.#onForceRelease = options.onForceRelease ?? (() => undefined);
    this.#onError = options.onError ?? (() => undefined);
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#ensureOwner();
    this.pulse();
    this.#timer = setInterval(() => this.pulse(), this.#heartbeatIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  begin(input: ScheduleOccurrenceBeginInput): void {
    const owner = this.#ensureOwner();
    const now = this.#now();
    const occurrence = this.#store.beginScheduleRuntimeOccurrence({
      runId: input.runId,
      scheduleId: input.scheduleId,
      source: input.source,
      ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
      phase: input.phase ?? "loading",
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      scheduledAt: input.scheduledAt,
      startedAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs
    });
    let resolveForceReleased!: () => void;
    const forceReleased = new Promise<void>((resolve) => {
      resolveForceReleased = resolve;
    });
    try {
      this.#runtime.begin({
        scheduleId: input.scheduleId,
        ...(input.scheduleName === undefined ? {} : { scheduleName: input.scheduleName }),
        runId: input.runId,
        source: input.source,
        ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
        scheduledAt: input.scheduledAt,
        startedAt: occurrence.startedAt,
        lastProgressAt: occurrence.lastProgressAt,
        phase: input.phase ?? "loading"
      });
    } catch (error) {
      this.#store.releaseScheduleRuntimeOccurrence(fenceInput(occurrence));
      throw error;
    }
    this.#tracked.set(input.runId, {
      occurrence,
      abort: input.abort,
      forceReleased,
      resolveForceReleased
    });
  }

  transition(
    runId: string,
    phase: OrdinaryScheduleRunPhase,
    patch: { readonly scheduleName?: string; readonly executionMode?: ScheduleRuntimeExecutionMode } = {}
  ): boolean {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined) return false;
    const now = this.#now();
    const occurrence = this.#store.touchScheduleRuntimeOccurrence({
      ...fenceInput(tracked.occurrence),
      heartbeatAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs,
      progressAt: now,
      phase,
      ...(patch.executionMode === undefined ? {} : { executionMode: patch.executionMode })
    });
    if (occurrence === undefined) {
      this.#fenceTracked(tracked);
      return false;
    }
    tracked.occurrence = occurrence;
    tracked.stall = undefined;
    this.#runtime.transition(runId, phase, patch);
    return true;
  }

  progress(runId: string): boolean {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined) return false;
    const now = this.#now();
    const resumedPhase = tracked.stall?.previousPhase;
    const occurrence = this.#store.touchScheduleRuntimeOccurrence({
      ...fenceInput(tracked.occurrence),
      heartbeatAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs,
      progressAt: now,
      ...(resumedPhase === undefined ? {} : { phase: resumedPhase })
    });
    if (occurrence === undefined) {
      this.#fenceTracked(tracked);
      return false;
    }
    tracked.occurrence = occurrence;
    tracked.stall = undefined;
    if (resumedPhase === undefined) this.#runtime.progress(runId);
    else this.#runtime.transition(runId, resumedPhase);
    return true;
  }

  finish(runId: string): boolean {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined) {
      this.#runtime.finish(runId);
      return false;
    }
    this.#tracked.delete(runId);
    const released = this.#store.releaseScheduleRuntimeOccurrence(fenceInput(tracked.occurrence));
    this.#runtime.finish(runId);
    return released;
  }

  async race<T>(runId: string, work: Promise<T>): Promise<ScheduleOccurrenceRaceResult<T>> {
    const tracked = this.#tracked.get(runId);
    if (tracked === undefined) return { forceReleased: false, value: await work };
    void work.then(
      () => this.#acknowledgeLateSettle(runId),
      () => this.#acknowledgeLateSettle(runId)
    );
    const forced = Symbol("schedule-force-release");
    const result = await Promise.race<T | typeof forced>([
      work,
      tracked.forceReleased.then(() => forced)
    ]);
    return result === forced ? { forceReleased: true } : { forceReleased: false, value: result };
  }

  wasForceReleased(runId: string): boolean {
    return this.#forceReleased.has(runId);
  }

  pulse(): void {
    if (this.#pulsing) return;
    this.#pulsing = true;
    try {
      const owner = this.#ensureOwner();
      const now = this.#now();
      if (!this.#store.touchSchedulerRuntimeOwner({
        ownerId: owner.ownerId,
        generation: owner.generation,
        heartbeatAt: now,
        leaseExpiresAt: now + this.#heartbeatLeaseMs
      })) {
        this.#fenceAllTracked();
        return;
      }
      this.#owner = this.#store.getSchedulerRuntimeOwner();
      this.#absorbSuspendGap(now);
      for (const tracked of [...this.#tracked.values()]) this.#pulseTracked(tracked, now);
      for (const recovery of [...this.#recovering.values()]) {
        const touched = this.#store.touchScheduleRuntimeOccurrence({
          ...fenceInput(recovery.occurrence),
          heartbeatAt: now,
          leaseExpiresAt: now + this.#heartbeatLeaseMs
        });
        if (touched === undefined) {
          this.#recovering.delete(recovery.occurrence.runId);
          this.#runtime.finish(recovery.occurrence.runId);
          continue;
        }
        recovery.occurrence = touched;
        if (now >= recovery.deadline) this.#finalizeRecovered(recovery.occurrence.runId);
      }
      this.#claimStale(now);
    } catch (error) {
      this.#report(error);
    } finally {
      this.#pulsing = false;
    }
  }

  #pulseTracked(tracked: TrackedOccurrence, now: number): void {
    const run = this.#runtime.find(tracked.occurrence.runId);
    if (run === undefined) return;
    if (tracked.stall !== undefined && run.lastProgressAt > tracked.stall.lastProgressAt) {
      this.transition(run.runId, tracked.stall.previousPhase, {
        ...(run.scheduleName === undefined ? {} : { scheduleName: run.scheduleName }),
        ...(run.executionMode === undefined ? {} : { executionMode: run.executionMode })
      });
      return;
    }
    const touched = this.#store.touchScheduleRuntimeOccurrence({
      ...fenceInput(tracked.occurrence),
      heartbeatAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs,
      ...(run.lastProgressAt > tracked.occurrence.lastProgressAt ? { progressAt: run.lastProgressAt } : {})
    });
    if (touched === undefined) {
      this.#fenceTracked(tracked);
      return;
    }
    tracked.occurrence = touched;
    if (tracked.stall !== undefined) {
      if (now - tracked.stall.abortRequestedAt >= this.#stallAbortGraceMs) {
        this.#forceReleaseTracked(tracked, now);
      }
      return;
    }
    if (
      run.executionMode === "script" ||
      run.phase === "queued" ||
      run.phase === "cancelling" ||
      run.phase === "finalizing" ||
      run.phase === "stalled" ||
      run.phase === "recovering" ||
      now - run.lastProgressAt < this.#runStallMs
    ) return;
    const stalled = this.#store.markScheduleRuntimeOccurrenceStalled({
      ...fenceInput(tracked.occurrence),
      expectedLastProgressAt: tracked.occurrence.lastProgressAt,
      stalledAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs
    });
    if (stalled === undefined) return;
    tracked.occurrence = stalled;
    tracked.stall = {
      lastProgressAt: stalled.lastProgressAt,
      abortRequestedAt: now,
      previousPhase: run.phase
    };
    this.#runtime.transition(run.runId, "stalled", { markProgress: false });
    try {
      const result = tracked.abort();
      if (isPromiseLike(result)) void Promise.resolve(result).catch((error) => this.#report(error));
    } catch (error) {
      this.#report(error);
    }
  }

  #forceReleaseTracked(tracked: TrackedOccurrence, now: number): void {
    const stall = tracked.stall;
    if (stall === undefined) return;
    const owner = this.#owner;
    if (owner === undefined) return;
    const claimed = this.#store.claimStalledScheduleRuntimeOccurrence({
      runId: tracked.occurrence.runId,
      expectedOwnerId: tracked.occurrence.ownerId,
      expectedOwnerGeneration: tracked.occurrence.ownerGeneration,
      expectedLastProgressAt: stall.lastProgressAt,
      recoveryOwnerId: owner.ownerId,
      recoveryGenerationFloor: owner.generation,
      claimedAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs
    });
    if (claimed === undefined) {
      const current = this.#store.findScheduleRuntimeOccurrence(tracked.occurrence.runId);
      if (current === undefined || !sameFence(current, tracked.occurrence)) this.#fenceTracked(tracked);
      return;
    }
    tracked.occurrence = claimed;
    this.#runtime.transition(claimed.runId, "recovering", { markProgress: false });
    this.#tracked.delete(claimed.runId);
    this.#forceReleased.add(claimed.runId);
    try {
      this.#onForceRelease(claimed, "stalled", Math.max(0, now - claimed.lastProgressAt));
    } catch (error) {
      this.#report(error);
    } finally {
      this.#store.releaseScheduleRuntimeOccurrence(fenceInput(claimed));
      this.#runtime.finish(claimed.runId);
      tracked.resolveForceReleased();
    }
  }

  #claimStale(now: number): void {
    const owner = this.#owner;
    if (owner === undefined) return;
    const claimed = this.#store.claimStaleScheduleRuntimeOccurrences({
      recoveryOwnerId: owner.ownerId,
      recoveryGenerationFloor: owner.generation,
      claimedAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs,
      limit: 100
    });
    for (const occurrence of claimed) {
      if (this.#recovering.has(occurrence.runId)) continue;
      this.#runtime.begin({
        scheduleId: occurrence.scheduleId,
        runId: occurrence.runId,
        source: occurrence.source,
        ...(occurrence.executionMode === undefined ? {} : { executionMode: occurrence.executionMode }),
        scheduledAt: occurrence.scheduledAt,
        startedAt: occurrence.startedAt,
        lastProgressAt: occurrence.lastProgressAt,
        phase: "recovering"
      });
      this.#recovering.set(occurrence.runId, {
        occurrence,
        deadline: now + this.#staleAbortGraceMs
      });
      try {
        const result = this.#onAbortStale(occurrence);
        if (isPromiseLike(result)) {
          void Promise.resolve(result).then(
            () => this.#finalizeRecovered(occurrence.runId),
            (error) => {
              this.#report(error);
              this.#finalizeRecovered(occurrence.runId);
            }
          );
        } else {
          this.#finalizeRecovered(occurrence.runId);
        }
      } catch (error) {
        this.#report(error);
        this.#finalizeRecovered(occurrence.runId);
      }
    }
  }

  #finalizeRecovered(runId: string): void {
    const recovery = this.#recovering.get(runId);
    if (recovery === undefined) return;
    this.#recovering.delete(runId);
    const now = this.#now();
    try {
      this.#onForceRelease(
        recovery.occurrence,
        "stale-owner",
        Math.max(0, now - recovery.occurrence.lastProgressAt)
      );
    } catch (error) {
      this.#report(error);
    } finally {
      this.#store.releaseScheduleRuntimeOccurrence(fenceInput(recovery.occurrence));
      this.#runtime.finish(runId);
    }
  }

  #ensureOwner(): SchedulerRuntimeOwnerRecord {
    if (this.#owner !== undefined) return this.#owner;
    const now = this.#now();
    this.#owner = this.#store.claimSchedulerRuntimeOwner({
      ownerId: this.#runtime.instanceId(),
      startedAt: now,
      leaseExpiresAt: now + this.#heartbeatLeaseMs
    });
    this.#lastPulseAt = now;
    return this.#owner;
  }

  #absorbSuspendGap(now: number): void {
    const lastPulseAt = this.#lastPulseAt;
    this.#lastPulseAt = now;
    if (lastPulseAt === undefined || this.#suspendGapMs === 0) return;
    const gapMs = now - lastPulseAt - this.#heartbeatIntervalMs;
    if (gapMs <= this.#suspendGapMs) return;
    this.#runtime.absorbClockGap(gapMs);
    for (const tracked of [...this.#tracked.values()]) {
      const shifted = this.#store.shiftScheduleRuntimeOccurrenceClock({
        ...fenceInput(tracked.occurrence),
        gapMs,
        heartbeatAt: now,
        leaseExpiresAt: now + this.#heartbeatLeaseMs
      });
      if (shifted === undefined) {
        this.#fenceTracked(tracked);
        continue;
      }
      tracked.occurrence = shifted;
      if (tracked.stall !== undefined) {
        tracked.stall = {
          lastProgressAt: tracked.stall.lastProgressAt + gapMs,
          abortRequestedAt: tracked.stall.abortRequestedAt + gapMs,
          previousPhase: tracked.stall.previousPhase
        };
      }
    }
    for (const [runId, recovery] of [...this.#recovering]) {
      const shifted = this.#store.shiftScheduleRuntimeOccurrenceClock({
        ...fenceInput(recovery.occurrence),
        gapMs,
        heartbeatAt: now,
        leaseExpiresAt: now + this.#heartbeatLeaseMs
      });
      if (shifted === undefined) {
        this.#recovering.delete(runId);
        this.#runtime.finish(runId);
        continue;
      }
      this.#recovering.set(runId, {
        occurrence: shifted,
        deadline: recovery.deadline + gapMs
      });
    }
  }

  #fenceTracked(tracked: TrackedOccurrence): void {
    const runId = tracked.occurrence.runId;
    if (!this.#tracked.delete(runId)) return;
    try {
      const result = tracked.abort();
      if (isPromiseLike(result)) void Promise.resolve(result).catch((error) => this.#report(error));
    } catch (error) {
      this.#report(error);
    }
    this.#forceReleased.add(runId);
    this.#runtime.finish(runId);
    tracked.resolveForceReleased();
  }

  #fenceAllTracked(): void {
    for (const tracked of [...this.#tracked.values()]) this.#fenceTracked(tracked);
  }

  #acknowledgeLateSettle(runId: string): void {
    if (this.#forceReleased.has(runId)) this.#forceReleased.delete(runId);
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Diagnostics cannot change the recovery fence.
    }
  }
}

function fenceInput(occurrence: ScheduleRuntimeOccurrenceRecord): {
  readonly runId: string;
  readonly ownerId: string;
  readonly ownerGeneration: number;
} {
  return {
    runId: occurrence.runId,
    ownerId: occurrence.ownerId,
    ownerGeneration: occurrence.ownerGeneration
  };
}

function sameFence(left: OccurrenceFence, right: OccurrenceFence): boolean {
  return left.ownerId === right.ownerId && left.ownerGeneration === right.ownerGeneration;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { readonly then?: unknown }).then === "function";
}
