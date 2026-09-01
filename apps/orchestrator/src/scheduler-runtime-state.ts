import { randomUUID } from "node:crypto";

export const DEFAULT_SCHEDULE_MAX_CONCURRENT_RUNS = 8;

export type ScheduleFireSource = "automatic" | "run-now";
export type ScheduleRuntimeExecutionMode = "agent" | "script";
export type ScheduleRunPhase =
  | "loading"
  | "claiming"
  | "persisting"
  | "running"
  | "queued"
  | "cancelling"
  | "finalizing"
  | "stalled"
  | "recovering";

export interface SchedulerInflightRun {
  readonly scheduleId: string;
  readonly scheduleName?: string;
  readonly runId: string;
  readonly source: ScheduleFireSource;
  readonly executionMode?: ScheduleRuntimeExecutionMode;
  readonly startedAt: number;
  readonly slotWaitMs?: number;
  readonly phase: ScheduleRunPhase;
  readonly lastProgressAt: number;
}

export interface SchedulerWaitingSchedule {
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly waitingSince: number;
}

export interface SchedulerRuntimeSnapshot {
  readonly schedulerInstanceId: string;
  readonly processId?: number;
  readonly inFlight: number;
  readonly slotsInUse: number;
  readonly maxConcurrentRuns: number;
  readonly inFlightRuns: readonly SchedulerInflightRun[];
  readonly waitingSchedules: readonly SchedulerWaitingSchedule[];
}

export interface SchedulerRuntimeStateOptions {
  readonly instanceId?: string;
  readonly processId?: number;
  readonly maxConcurrentRuns?: number;
  readonly now?: () => number;
  readonly onChange?: (snapshot: SchedulerRuntimeSnapshot) => void;
}

interface MutableInflightRun {
  scheduleId: string;
  scheduleName?: string;
  runId: string;
  source: ScheduleFireSource;
  executionMode?: ScheduleRuntimeExecutionMode;
  startedAt: number;
  slotWaitMs?: number;
  phase: ScheduleRunPhase;
  lastProgressAt: number;
}

/** Process-local scheduler observability. No prompt, command, result, or
 * credential-bearing content is accepted by this state machine. */
export class SchedulerRuntimeState {
  readonly #instanceId: string;
  readonly #processId: number | undefined;
  readonly #maxConcurrentRuns: number;
  readonly #now: () => number;
  readonly #onChange: ((snapshot: SchedulerRuntimeSnapshot) => void) | undefined;
  readonly #inFlight = new Map<string, MutableInflightRun>();
  readonly #waiting = new Map<string, SchedulerWaitingSchedule>();

