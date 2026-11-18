import { manualScheduleDispatchOperationId, scheduleRunIdFromDigest } from "@joko/contracts";

import type { SchedulerRuntimeView } from "./model.js";
import { randomUuid, sha256Hex } from "./web-crypto.js";

/**
 * Opaque identity for one user-initiated Schedule Run Now dispatch window.
 *
 * `presentation` only owns the local busy/error boundary. Its resolution does
 * not claim that the Schedule Run succeeded: it can also resolve because the
 * authoritative Run became observable, the RPC settled successfully, or the
 * UI owner retired.
 */
export interface ScheduleRunNowDispatchAttempt {
  readonly scheduleId: string;
  readonly operationId: string;
  readonly presentation: Promise<void>;
}

export interface ScheduleRunNowDispatchTracker {
  /** Immutable snapshot of Schedule IDs whose dispatch window is still open. */
  readonly busyIds: ReadonlySet<string>;

  /**
   * Synchronously opens a per-Schedule dispatch window.
   *
   * Returns `undefined` when that Schedule already has a pending window. A
   * known runtime snapshot establishes the scheduler instance that can confirm
   * the Run created by this operation.
   */
  begin(
    scheduleId: string,
    runtime: SchedulerRuntimeView | undefined
  ): ScheduleRunNowDispatchAttempt | undefined;

  /**
   * Starts and owns the RPC for an attempt. The returned presentation promise
   * is suitable for the UI action boundary. A rejection before authoritative
   * observation is preserved; after early release a late rejection is consumed
   * and cannot affect a newer attempt for the same Schedule.
   */
  attach(
    attempt: ScheduleRunNowDispatchAttempt,
    dispatch: (operationId: string) => Promise<void>
  ): Promise<void>;

  /** Applies one authoritative runtime snapshot to pending dispatch windows. */
  observe(runtime: SchedulerRuntimeView): void;

  /** Retires the current UI/controller owner and releases all local guards. */
  retire(): void;
}

interface PendingDispatch {
  readonly attempt: ScheduleRunNowDispatchAttempt;
  readonly schedulerInstanceId?: string;
  expectedRunId?: string;
  readonly resolvePresentation: () => void;
  readonly rejectPresentation: (reason: unknown) => void;
  attached: boolean;
  presentationSettled: boolean;
}

export function createScheduleRunNowDispatchTracker(
  onBusyIdsChange: (busyIds: ReadonlySet<string>) => void = () => undefined
): ScheduleRunNowDispatchTracker {
  return new ScheduleRunNowDispatchTrackerImpl(onBusyIdsChange);
}

class ScheduleRunNowDispatchTrackerImpl implements ScheduleRunNowDispatchTracker {
  readonly #onBusyIdsChange: (busyIds: ReadonlySet<string>) => void;
  readonly #pendingByScheduleId = new Map<string, PendingDispatch>();
  readonly #pendingByAttempt = new WeakMap<ScheduleRunNowDispatchAttempt, PendingDispatch>();
  #busyIds: ReadonlySet<string> = new Set();
  #schedulerInstanceId: string | undefined;

  constructor(onBusyIdsChange: (busyIds: ReadonlySet<string>) => void) {
    this.#onBusyIdsChange = onBusyIdsChange;
  }

  get busyIds(): ReadonlySet<string> {
    return this.#busyIds;
  }

