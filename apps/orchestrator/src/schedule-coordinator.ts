import { createHash, randomUUID } from "node:crypto";

import { redactSecrets, type PermissionMode, type SessionDescriptor } from "@joko/core";
import type {
  OperationalStore,
  ScheduleRecord,
  ScheduleRuntimeOccurrenceRecord,
  UpsertScheduleInput
} from "@joko/store";

import {
  scheduleExtensionSnapshot,
  scheduleWorktreeConfiguration,
  type ScheduleWorktreeConfiguration
} from "./schedule-extensions.js";
import { validateScheduleHookScriptBinding } from "./schedule-hook-script-installer.js";
import {
  durableSchedulePreRunHookResult,
  executeSchedulePreRunHook,
  schedulePreRunFailureSummary,
  schedulePreRunSkipSummary,
  type SchedulePreRunHookInput,
  type SchedulePreRunHookResult
} from "./schedule-pre-run-hook.js";
import { HostScheduleScriptCapabilityBroker } from "./schedule-script-capability-broker.js";
import {
  executeScheduleScript,
  type ScheduleScriptCapabilityBroker,
  type ScheduleScriptExecutionResult,
  type ScheduleScriptInput
} from "./schedule-script-runner.js";
import { nextOccurrence, type ScheduleTiming } from "./scheduler.js";
import {
  SchedulerOccurrenceRecovery,
  type ScheduleOccurrenceReleaseReason
} from "./scheduler-occurrence-recovery.js";
import {
  SchedulerRuntimeState,
  type SchedulerRuntimeSnapshot
} from "./scheduler-runtime-state.js";
import type { SessionHost } from "./session-host.js";

export interface ScheduleCoordinatorOptions {
  readonly tickMs?: number;
  readonly misfireGraceMs?: number;
  readonly now?: () => number;
  /** Content-free transition hook for destructive-action quiet-period fencing. */
  readonly onActivityTransition?: () => void;
  readonly executePreRunHook?: (input: SchedulePreRunHookInput) => Promise<SchedulePreRunHookResult>;
  readonly validatePreRunHookBinding?: typeof validateScheduleHookScriptBinding;
  readonly executeScript?: (input: ScheduleScriptInput) => Promise<ScheduleScriptExecutionResult>;
  readonly scriptBroker?: ScheduleScriptCapabilityBroker;
  readonly maxConcurrentRuns?: number;
  readonly schedulerInstanceId?: string;
  readonly processId?: number;
  readonly onRuntimeStateChange?: (snapshot: SchedulerRuntimeSnapshot) => void;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatLeaseMs?: number;
  readonly runStallMs?: number;
  readonly stallAbortGraceMs?: number;
  readonly staleAbortGraceMs?: number;
  readonly suspendGapMs?: number;
}

export interface ScheduleDispatchResult {
  readonly runId: string;
  readonly sessionId?: string;
  readonly status: "queued" | "success" | "skipped" | "failed" | "aborted";
}

/** Durable peer caller for SessionHost. The deterministic operation ID is the distributed claim. */
export class ScheduleCoordinator {
  readonly #store: OperationalStore;
  readonly #host: SessionHost;
  readonly #tickMs: number;
  readonly #misfireGraceMs: number;
  readonly #now: () => number;
  readonly #onActivityTransition: () => void;
  readonly #executePreRunHook: (input: SchedulePreRunHookInput) => Promise<SchedulePreRunHookResult>;
  readonly #validatePreRunHookBinding: typeof validateScheduleHookScriptBinding;
  readonly #executeScript: (input: ScheduleScriptInput) => Promise<ScheduleScriptExecutionResult>;
  readonly #scriptBroker: ScheduleScriptCapabilityBroker;
  readonly #runtime: SchedulerRuntimeState;
  readonly #recovery: SchedulerOccurrenceRecovery;
  readonly #activeOccurrences = new Map<string, Set<AbortController>>();
  readonly #deletionFences = new Map<string, string>();
  readonly #scheduleIdleWaiters = new Map<string, Set<() => void>>();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #inFlightDispatches = 0;