  constructor(options: SchedulerRuntimeStateOptions = {}) {
    const maximum = options.maxConcurrentRuns ?? DEFAULT_SCHEDULE_MAX_CONCURRENT_RUNS;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
      throw new Error("Schedule concurrency limit must be an integer from 1 through 256.");
    }
    this.#instanceId = nonBlank(options.instanceId ?? randomUUID(), "Scheduler instance ID");
    this.#processId = options.processId;
    this.#maxConcurrentRuns = maximum;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
  }

  begin(input: {
    readonly scheduleId: string;
    readonly scheduleName?: string;
    readonly runId: string;
    readonly source: ScheduleFireSource;
    readonly executionMode?: ScheduleRuntimeExecutionMode;
    readonly scheduledAt?: number;
    readonly startedAt?: number;
    readonly lastProgressAt?: number;
    readonly phase?: ScheduleRunPhase;
  }): void {
    const runId = nonBlank(input.runId, "Schedule run ID");
    if (this.#inFlight.has(runId)) throw new Error("Schedule run is already tracked.");
    const startedAt = runtimeTimestamp(input.startedAt ?? this.#now(), "Schedule start");
    const lastProgressAt = runtimeTimestamp(input.lastProgressAt ?? startedAt, "Schedule progress");
    if (lastProgressAt < startedAt) throw new Error("Schedule progress cannot predate its start.");
    const scheduledAt = input.scheduledAt;
    this.#inFlight.set(runId, {
      scheduleId: nonBlank(input.scheduleId, "Schedule ID"),
      ...(input.scheduleName === undefined ? {} : { scheduleName: boundedName(input.scheduleName) }),
      runId,
      source: input.source,
      ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
      startedAt,
      ...(scheduledAt === undefined ? {} : { slotWaitMs: Math.max(0, startedAt - scheduledAt) }),
      phase: input.phase ?? "loading",
      lastProgressAt
    });
    this.#emit();
  }

  transition(
    runId: string,
    phase: ScheduleRunPhase,
    patch: {
      readonly scheduleName?: string;
      readonly executionMode?: ScheduleRuntimeExecutionMode;
      readonly markProgress?: boolean;
    } = {}
  ): void {
    const current = this.#inFlight.get(runId);
    if (current === undefined) return;
    current.phase = phase;
    if (patch.markProgress !== false) current.lastProgressAt = this.#now();
    if (patch.scheduleName !== undefined) current.scheduleName = boundedName(patch.scheduleName);
    if (patch.executionMode !== undefined) current.executionMode = patch.executionMode;
    this.#emit();
  }

  progress(runId: string): void {
    const current = this.#inFlight.get(runId);
    if (current !== undefined) current.lastProgressAt = this.#now();
  }

  /** Excludes a host suspension from duration/no-progress accounting. */
  absorbClockGap(gapMs: number): void {
    if (!Number.isSafeInteger(gapMs) || gapMs < 0) throw new Error("Schedule clock gap is invalid.");
    if (gapMs === 0) return;
    for (const run of this.#inFlight.values()) {
      run.startedAt += gapMs;
      run.lastProgressAt += gapMs;
    }
  }

  finish(runId: string): void {
    if (!this.#inFlight.delete(runId)) return;
    this.#emit();
  }

  has(runId: string): boolean {
    return this.#inFlight.has(runId);
  }

  find(runId: string): SchedulerInflightRun | undefined {
    const current = this.#inFlight.get(runId);
    return current === undefined ? undefined : { ...current };
  }

  instanceId(): string {
    return this.#instanceId;
  }

  hasCapacity(): boolean {
    return this.slotsInUse() < this.#maxConcurrentRuns;
  }

  slotsInUse(): number {
    let count = 0;
    for (const run of this.#inFlight.values()) {
      if (run.phase !== "queued" && run.phase !== "cancelling" && run.phase !== "stalled") count += 1;
    }
    return count;
  }

  syncWaiting(schedules: readonly SchedulerWaitingSchedule[]): void {
    const next = new Map<string, SchedulerWaitingSchedule>();
    for (const schedule of schedules) {
      const scheduleId = nonBlank(schedule.scheduleId, "Waiting Schedule ID");
      if (!Number.isSafeInteger(schedule.waitingSince) || schedule.waitingSince < 0) {
        throw new Error("Waiting Schedule timestamp is invalid.");
      }
      next.set(scheduleId, {
        scheduleId,
        scheduleName: boundedName(schedule.scheduleName),
        waitingSince: schedule.waitingSince
      });
    }
    if (sameWaiting(this.#waiting, next)) return;
    this.#waiting.clear();
    for (const [id, schedule] of next) this.#waiting.set(id, schedule);
    this.#emit();
  }

  clear(): void {
    if (this.#inFlight.size === 0 && this.#waiting.size === 0) return;
    this.#inFlight.clear();
    this.#waiting.clear();
    this.#emit();
  }

  snapshot(): SchedulerRuntimeSnapshot {
    const inFlightRuns = [...this.#inFlight.values()]
      .sort((left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId))
      .map((run): SchedulerInflightRun => ({ ...run }));
    const waitingSchedules = [...this.#waiting.values()]
      .sort((left, right) => left.waitingSince - right.waitingSince || left.scheduleId.localeCompare(right.scheduleId))
      .map((schedule) => ({ ...schedule }));
    return {
      schedulerInstanceId: this.#instanceId,
      ...(this.#processId === undefined ? {} : { processId: this.#processId }),
      inFlight: inFlightRuns.length,
      slotsInUse: this.slotsInUse(),
      maxConcurrentRuns: this.#maxConcurrentRuns,
      inFlightRuns,
      waitingSchedules
    };
  }

  #emit(): void {
    this.#onChange?.(this.snapshot());
  }
}

function nonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} is required.`);
  return normalized;
}

function boundedName(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 512) throw new Error("Schedule name is invalid.");
  return normalized;
}

function runtimeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} timestamp is invalid.`);
  return value;
}

function sameWaiting(
  left: ReadonlyMap<string, SchedulerWaitingSchedule>,
  right: ReadonlyMap<string, SchedulerWaitingSchedule>
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, value] of right) {
    const existing = left.get(id);
    if (existing?.scheduleName !== value.scheduleName || existing.waitingSince !== value.waitingSince) return false;
  }
  return true;
}