  begin(
    scheduleId: string,
    runtime: SchedulerRuntimeView | undefined
  ): ScheduleRunNowDispatchAttempt | undefined {
    if (runtime !== undefined) this.#adoptSchedulerInstance(runtime.instanceId);
    if (this.#pendingByScheduleId.has(scheduleId)) return undefined;

    let resolvePresentation!: () => void;
    let rejectPresentation!: (reason: unknown) => void;
    const presentation = new Promise<void>((resolve, reject) => {
      resolvePresentation = resolve;
      rejectPresentation = reject;
    });
    const attempt: ScheduleRunNowDispatchAttempt = { scheduleId, operationId: randomUuid(), presentation };
    const pending: PendingDispatch = {
      attempt,
      ...(runtime === undefined ? {} : { schedulerInstanceId: runtime.instanceId }),
      resolvePresentation,
      rejectPresentation,
      attached: false,
      presentationSettled: false
    };
    this.#pendingByScheduleId.set(scheduleId, pending);
    this.#pendingByAttempt.set(attempt, pending);
    this.#publishBusyIds();
    return attempt;
  }

  attach(
    attempt: ScheduleRunNowDispatchAttempt,
    dispatch: (operationId: string) => Promise<void>
  ): Promise<void> {
    const pending = this.#pendingByAttempt.get(attempt);
    if (pending === undefined) throw new TypeError("Unknown Schedule Run Now dispatch attempt.");
    if (pending.attached) return pending.attempt.presentation;
    // The UI/controller owner may retire between begin and attach. In that
    // case the local gate is already closed and must not dispatch through the
    // stale owner.
    if (pending.presentationSettled) return pending.attempt.presentation;
    pending.attached = true;

    void this.#dispatch(pending, dispatch);
    return pending.attempt.presentation;
  }

  observe(runtime: SchedulerRuntimeView): void {
    if (this.#adoptSchedulerInstance(runtime.instanceId)) return;

    for (const pending of [...this.#pendingByScheduleId.values()]) {
      if (pending.expectedRunId === undefined || pending.schedulerInstanceId !== runtime.instanceId) continue;
      // Loading and claiming can precede a definitive admission rejection.
      const observedRun = runtime.runs.some((run) => run.scheduleId === pending.attempt.scheduleId
        && run.source === "runNow"
        && run.runId === pending.expectedRunId
        && (run.phase === "queued" || run.phase === "running"));
      if (observedRun) this.#resolvePresentation(pending);
    }
  }

  retire(): void {
    this.#schedulerInstanceId = undefined;
    this.#resolveAllPending();
  }

  #adoptSchedulerInstance(instanceId: string): boolean {
    if (this.#schedulerInstanceId === undefined) {
      this.#schedulerInstanceId = instanceId;
      return false;
    }
    if (this.#schedulerInstanceId === instanceId) return false;

    this.#schedulerInstanceId = instanceId;
    this.#resolveAllPending();
    return true;
  }

  async #dispatch(
    pending: PendingDispatch,
    dispatch: (operationId: string) => Promise<void>
  ): Promise<void> {
    const { operationId } = pending.attempt;
    try {
      if (pending.schedulerInstanceId !== undefined) {
        const source = new TextEncoder().encode(manualScheduleDispatchOperationId(operationId));
        pending.expectedRunId = scheduleRunIdFromDigest(await sha256Hex(source.buffer));
      }
      if (pending.presentationSettled) return;
      await dispatch(operationId);
      this.#resolvePresentation(pending);
    } catch (error) {
      this.#rejectPresentation(pending, error);
    }
  }

  #resolveAllPending(): void {
    const pending = [...this.#pendingByScheduleId.values()];
    if (pending.length === 0) return;
    this.#pendingByScheduleId.clear();
    for (const dispatch of pending) {
      if (dispatch.presentationSettled) continue;
      dispatch.presentationSettled = true;
      dispatch.resolvePresentation();
    }
    this.#publishBusyIds();
  }

  #resolvePresentation(pending: PendingDispatch): void {
    if (pending.presentationSettled) return;
    pending.presentationSettled = true;
    if (this.#pendingByScheduleId.get(pending.attempt.scheduleId) === pending) {
      this.#pendingByScheduleId.delete(pending.attempt.scheduleId);
      this.#publishBusyIds();
    }
    pending.resolvePresentation();
  }

  #rejectPresentation(pending: PendingDispatch, error: unknown): void {
    if (pending.presentationSettled) return;
    pending.presentationSettled = true;
    if (this.#pendingByScheduleId.get(pending.attempt.scheduleId) === pending) {
      this.#pendingByScheduleId.delete(pending.attempt.scheduleId);
      this.#publishBusyIds();
    }
    pending.rejectPresentation(error);
  }

  #publishBusyIds(): void {
    this.#busyIds = new Set(this.#pendingByScheduleId.keys());
    this.#onBusyIdsChange(this.#busyIds);
  }
}