  constructor(store: OperationalStore, host: SessionHost, options: ScheduleCoordinatorOptions = {}) {
    this.#store = store;
    this.#host = host;
    this.#tickMs = options.tickMs ?? 1_000;
    this.#misfireGraceMs = options.misfireGraceMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#onActivityTransition = options.onActivityTransition ?? (() => undefined);
    this.#executePreRunHook = options.executePreRunHook ?? executeSchedulePreRunHook;
    this.#validatePreRunHookBinding = options.validatePreRunHookBinding ?? validateScheduleHookScriptBinding;
    this.#executeScript = options.executeScript ?? executeScheduleScript;
    this.#scriptBroker = options.scriptBroker ?? new HostScheduleScriptCapabilityBroker(store, host);
    this.#runtime = new SchedulerRuntimeState({
      ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
      ...(options.schedulerInstanceId === undefined ? {} : { instanceId: options.schedulerInstanceId }),
      ...(options.processId === undefined ? {} : { processId: options.processId }),
      now: this.#now,
      ...(options.onRuntimeStateChange === undefined ? {} : { onChange: options.onRuntimeStateChange })
    });
    this.#recovery = new SchedulerOccurrenceRecovery(store, this.#runtime, {
      now: this.#now,
      ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
      ...(options.heartbeatLeaseMs === undefined ? {} : { heartbeatLeaseMs: options.heartbeatLeaseMs }),
      ...(options.runStallMs === undefined ? {} : { runStallMs: options.runStallMs }),
      ...(options.stallAbortGraceMs === undefined ? {} : { stallAbortGraceMs: options.stallAbortGraceMs }),
      ...(options.staleAbortGraceMs === undefined ? {} : { staleAbortGraceMs: options.staleAbortGraceMs }),
      ...(options.suspendGapMs === undefined ? {} : { suspendGapMs: options.suspendGapMs }),
      onAbortStale: (occurrence) => this.abortStaleOccurrence(occurrence),
      onForceRelease: (occurrence, reason, noProgressMs) => {
        this.recordForceReleasedOccurrence(occurrence, reason, noProgressMs);
      },
      onError: () => this.recordRecoveryFailure()
    });
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#recovery.start();
    this.reconcileInterruptedScripts();
    void this.#host.reconcileScheduledWorktrees?.();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#recovery.stop();
    for (const controllers of this.#activeOccurrences.values()) {
      for (const controller of controllers) controller.abort();
    }
    this.#runtime.clear();
  }

  /** Pause/delete control path. Pre-run and script processes are interrupted
   * immediately; already-admitted product Runs are aborted through SessionHost. */
  async abortSchedule(
    scheduleId: string,
    linkedOccurrences: readonly { readonly runId: string; readonly sessionId?: string }[] =
      listAllScheduleRuns(this.#store, scheduleId)
  ): Promise<void> {
    for (const controller of this.#activeOccurrences.get(scheduleId) ?? []) controller.abort();
    for (const occurrence of linkedOccurrences) {
      if (occurrence.sessionId === undefined) continue;
      const run = this.#store.findRun(occurrence.runId);
      if (
        run === undefined || run.descriptor.sessionId !== occurrence.sessionId ||
        !activeScheduleRunState(run.descriptor.state)
      ) continue;
      const queueItem = this.#store.findQueueItemByRunId(occurrence.sessionId, occurrence.runId);
      if (queueItem?.state === "accepted") {
        this.#store.cancelQueueItem({
          queueItemId: queueItem.id,
          traceId: `schedule:${scheduleId}:cancelled`
        });
      } else {
        await this.#host.abort(occurrence.sessionId, occurrence.runId).catch(() => undefined);
      }
    }
  }

  /** Fence new dispatch synchronously, cancel current occurrences, and wait
   * through the pre-Session resolution window before deletion can snapshot. */
  async beginScheduleDeletion(
    scheduleId: string,
    ownerId: string,
    linkedOccurrences: readonly { readonly runId: string; readonly sessionId?: string }[] =
      listAllScheduleRuns(this.#store, scheduleId)
  ): Promise<readonly string[]> {
    const currentOwner = this.#deletionFences.get(scheduleId);
    if (currentOwner !== undefined && currentOwner !== ownerId) {
      throw new Error("Another Schedule deletion is already in progress.");
    }
    const occurrenceRunIds = this.#store.listScheduleRuntimeOccurrences({ scheduleId, limit: 10_000 })
      .map((occurrence) => occurrence.runId);
    this.#deletionFences.set(scheduleId, ownerId);
    await this.abortSchedule(scheduleId, linkedOccurrences);
    await this.waitForScheduleIdle(scheduleId);
    return occurrenceRunIds;
  }

  /** Only used when deletion failed before any durable manifest was written. */
  releaseScheduleDeletion(scheduleId: string, ownerId: string): void {
    if (this.#deletionFences.get(scheduleId) === ownerId) this.#deletionFences.delete(scheduleId);
  }

  isScheduleDeletionFenced(scheduleId: string): boolean {
    return this.#deletionFences.has(scheduleId);
  }

  /** Includes the pre-Session/pre-Run window once an occurrence starts resolving. */
  hasInFlightActivity(): boolean {
    // `#ticking` also covers the ordinary empty due-schedule scan. Counting it
    // would make an otherwise idle Orchestrator report a short false-positive busy
    // window every tick. `dispatchOccurrence()` increments synchronously
    // before its first await, so this counter still closes the entire real
    // occurrence window, including session resolution before a Run exists.
    return this.#inFlightDispatches > 0;
  }

  runtimeSnapshot(): SchedulerRuntimeSnapshot {
    return this.#runtime.snapshot();
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      void this.#host.reconcileScheduledWorktrees?.();
      const waiting: Array<{ readonly scheduleId: string; readonly scheduleName: string; readonly waitingSince: number }> = [];
      const dispatches: Promise<void>[] = [];
      for (const schedule of this.#store.listDueSchedules(this.#now(), 100)) {
        if (!this.#runtime.hasCapacity()) {
          waiting.push({
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            waitingSince: schedule.nextRunAt ?? this.#now()
          });
          continue;
        }
        dispatches.push(this.dispatchOccurrence(schedule, { source: "automatic" })
          .then(() => undefined)
          .catch((error: unknown) => this.recordFailure(schedule, error)));
      }
      this.#runtime.syncWaiting(waiting);
      await Promise.all(dispatches);
    } finally {
      this.#ticking = false;
    }
  }

  async runNow(scheduleId: string, operationId: string = randomUUID()): Promise<void> {
    await this.runNowWithResult(scheduleId, operationId);
  }

  async runNowWithResult(
    scheduleId: string,
    operationId: string = randomUUID()
  ): Promise<ScheduleDispatchResult> {
    const schedule = this.#store.getSchedule(scheduleId);
    return this.dispatchOccurrence(schedule, {
      scheduledAt: this.#now(),
      operationId: `manual-schedule-${operationId}`,
      preserveNextRun: true,
      ignoreMisfire: true,
      source: "run-now"
    });
  }

  private async dispatchOccurrence(
    schedule: ScheduleRecord,
    options: {
      readonly scheduledAt?: number;
      readonly operationId?: string;
      readonly preserveNextRun?: boolean;
      readonly ignoreMisfire?: boolean;
      readonly source?: "automatic" | "run-now";
    } = {}
  ): Promise<ScheduleDispatchResult> {
    if (this.#deletionFences.has(schedule.id)) {
      throw new Error("Schedule deletion is in progress.");
    }
    const scheduledAt = options.scheduledAt ?? schedule.nextRunAt ?? this.#now();
    const operationId = options.operationId ?? occurrenceOperationId(schedule.id, scheduledAt);
    const runtimeRunId = scheduledRunId(operationId);
    let executionMode: "agent" | "script" | undefined;
    try {
      executionMode = scheduleExtensionSnapshot(schedule.executionSnapshot).executionMode;
    } catch {
      executionMode = undefined;
    }
    const controller = new AbortController();
    this.#recovery.begin({
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      runId: runtimeRunId,
      source: options.source ?? "automatic",
      ...(executionMode === undefined ? {} : { executionMode }),
      scheduledAt,
      phase: "loading",
      abort: () => controller.abort()
    });
    let controllers = this.#activeOccurrences.get(schedule.id);
    if (controllers === undefined) {
      controllers = new Set();
      this.#activeOccurrences.set(schedule.id, controllers);
    }
    controllers.add(controller);
    this.#inFlightDispatches += 1;
    this.#notifyActivityTransition();
    try {
      const work = this.dispatchOccurrenceTracked(schedule, {
        ...options,
        scheduledAt,
        operationId
      }, controller.signal);
      const result = await this.#recovery.race(runtimeRunId, work);
      return result.forceReleased
        ? { runId: runtimeRunId, status: "failed" }
        : result.value;
    } finally {
      try {
        this.#recovery.transition(runtimeRunId, "finalizing");
      } catch {
        // A generation-fenced recovery already owns terminal persistence.
      }
      controllers.delete(controller);
      if (controllers.size === 0) {
        this.#activeOccurrences.delete(schedule.id);
        for (const resolveIdle of this.#scheduleIdleWaiters.get(schedule.id) ?? []) resolveIdle();
        this.#scheduleIdleWaiters.delete(schedule.id);
      }
      this.#inFlightDispatches -= 1;
      this.#notifyActivityTransition();
      try {
        this.#recovery.finish(runtimeRunId);
      } catch {
        // A newer owner can fence this late settle after restart recovery.
        this.#runtime.finish(runtimeRunId);
      }
      void this.#host.reconcileScheduledWorktrees?.();
    }
  }

  private waitForScheduleIdle(scheduleId: string): Promise<void> {
    if ((this.#activeOccurrences.get(scheduleId)?.size ?? 0) === 0) return Promise.resolve();
    return new Promise((resolveIdle) => {
      let waiters = this.#scheduleIdleWaiters.get(scheduleId);
      if (waiters === undefined) {
        waiters = new Set();
        this.#scheduleIdleWaiters.set(scheduleId, waiters);
      }
      waiters.add(resolveIdle);
    });
  }

  #notifyActivityTransition(): void {
    try {
      this.#onActivityTransition();
    } catch {
      // Observability must not change durable schedule dispatch semantics.
    }
  }

  private async dispatchOccurrenceTracked(
    schedule: ScheduleRecord,
    options: {
      readonly scheduledAt?: number;
      readonly operationId?: string;
      readonly preserveNextRun?: boolean;
      readonly ignoreMisfire?: boolean;
      readonly source?: "automatic" | "run-now";
    },
    signal: AbortSignal
  ): Promise<ScheduleDispatchResult> {
    const scheduledAt = options.scheduledAt ?? schedule.nextRunAt ?? this.#now();
    const operationId = options.operationId ?? occurrenceOperationId(schedule.id, scheduledAt);
    const now = this.#now();
    const runId = scheduledRunId(operationId);
    this.#recovery.transition(runId, "claiming");
    const misfired = options.ignoreMisfire !== true && now - scheduledAt > this.#misfireGraceMs;
    let extension: ReturnType<typeof scheduleExtensionSnapshot>;
    let worktree: ScheduleWorktreeConfiguration;
    try {
      extension = scheduleExtensionSnapshot(schedule.executionSnapshot);
      worktree = scheduleWorktreeConfiguration(schedule.executionSnapshot);
    } catch {
      const invalidNextRunAt = options.preserveNextRun === true
        ? schedule.nextRunAt
        : nextScheduleOccurrenceOrUndefined(schedule, misfired ? now : scheduledAt);
      this.recordPreSessionOutcome({
        schedule,
        operationId,
        runId,
        scheduledAt,
        ...(invalidNextRunAt === undefined ? {} : { nextRunAt: invalidNextRunAt }),
        status: "failed",
        detail: { reason: "Schedule extensions are invalid." }
      });
      return { runId, status: "failed" };
    }
    if (worktree.useWorktree && (
      extension.executionMode !== "agent" || schedule.sessionMode !== "fresh" || schedule.sessionId !== undefined
    )) {
      const incompatibleNextRunAt = options.preserveNextRun === true
        ? schedule.nextRunAt
        : nextScheduleOccurrenceOrUndefined(schedule, misfired ? now : scheduledAt);
      this.recordPreSessionOutcome({
        schedule,
        operationId,
        runId,
        scheduledAt,
        ...(incompatibleNextRunAt === undefined ? {} : { nextRunAt: incompatibleNextRunAt }),
        status: "failed",
        detail: { reason: "Isolated workspace Schedules require agent execution with a fresh task for every run." }
      });
      return { runId, status: "failed" };
    }
    if (worktree.useWorktree && this.#store.getTarget(schedule.targetId).descriptor.managed) {
      const incompatibleNextRunAt = options.preserveNextRun === true
        ? schedule.nextRunAt
        : nextScheduleOccurrenceOrUndefined(schedule, misfired ? now : scheduledAt);
      this.recordPreSessionOutcome({
        schedule,
        operationId,
        runId,
        scheduledAt,
        ...(incompatibleNextRunAt === undefined ? {} : { nextRunAt: incompatibleNextRunAt }),
        status: "failed",
        detail: { reason: "Isolated workspace Schedules require a user project Target." }
      });
      return { runId, status: "failed" };
    }
    if (extension.expireAt !== undefined && now >= extension.expireAt) {
      this.expireSchedule(schedule, now);
      throw new Error("Schedule has expired and cannot be triggered.");
    }
    const nextRunAt = options.preserveNextRun === true
      ? schedule.nextRunAt
      : nextScheduleOccurrence(schedule, misfired ? now : scheduledAt);
    if (misfired && schedule.misfirePolicy === "skip") {
      this.recordPreSessionOutcome({
        schedule,
        operationId,
        runId,
        scheduledAt,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        status: "skipped",
        detail: { reason: "misfire grace elapsed; misfire policy is skip" }
      });
      return { runId, status: "skipped" };
    }

    const preRunRevision = schedule.revision;
    this.#recovery.transition(runId, "running", { executionMode: extension.executionMode });
    const preRun = await this.evaluatePreRunHook(schedule, runId, scheduledAt, extension.preRunHook, signal);
    if (this.#recovery.wasForceReleased(runId)) return { runId, status: "failed" };
    if (preRun !== undefined) {
      const current = this.#store.findSchedule(schedule.id);
      if (current === undefined) return { runId, status: "aborted" };
      if (current.revision !== preRunRevision) {
        this.recordPreSessionOutcome({
          schedule: current,
          operationId,
          runId,
          scheduledAt,
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
          status: "aborted",
          detail: { preRunHook: preRun.detail.preRunHook, reason: "Schedule changed during its pre-run gate." }
        });
        return { runId, status: "aborted" };
      }
      if (preRun.result.decision !== "run") {
        const status = preRun.result.aborted || signal.aborted
          ? "aborted"
          : preRun.result.decision === "skip" ? "skipped" : "failed";
        this.recordPreSessionOutcome({
          schedule: current,
          operationId,
          runId,
          scheduledAt,
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
          status,
          detail: preRun.detail
        });
        return { runId, status };
      }
      this.#store.recordScheduleOccurrence({
        scheduleId: schedule.id,
        runId,
        firedAt: scheduledAt,
        status: "preflight_passed",
        detail: preRun.detail
      });
      schedule = this.#store.getSchedule(schedule.id);
    }
    if (signal.aborted) {
      const current = this.#store.findSchedule(schedule.id);
      if (current === undefined) return { runId, status: "aborted" };
      this.recordPreSessionOutcome({
        schedule: current,
        operationId,
        runId,
        scheduledAt,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        status: "aborted",
        detail: { reason: "Schedule execution was cancelled before task admission." }
      });
      return { runId, status: "aborted" };
    }
    if (extension.executionMode === "script") {
      return this.executeScriptOccurrence({
        schedule,
        extension,
        operationId,
        runId,
        scheduledAt,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        signal,
        ...(preRun === undefined ? {} : { preRunDetail: preRun.detail })
      });
    }
    const resolved = await this.resolveSession(schedule, operationId, runId, worktree);
    if (this.#recovery.wasForceReleased(runId)) return { runId, status: "failed" };
    schedule = resolved.schedule;
    const sessionId = resolved.sessionId;
    if (signal.aborted || this.#deletionFences.has(schedule.id)) {
      const current = this.#store.findSchedule(schedule.id);
      if (current !== undefined) {
        this.recordPreSessionOutcome({
          schedule: current,
          operationId,
          runId,
          scheduledAt,
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
          status: "aborted",
          detail: {
            ...(preRun?.detail ?? {}),
            reason: "Schedule execution was cancelled before task admission.",
            costAttribution: "zero"
          }
        });
      }
      return { runId, sessionId, status: "aborted" };
    }

    const busy = this.#store.listRuns({ sessionId, activeOnly: true }).length > 0;
    const skipForOverlap = busy && schedule.overlapPolicy === "skip";
    if (skipForOverlap) {
      const skipped = this.#host.skipScheduledOccurrence({
        operationId,
        schedule,
        sessionId,
        scheduledAt,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        reason: "task is busy; overlap policy is skip"
      });
      return { runId: skipped.value.runId, sessionId, status: "skipped" };
    }
    const queued = this.#host.enqueueScheduledInput({
      operationId,
      schedule,
      sessionId,
      scheduledAt,
      ...(nextRunAt === undefined ? {} : { nextRunAt })
    });
    this.#recovery.transition(runId, "queued");
    return { runId: queued.value.runId, sessionId, status: "queued" };
  }

  private async evaluatePreRunHook(
    schedule: ScheduleRecord,
    runId: string,
    scheduledAt: number,
    hook: ReturnType<typeof scheduleExtensionSnapshot>["preRunHook"],
    signal: AbortSignal
  ): Promise<{ readonly result: SchedulePreRunHookResult; readonly detail: Readonly<Record<string, unknown>> } | undefined> {
    if (hook === undefined) return undefined;
    const target = this.#store.getTarget(schedule.targetId).descriptor;
    let result: SchedulePreRunHookResult;
    try {
      if (!target.trusted) throw new Error("The schedule workspace is not trusted.");
      await this.#validatePreRunHookBinding({
        workspaceRoot: target.workspaceRoot,
        filePath: hook.filePath,
        command: hook.command
      });
      const previous = findLatestFinishedScheduleRun(this.#store, schedule.id);
      result = await this.#executePreRunHook({
        command: hook.command,
        ...(hook.timeoutMs === undefined ? {} : { timeoutMs: hook.timeoutMs }),
        cwd: target.workspaceRoot,
        signal,
        stdinPayload: {
          event: "schedule-pre-run",
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          runId,
          firedAt: scheduledAt,
          workingDir: target.workspaceRoot,
          ...(previous?.finishedAt === undefined ? {} : { lastFinishedAt: previous.finishedAt })
        }
      });
    } catch (error) {
      result = failedPreRunHookResult(error);
    }
    const durable = durableSchedulePreRunHookResult(result);
    const summary = result.decision === "skip"
      ? schedulePreRunSkipSummary(result)
      : result.decision === "block"
        ? schedulePreRunFailureSummary(result)
        : undefined;
    return {
      result,
      detail: {
        preRunHook: durable,
        ...(summary === undefined ? {} : { reason: redactSecrets(summary).slice(0, 2_048) }),
        ...(result.decision === "skip" ? { costAttribution: "zero" } : {})
      }
    };
  }

  private recordPreSessionOutcome(input: {
    readonly schedule: ScheduleRecord;
    readonly operationId: string;
    readonly runId: string;
    readonly scheduledAt: number;
    readonly nextRunAt?: number;
    readonly status: "skipped" | "failed" | "aborted" | "interrupted";
    readonly detail: unknown;
  }): void {
    const finishedAt = Math.max(input.scheduledAt, this.#now());
    this.#store.runOperation(
      {
        id: `${input.operationId}-outcome`,
        kind: "schedule_preflight_outcome",
        body: {
          scheduleId: input.schedule.id,
          scheduleRevision: input.schedule.revision.toString(10),
          runId: input.runId,
          scheduledAt: input.scheduledAt,
          status: input.status
        }
      },
      (store) => {
        advanceScheduleWithoutSession(store, input.schedule, input.scheduledAt, input.nextRunAt, finishedAt);
        store.recordScheduleOccurrence({
          scheduleId: input.schedule.id,
          runId: input.runId,
          firedAt: input.scheduledAt,
          finishedAt,
          status: input.status,
          detail: input.detail
        });
        return { runId: input.runId, status: input.status };
      }
    );
  }

  private async executeScriptOccurrence(input: {
    readonly schedule: ScheduleRecord;
    readonly extension: ReturnType<typeof scheduleExtensionSnapshot>;
    readonly operationId: string;
    readonly runId: string;
    readonly scheduledAt: number;
    readonly nextRunAt?: number;
    readonly signal: AbortSignal;
    readonly preRunDetail?: Readonly<Record<string, unknown>>;
  }): Promise<ScheduleDispatchResult> {
    const config = input.extension.scriptConfig;
    if (
      config === undefined || input.extension.silentWhenIdle ||
      input.schedule.sessionMode !== "fresh" || input.schedule.sessionId !== undefined
    ) {
      this.recordPreSessionOutcome({
        schedule: input.schedule,
        operationId: input.operationId,
        runId: input.runId,
        scheduledAt: input.scheduledAt,
        ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt }),
        status: "failed",
        detail: { reason: "Stored script Schedule configuration is invalid.", costAttribution: "zero" }
      });
      return { runId: input.runId, status: "failed" };
    }
    this.#store.recordScheduleOccurrence({
      scheduleId: input.schedule.id,
      runId: input.runId,
      firedAt: input.scheduledAt,
      status: "running",
      detail: {
        ...(input.preRunDetail ?? {}),
        script: { status: "running" },
        costAttribution: "zero",
        cadence: {
          preserveNextRun: input.nextRunAt === input.schedule.nextRunAt,
          ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt })
        }
      }
    });
    const runningSchedule = this.#store.getSchedule(input.schedule.id);
    const target = this.#store.getTarget(runningSchedule.targetId).descriptor;
    try {
      if (!target.trusted) throw new Error("The Schedule workspace is not trusted.");
      const result = await this.#executeScript({
        command: config.command,
        cwd: target.workspaceRoot,
        scheduleId: runningSchedule.id,
        scheduleName: runningSchedule.name,
        runId: input.runId,
        firedAt: input.scheduledAt,
        capabilities: config.capabilities,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        signal: input.signal,
        broker: this.#scriptBroker
      });
      const sessionId = this.validScriptPrimarySession(runningSchedule, result.primarySessionId);
      const detail = {
        ...(input.preRunDetail ?? {}),
        script: durableScriptResult(result),
        costAttribution: "zero"
      };
      this.recordScriptSuccess({
        schedule: this.#store.getSchedule(runningSchedule.id),
        operationId: input.operationId,
        runId: input.runId,
        scheduledAt: input.scheduledAt,
        ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt }),
        ...(sessionId === undefined ? {} : { sessionId }),
        detail
      });
      return { runId: input.runId, ...(sessionId === undefined ? {} : { sessionId }), status: "success" };
    } catch (error) {
      const status = input.signal.aborted ? "aborted" : "failed";
      const current = this.#store.findSchedule(runningSchedule.id);
      if (current !== undefined) {
        this.recordPreSessionOutcome({
          schedule: current,
          operationId: input.operationId,
          runId: input.runId,
          scheduledAt: input.scheduledAt,
          ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt }),
          status,
          detail: {
            ...(input.preRunDetail ?? {}),
            script: { status, error: safeScheduleError(error) },
            costAttribution: "zero"
          }
        });
      }
      return { runId: input.runId, status };
    }
  }

  private recordScriptSuccess(input: {
    readonly schedule: ScheduleRecord;
    readonly operationId: string;
    readonly runId: string;
    readonly sessionId?: string;
    readonly scheduledAt: number;
    readonly nextRunAt?: number;
    readonly detail: unknown;
  }): void {
    const finishedAt = Math.max(input.scheduledAt, this.#now());
    this.#store.runOperation(
      {
        id: `${input.operationId}-outcome`,
        kind: "schedule_script_outcome",
        body: {
          scheduleId: input.schedule.id,
          scheduleRevision: input.schedule.revision.toString(10),
          runId: input.runId,
          scheduledAt: input.scheduledAt,
          status: "success"
        }
      },
      (store) => {
        advanceScheduleWithoutSession(store, input.schedule, input.scheduledAt, input.nextRunAt, finishedAt);
        store.recordScheduleOccurrence({
          scheduleId: input.schedule.id,
          runId: input.runId,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          firedAt: input.scheduledAt,
          finishedAt,
          status: "success",
          detail: input.detail
        });
        return { runId: input.runId, status: "success" };
      }
    );
  }

  private validScriptPrimarySession(schedule: ScheduleRecord, sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) return undefined;
    let session: SessionDescriptor | undefined;
    try {
      session = this.#store.getSession(sessionId).descriptor;
    } catch {
      session = undefined;
    }
    return session !== undefined && session.deletedAt === undefined && !session.archived &&
      session.backendId === schedule.backendId && session.targetId === schedule.targetId
      ? session.id
      : undefined;
  }

  private async abortStaleOccurrence(occurrence: ScheduleRuntimeOccurrenceRecord): Promise<void> {
    const history = this.#store.findScheduleRunByRunId(occurrence.runId);
    // A queued/terminal history row proves admission committed before the
    // previous process disappeared. The runtime lease can be reclaimed, but
    // the independently progressing product Run must not be aborted.
    if (history !== undefined && !isRecoverableScheduleRuntimeStatus(history.status)) return;
    await this.abortSchedule(occurrence.scheduleId, [{
      runId: occurrence.runId,
      ...(history?.sessionId === undefined ? {} : { sessionId: history.sessionId })
    }]);
  }

  private recordForceReleasedOccurrence(
    occurrence: ScheduleRuntimeOccurrenceRecord,
    reason: ScheduleOccurrenceReleaseReason,
    noProgressMs: number
  ): void {
    const schedule = this.#store.findSchedule(occurrence.scheduleId);
    if (schedule === undefined) return;
    const history = this.#store.findScheduleRunByRunId(occurrence.runId);
    if (history !== undefined && !isRecoverableScheduleRuntimeStatus(history.status)) return;
    const now = this.#now();
    const nextRunAt = occurrence.source === "run-now"
      ? schedule.nextRunAt
      : nextScheduleOccurrenceOrUndefined(schedule, Math.max(now, occurrence.scheduledAt));
    const status = reason === "stalled" ? "failed" : "interrupted";
    const message = reason === "stalled"
      ? "Schedule dispatch stopped after making no progress and ignoring cancellation."
      : "Schedule dispatch owner stopped renewing its durable lease.";
    const previousDetail = isRecord(history?.detail) ? history.detail : {};
    const previousScript = isRecord(previousDetail["script"]) ? previousDetail["script"] : undefined;
    this.recordPreSessionOutcome({
      schedule,
      operationId: `schedule-runtime-recovery-${occurrence.runId}-${occurrence.ownerGeneration}`,
      runId: occurrence.runId,
      scheduledAt: occurrence.scheduledAt,
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
      status,
      detail: {
        ...previousDetail,
        ...(previousScript === undefined
          ? {}
          : { script: { ...previousScript, status, error: message } }),
        reason: message,
        runtimeRecovery: {
          reason: reason === "stalled" ? "stalled" : "stale_owner",
          noProgressMs: Math.max(0, Math.floor(noProgressMs)),
          ownerGeneration: occurrence.ownerGeneration
        }
      }
    });
    void this.#host.reconcileScheduledWorktrees?.();
  }

  private recordRecoveryFailure(): void {
    try {
      this.#store.appendDiagnostic({
        id: `schedule-recovery-${randomUUID()}`,
        severity: "error",
        component: "scheduler",
        code: "SCHEDULE_RUNTIME_RECOVERY_FAILED",
        message: "The scheduler could not complete a durable runtime recovery step.",
        details: {}
      });
    } catch {
      // A storage failure cannot be diagnosed through the same failed store.
    }
  }

  private reconcileInterruptedScripts(): void {
    for (const schedule of this.#store.listSchedules()) {
      const interrupted = listAllScheduleRuns(this.#store, schedule.id)
        .filter((run) => run.status === "running" && isRunningScriptDetail(run.detail))
        .filter((run) => this.#store.findScheduleRuntimeOccurrence(run.runId) === undefined)
        .sort((left, right) => left.firedAt - right.firedAt);
      for (const occurrence of interrupted) {
        const current = this.#store.findSchedule(schedule.id);
        if (current === undefined) break;
        const detail = isRecord(occurrence.detail) ? occurrence.detail : {};
        const cadence = isRecord(detail["cadence"]) ? detail["cadence"] : {};
        const preserveNextRun = cadence["preserveNextRun"] === true;
        const storedNextRunAt = Number.isSafeInteger(cadence["nextRunAt"])
          ? cadence["nextRunAt"] as number
          : undefined;
        const nextRunAt = preserveNextRun
          ? current.nextRunAt
          : storedNextRunAt ?? nextScheduleOccurrenceOrUndefined(current, occurrence.firedAt);
        this.recordPreSessionOutcome({
          schedule: current,
          operationId: `schedule-script-recovery-${occurrence.runId}`,
          runId: occurrence.runId,
          scheduledAt: occurrence.firedAt,
          ...(nextRunAt === undefined ? {} : { nextRunAt }),
          status: "interrupted",
          detail: {
            ...detail,
            script: {
              status: "interrupted",
              error: "Service restarted before script completion was confirmed."
            },
            costAttribution: "zero"
          }
        });
      }
    }
  }

  private expireSchedule(schedule: ScheduleRecord, now: number): void {
    const current = this.#store.getSchedule(schedule.id);
    if (!current.enabled) return;
    this.#store.upsertSchedule(copyScheduleForCoordinator(current, {
      enabled: false,
      expectedRevision: current.revision,
      now
    }));
  }

  private async resolveSession(
    schedule: ScheduleRecord,
    operationId: string,
    runId: string,
    worktree: ScheduleWorktreeConfiguration
  ): Promise<{ readonly schedule: ScheduleRecord; readonly sessionId: string }> {
    if (schedule.sessionMode === "bound") {
      return { schedule, sessionId: this.requireUsableSession(schedule, schedule.sessionId) };
    }
    if (schedule.sessionMode === "persistent" && schedule.sessionId !== undefined) {
      const existing = this.#store.getSession(schedule.sessionId);
      if (
        existing.descriptor.deletedAt === undefined &&
        !existing.descriptor.archived &&
        existing.descriptor.backendId === schedule.backendId &&
        existing.descriptor.targetId === schedule.targetId
      ) {
        return { schedule, sessionId: existing.descriptor.id };
      }
    }

    const execution = scheduleCreationSnapshot(schedule.executionSnapshot);
    const created = await this.#host.createScheduledSession({
      operationId: `${operationId}-session`,
      targetId: schedule.targetId,
      title: schedule.name,
      automationOrigin: { scheduleId: schedule.id, scheduleName: schedule.name, runId, scheduleRevision: schedule.revision },
      ...(execution.providerId === undefined ? {} : { providerId: execution.providerId }),
      ...(execution.modelId === undefined ? {} : { modelId: execution.modelId }),
      ...(execution.effort === undefined ? {} : { effort: execution.effort }),
      fastMode: execution.fastMode,
      permissionMode: execution.permissionMode,
      planMode: execution.planMode,
      ...(worktree.useWorktree ? {
        worktree: {
          ...(worktree.sourceRef === undefined ? {} : { sourceRef: worktree.sourceRef }),
          refreshRemote: worktree.refreshRemote
        },
        worktreeOwner: { scheduleId: schedule.id, runId }
      } : {})
    });
    const sessionId = created.value.sessionId;
    if (schedule.sessionMode === "fresh") return { schedule, sessionId };

    // Persist the generated Session before the prompt is queued. If an edit
    // raced creation, fail closed instead of binding a Session created from a
    // stale execution snapshot.
    const current = this.#store.getSchedule(schedule.id);
    if (current.revision !== schedule.revision || current.sessionMode !== "persistent") {
      throw new Error("Schedule changed while its persistent task was being created.");
    }
    const bound = this.#store.bindPersistentScheduleSession(
      schedule.id,
      sessionId,
      schedule.revision,
      this.#now()
    );
    return { schedule: bound, sessionId };
  }

  private requireUsableSession(schedule: ScheduleRecord, sessionId: string | undefined): string {
    if (sessionId === undefined) throw new Error("Bound Schedule has no product task.");
    const session = this.#store.getSession(sessionId);
    if (session.descriptor.deletedAt !== undefined || session.descriptor.archived) {
      throw new Error("The task bound to this Schedule is archived or deleted.");
    }
    if (
      session.descriptor.backendId !== schedule.backendId ||
      session.descriptor.targetId !== schedule.targetId
    ) {
      throw new Error("The task bound to this Schedule no longer matches its routing.");
    }
    return sessionId;
  }

  private recordFailure(schedule: ScheduleRecord, error: unknown): void {
    this.#store.appendDiagnostic({
      id: `schedule-${schedule.id}-${randomUUID()}`,
      severity: "error",
      component: "scheduler",
      code: "SCHEDULE_DISPATCH_FAILED",
      message: error instanceof Error ? error.message : "Schedule dispatch failed.",
      details: { scheduleId: schedule.id }
    });
  }
}

function nextScheduleOccurrence(schedule: ScheduleRecord, after: number): number | undefined {
  let timing: ScheduleTiming;
  switch (schedule.kind) {
    case "manual": timing = { kind: "manual" }; break;
    case "one_shot": timing = { kind: "once", at: schedule.nextRunAt ?? after }; break;
    case "interval": {
      const everyMs = Number(schedule.expression);
      if (!Number.isSafeInteger(everyMs) || everyMs < 1_000) throw new Error("Schedule interval is invalid.");
      if (schedule.anchorAt === undefined) throw new Error("Interval schedule has no durable anchor.");
      timing = { kind: "interval", everyMs, anchorAt: schedule.anchorAt };
      break;
    }
    case "cron":
      if (schedule.expression === undefined) throw new Error("Cron schedule has no expression.");
      timing = { kind: "cron", expression: schedule.expression, timezone: schedule.timezone };
      break;
  }
  return nextOccurrence(timing, after);
}

function occurrenceOperationId(scheduleId: string, scheduledAt: number): string {
  return `schedule-${createHash("sha256").update(`${scheduleId}\0${scheduledAt}`).digest("hex").slice(0, 32)}`;
}

function nextScheduleOccurrenceOrUndefined(schedule: ScheduleRecord, after: number): number | undefined {
  try {
    return nextScheduleOccurrence(schedule, after);
  } catch {
    return undefined;
  }
}

function scheduledRunId(operationId: string): string {
  return `run-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
}

function failedPreRunHookResult(error: unknown): SchedulePreRunHookResult {
  const message = redactSecrets(error instanceof Error ? error.message : "Pre-run hook validation failed.")
    .slice(0, 2_048);
  return {
    status: "failed",
    decision: "block",
    exitCode: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    error: message
  };
}

function durableScriptResult(result: ScheduleScriptExecutionResult): Readonly<Record<string, unknown>> {
  const resultText = result.resultText === undefined
    ? undefined
    : redactSecrets(result.resultText);
  return {
    status: "completed",
    durationMs: Math.max(0, Math.floor(result.durationMs)),
    stderrTruncated: result.stderrTruncated,
    ...(resultText === undefined || resultText === "" ? {} : { resultText })
  };
}

function safeScheduleError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : "Schedule script execution failed.")
    .slice(0, 2_048);
}

function isRunningScriptDetail(value: unknown): boolean {
  return isRecord(value) && isRecord(value["script"]) && value["script"]["status"] === "running";
}

function listAllScheduleRuns(
  store: OperationalStore,
  scheduleId: string
): ReturnType<OperationalStore["listScheduleRuns"]> {
  const runs: ReturnType<OperationalStore["listScheduleRuns"]> = [];
  for (;;) {
    const page = store.listScheduleRuns(scheduleId, 10_000, runs.length);
    runs.push(...page);
    if (page.length < 10_000) return runs;
  }
}

function findLatestFinishedScheduleRun(
  store: OperationalStore,
  scheduleId: string
): ReturnType<OperationalStore["listScheduleRuns"]>[number] | undefined {
  let offset = 0;
  for (;;) {
    const page = store.listScheduleRuns(scheduleId, 10_000, offset);
    const finished = page.find((run) => run.finishedAt !== undefined);
    if (finished !== undefined || page.length < 10_000) return finished;
    offset += page.length;
  }
}

function activeScheduleRunState(state: string): boolean {
  return state === "queued" || state === "running" || state === "waiting" ||
    state === "retrying" || state === "dispatch_unknown";
}

function isRecoverableScheduleRuntimeStatus(status: string): boolean {
  return status === "running" || status === "preflight_passed";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function advanceScheduleWithoutSession(
  store: OperationalStore,
  schedule: ScheduleRecord,
  firedAt: number,
  nextRunAt: number | undefined,
  now: number
): void {
  store.upsertSchedule(copyScheduleForCoordinator(schedule, {
    enabled: schedule.kind !== "one_shot" && schedule.enabled,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    lastRunAt: firedAt,
    expectedRevision: schedule.revision,
    now
  }));
}

function copyScheduleForCoordinator(
  schedule: ScheduleRecord,
  patch: {
    readonly enabled: boolean;
    readonly nextRunAt?: number;
    readonly lastRunAt?: number;
    readonly expectedRevision: bigint;
    readonly now: number;
  }
): UpsertScheduleInput {
  return {
    id: schedule.id,
    backendId: schedule.backendId,
    targetId: schedule.targetId,
    sessionMode: schedule.sessionMode,
    ...(schedule.sessionId === undefined ? {} : { sessionId: schedule.sessionId }),
    name: schedule.name,
    kind: schedule.kind,
    ...(schedule.expression === undefined ? {} : { expression: schedule.expression }),
    ...(schedule.anchorAt === undefined ? {} : { anchorAt: schedule.anchorAt }),
    timezone: schedule.timezone,
    enabled: patch.enabled,
    prompt: schedule.prompt,
    executionSnapshot: schedule.executionSnapshot,
    overlapPolicy: schedule.overlapPolicy,
    misfirePolicy: schedule.misfirePolicy,
    ...(patch.nextRunAt === undefined ? {} : { nextRunAt: patch.nextRunAt }),
    ...(patch.lastRunAt === undefined
      ? schedule.lastRunAt === undefined ? {} : { lastRunAt: schedule.lastRunAt }
      : { lastRunAt: patch.lastRunAt }),
    expectedRevision: patch.expectedRevision,
    now: patch.now
  };
}

function scheduleCreationSnapshot(value: unknown): {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
} {
  const record = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const providerId = typeof record["providerId"] === "string" && record["providerId"].length > 0
    ? record["providerId"]
    : undefined;
  const modelId = typeof record["modelId"] === "string" && record["modelId"].length > 0
    ? record["modelId"]
    : undefined;
  const effort = typeof record["effort"] === "string" && record["effort"].length > 0
    ? record["effort"]
    : undefined;
  const permissionMode = record["permissionMode"] === "auto" || record["permissionMode"] === "bypassPermissions"
    ? record["permissionMode"]
    : "ask";
  return {
    ...(providerId === undefined || modelId === undefined ? {} : { providerId, modelId }),
    ...(effort === undefined ? {} : { effort }),
    fastMode: record["fastMode"] === true,
    permissionMode,
    planMode: record["planMode"] === true
  };
}
