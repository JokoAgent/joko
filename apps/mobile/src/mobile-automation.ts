import {
  ScheduleExecutionMode,
  ScheduleFireSource,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRunCostAttribution,
  ScheduleRunOutcome,
  ScheduleRunPhase,
  ScheduleSessionMode,
  ScheduleSource,
  ScheduleState,
  type Schedule,
  type SchedulePreRunResult,
  type ScheduleRunHistory,
  type ScheduleRunMoney,
  type SchedulerRuntimeSnapshot
} from "@joko/contracts";
import { mobileInputSummary } from "./mobile-composer-document";

export type MobileAutomationFilter = "all" | "active" | "paused";
export type MobileAutomationScheduleState = "enabled" | "disabled" | "running" | "error" | "deleting";
export type MobileAutomationRunState = "queued" | "running" | "completed" | "skipped" | "aborted" | "interrupted" | "failed";

export interface MobileAutomationMoney {
  readonly amountMicros: bigint;
  readonly currencyCode: "CNY" | "USD";
  readonly approximate: boolean;
  readonly kind: "actual-cost" | "value-estimate";
  readonly estimateReasons: readonly string[];
}

export interface MobileAutomationPreRun {
  readonly status: "passed" | "skipped" | "failed" | "timed_out" | "aborted";
  readonly decision: "run" | "skip" | "block";
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: string;
  readonly error?: string;
}

export interface MobileAutomationRun {
  readonly triggerId: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly state: MobileAutomationRunState;
  readonly scheduledFor: number;
  readonly triggeredAt: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly resultText?: string;
  readonly error?: string;
  readonly zeroCost: boolean;
  readonly costAttribution: "exact" | "direct" | "mixed" | "zero" | "unavailable";
  readonly cost?: MobileAutomationMoney;
  readonly estimatedValue?: MobileAutomationMoney;
  readonly preRun?: MobileAutomationPreRun;
  readonly readAt?: number;
}

export interface MobileAutomationSchedule {
  readonly scheduleId: string;
  readonly displayName: string;
  readonly state: MobileAutomationScheduleState;
  readonly source: "dialogue" | "project";
  readonly backendId: string;
  readonly targetId: string;
  readonly sessionId?: string;
  readonly sessionMode: "fresh" | "persistent" | "bound";
  readonly recurrence: "manual" | "once" | "cron" | "interval";
  readonly recurrenceLabel: string;
  readonly timeZone: string;
  readonly inputText: string;
  readonly executionMode: "agent" | "script";
  readonly overlapPolicy: "queue" | "skip";
  readonly misfirePolicy: "runOnce" | "skip";
  readonly nextTriggerAt?: number;
  readonly lastTriggeredAt?: number;
  readonly projectConfigId?: string;
  readonly projectConfigPath?: string;
  readonly unreadRunCount: number;
  readonly recentRuns: readonly MobileAutomationRun[];
  readonly revision: { readonly value: bigint; readonly etag: string };
  readonly generation: bigint;
  readonly updatedAt?: number;
  readonly error?: string;
}

export interface MobileAutomationGroup {
  readonly kind: "project" | "dialogue";
  readonly schedules: readonly MobileAutomationSchedule[];
}

export interface MobileSchedulerRuntime {
  readonly instanceId: string;
  readonly inFlight: number;
  readonly slotsInUse: number;
  readonly maxConcurrentRuns: number;
  readonly inFlightBySchedule: Readonly<Record<string, number>>;
  readonly waitingBySchedule: Readonly<Record<string, number>>;
}

export interface MobileAutomationsState {
  readonly open: boolean;
  readonly status: "idle" | "loading" | "ready" | "offline" | "error";
  readonly filter: MobileAutomationFilter;
  readonly schedules: readonly MobileAutomationSchedule[];
  readonly selectedScheduleId?: string;
  readonly detail?: MobileAutomationSchedule;
  readonly history: readonly MobileAutomationRun[];
  readonly historyStatus: "idle" | "loading" | "loading-more" | "ready" | "error";
  readonly historyNextPageToken?: string;
  readonly historyTotalSize: number;
  readonly runtime?: MobileSchedulerRuntime;
  readonly lastSyncedAt?: number;
  readonly error?: string;
}

export function emptyMobileAutomationsState(
  open = false,
  status: MobileAutomationsState["status"] = "idle"
): MobileAutomationsState {
  return {
    open,
    status,
    filter: "all",
    schedules: [],
    history: [],
    historyStatus: "idle",
    historyTotalSize: 0
  };
}

export function projectMobileAutomationCatalog(schedules: readonly Schedule[]): readonly MobileAutomationSchedule[] {
  if (schedules.length > 10_000) throw new Error("The Joko node returned an oversized Automation catalog.");
  const projected = schedules.map((schedule) => projectMobileAutomationSchedule(schedule));
  assertUnique(projected.map((schedule) => schedule.scheduleId), "Automation Schedule");
  return sortMobileAutomationSchedules(projected);
}

export function projectMobileAutomationSchedule(
  schedule: Schedule,
  expectedScheduleId?: string
): MobileAutomationSchedule {
  const scheduleId = requiredIdentifier(schedule.scheduleId, "Schedule");
  if (expectedScheduleId !== undefined && scheduleId !== expectedScheduleId) {
    throw new Error("The Joko node returned a different Automation Schedule.");
  }
  const revision = schedule.version?.revision;
  if (!revision || revision.value < 1n || schedule.version!.generation < 0n) {
    throw new Error("The Joko node returned an unfenced Automation Schedule.");
  }
  const displayName = requiredLabel(schedule.displayName, "Schedule name");
  const backendId = requiredIdentifier(schedule.backendId, "Schedule Backend");
  const targetId = requiredIdentifier(schedule.targetId, "Schedule Target");
  const state = scheduleState(schedule.state);
  const source = scheduleSource(schedule.source);
  const sessionMode = scheduleSessionMode(schedule.sessionMode);
  const sessionId = optionalIdentifier(schedule.sessionId, "Schedule Session");
  if (sessionMode === "bound" && sessionId === undefined) {
    throw new Error("The Joko node returned a bound Automation Schedule without a task.");
  }
  const recurrence = scheduleRecurrence(schedule);
  const executionMode = scheduleExecutionMode(schedule.execution?.executionMode);
  const overlapPolicy = scheduleOverlapPolicy(schedule.overlapPolicy);
  const misfirePolicy = scheduleMisfirePolicy(schedule.misfirePolicy);
  const projectConfigId = optionalIdentifier(schedule.projectConfigId, "project Automation configuration");
  const projectConfigPath = optionalLabel(schedule.projectConfigPath, "project Automation path");
  if (source === "project" && (projectConfigId === undefined || projectConfigPath === undefined)) {
    throw new Error("The Joko node returned a project Automation without its configuration identity.");
  }
  if (source === "dialogue" && (projectConfigId !== undefined || projectConfigPath !== undefined)) {
    throw new Error("The Joko node returned project metadata on a dialogue Automation.");
  }
  const recentRuns = schedule.recentRuns.map(projectMobileAutomationRun);
  if (recentRuns.length > 100) throw new Error("The Joko node returned too many recent Automation runs.");
  assertUnique(recentRuns.map((run) => run.triggerId), "Automation run trigger");
  const unreadRunCount = counter(schedule.unreadRunCount, "unread Automation run count");
  const updatedAt = optionalTimestamp(schedule.version!.updatedAt, "Schedule update");
  return {
    scheduleId,
    displayName,
    state,
    source,
    backendId,
    targetId,
    ...(sessionId === undefined ? {} : { sessionId }),
    sessionMode,
    ...recurrence,
    timeZone: optionalLabel(schedule.timeZone, "Schedule time zone") ?? "UTC",
    inputText: mobileInputSummary(schedule.input),
    executionMode,
    overlapPolicy,
    misfirePolicy,
    ...(schedule.nextTriggerAt === undefined ? {} : { nextTriggerAt: requiredTimestamp(schedule.nextTriggerAt, "next trigger") }),
    ...(schedule.lastTriggeredAt === undefined ? {} : { lastTriggeredAt: requiredTimestamp(schedule.lastTriggeredAt, "last trigger") }),
    ...(projectConfigId === undefined ? {} : { projectConfigId }),
    ...(projectConfigPath === undefined ? {} : { projectConfigPath }),
    unreadRunCount,
    recentRuns,
    revision: { value: revision.value, etag: revision.etag },
    generation: schedule.version!.generation,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(schedule.error?.message ? { error: boundedText(schedule.error.message, "Schedule error") } : {})
  };
}

export function projectMobileAutomationHistory(
  scheduleId: string,
  history: readonly ScheduleRunHistory[]
): readonly MobileAutomationRun[] {
  requiredIdentifier(scheduleId, "Schedule");
  if (history.length > 10_000) throw new Error("The Joko node returned an oversized Automation history page.");
  const projected = history.map(projectMobileAutomationRun);
  assertUnique(projected.map((run) => run.triggerId), "Automation run trigger");
  return projected;
}

export function projectMobileAutomationRun(run: ScheduleRunHistory): MobileAutomationRun {
  const triggerId = requiredIdentifier(run.triggerId, "Automation trigger");
  const runId = requiredIdentifier(run.runId, "Automation run");
  assertKnownRunState(run.state);
  const state = scheduleRunOutcome(run.outcome);
  const sessionId = optionalIdentifier(run.sessionId, "Automation run task");
  const scheduledFor = requiredTimestamp(run.scheduledFor, "scheduled run");
  const triggeredAt = requiredTimestamp(run.triggeredAt, "triggered run");
  const terminal = !["queued", "running"].includes(state);
  const finishedAt = optionalTimestamp(run.finishedAt, "finished run");
  if (terminal && finishedAt === undefined) {
    throw new Error("The Joko node returned a terminal Automation run without a finish time.");
  }
  if (!terminal && finishedAt !== undefined) {
    throw new Error("The Joko node returned a running Automation run with a finish time.");
  }
  const durationMs = run.duration === undefined ? undefined : requiredDuration(run.duration, "Automation run");
  const readAt = optionalTimestamp(run.readAt, "Automation run read receipt");
  return {
    triggerId,
    runId,
    ...(sessionId === undefined ? {} : { sessionId }),
    state,
    scheduledFor,
    triggeredAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(run.resultText.length === 0 ? {} : { resultText: boundedText(run.resultText, "Automation result", 131_072) }),
    ...(run.error?.message ? { error: boundedText(run.error.message, "Automation run error") } : {}),
    zeroCost: run.zeroCost,
    costAttribution: scheduleCostAttribution(run.costAttribution),
    ...(run.cost === undefined ? {} : { cost: scheduleMoney(run.cost) }),
    ...(run.estimatedValue === undefined ? {} : { estimatedValue: scheduleMoney(run.estimatedValue) }),
    ...(run.preRun === undefined ? {} : { preRun: schedulePreRun(run.preRun) }),
    ...(readAt === undefined ? {} : { readAt })
  };
}

export function projectMobileSchedulerRuntime(
  runtime: SchedulerRuntimeSnapshot,
  knownScheduleIds: ReadonlySet<string>
): MobileSchedulerRuntime {
  const instanceId = requiredIdentifier(runtime.schedulerInstanceId, "Scheduler instance");
  const inFlight = counter(runtime.inFlight, "Scheduler in-flight count");
  const slotsInUse = counter(runtime.slotsInUse, "Scheduler slot count");
  const maxConcurrentRuns = counter(runtime.maxConcurrentRuns, "Scheduler concurrency");
  if (maxConcurrentRuns < 1 || maxConcurrentRuns > 256 || runtime.inFlightRuns.length > 256
    || runtime.waitingTasks.length > 10_000 || inFlight !== runtime.inFlightRuns.length || slotsInUse > inFlight) {
    throw new Error("The Joko node returned an inconsistent Scheduler runtime.");
  }
  const runIds = new Set<string>();
  const inFlightBySchedule: Record<string, number> = {};
  for (const run of runtime.inFlightRuns) {
    const scheduleId = requiredIdentifier(run.scheduleId, "in-flight Schedule");
    if (!knownScheduleIds.has(scheduleId)) throw new Error("The Scheduler runtime referenced an unknown Schedule.");
    const runId = requiredIdentifier(run.runId, "in-flight run");
    if (runIds.has(runId)) throw new Error("The Scheduler runtime returned a duplicate run.");
    runIds.add(runId);
    scheduleFireSource(run.source);
    scheduleExecutionMode(run.executionMode);
    scheduleRunPhase(run.phase);
    requiredTimestamp(run.startedAt, "Scheduler run start");
    requiredTimestamp(run.lastProgressAt, "Scheduler run progress");
    if (run.slotWait !== undefined) requiredDuration(run.slotWait, "Scheduler slot wait");
    inFlightBySchedule[scheduleId] = (inFlightBySchedule[scheduleId] ?? 0) + 1;
  }
  const waitingBySchedule: Record<string, number> = {};
  for (const task of runtime.waitingTasks) {
    const scheduleId = requiredIdentifier(task.scheduleId, "waiting Schedule");
    if (!knownScheduleIds.has(scheduleId)) throw new Error("The Scheduler runtime referenced an unknown waiting Schedule.");
    requiredTimestamp(task.waitingSince, "Scheduler capacity wait");
    waitingBySchedule[scheduleId] = (waitingBySchedule[scheduleId] ?? 0) + 1;
  }
  return { instanceId, inFlight, slotsInUse, maxConcurrentRuns, inFlightBySchedule, waitingBySchedule };
}

export function filterMobileAutomationSchedules(
  schedules: readonly MobileAutomationSchedule[],
  filter: MobileAutomationFilter
): readonly MobileAutomationSchedule[] {
  if (filter === "all") return schedules;
  if (filter === "paused") return schedules.filter((schedule) => schedule.state === "disabled");
  return schedules.filter((schedule) => schedule.state === "enabled" || schedule.state === "running" || schedule.state === "error");
}

export function groupMobileAutomationSchedules(
  schedules: readonly MobileAutomationSchedule[],
  filter: MobileAutomationFilter
): readonly MobileAutomationGroup[] {
  const visible = sortMobileAutomationSchedules(filterMobileAutomationSchedules(schedules, filter));
  const project = visible.filter((schedule) => schedule.source === "project");
  const dialogue = visible.filter((schedule) => schedule.source === "dialogue");
  return [
    ...(project.length === 0 ? [] : [{ kind: "project" as const, schedules: project }]),
    ...(dialogue.length === 0 ? [] : [{ kind: "dialogue" as const, schedules: dialogue }])
  ];
}

export function sortMobileAutomationSchedules(
  schedules: readonly MobileAutomationSchedule[]
): readonly MobileAutomationSchedule[] {
  const rank: Record<MobileAutomationScheduleState, number> = {
    running: 0, enabled: 1, error: 2, disabled: 3, deleting: 4
  };
  return [...schedules].sort((left, right) => rank[left.state] - rank[right.state]
    || (right.lastTriggeredAt ?? -1) - (left.lastTriggeredAt ?? -1)
    || (right.updatedAt ?? -1) - (left.updatedAt ?? -1)
    || left.displayName.localeCompare(right.displayName)
    || left.scheduleId.localeCompare(right.scheduleId));
}

export function isMobileAutomationRunTerminal(run: MobileAutomationRun): boolean {
  return run.state !== "queued" && run.state !== "running";
}

export function isMobileAutomationRunUnread(run: MobileAutomationRun): boolean {
  return run.readAt === undefined && ["completed", "failed", "aborted", "interrupted"].includes(run.state);
}

export function canRestartMobileAutomationRun(run: MobileAutomationRun): boolean {
  return run.sessionId === undefined && (run.state === "aborted" || run.state === "interrupted");
}

function scheduleState(value: ScheduleState): MobileAutomationScheduleState {
  if (value === ScheduleState.ENABLED) return "enabled";
  if (value === ScheduleState.DISABLED) return "disabled";
  if (value === ScheduleState.RUNNING) return "running";
  if (value === ScheduleState.ERROR) return "error";
  if (value === ScheduleState.DELETING) return "deleting";
  throw new Error("The Joko node returned an unknown Automation Schedule state.");
}

function scheduleSource(value: ScheduleSource): MobileAutomationSchedule["source"] {
  if (value === ScheduleSource.USER) return "dialogue";
  if (value === ScheduleSource.PROJECT) return "project";
  throw new Error("The Joko node returned an unknown Automation source.");
}

function scheduleSessionMode(value: ScheduleSessionMode): MobileAutomationSchedule["sessionMode"] {
  if (value === ScheduleSessionMode.FRESH) return "fresh";
  if (value === ScheduleSessionMode.PERSISTENT) return "persistent";
  if (value === ScheduleSessionMode.BOUND) return "bound";
  throw new Error("The Joko node returned an unknown Automation task mode.");
}

function scheduleExecutionMode(value: ScheduleExecutionMode | undefined): MobileAutomationSchedule["executionMode"] {
  if (value === ScheduleExecutionMode.AGENT) return "agent";
  if (value === ScheduleExecutionMode.SCRIPT) return "script";
  throw new Error("The Joko node returned an unknown Automation execution mode.");
}

function scheduleOverlapPolicy(value: ScheduleOverlapPolicy): MobileAutomationSchedule["overlapPolicy"] {
  if (value === ScheduleOverlapPolicy.QUEUE) return "queue";
  if (value === ScheduleOverlapPolicy.SKIP) return "skip";
  throw new Error("The Joko node returned an unknown Automation overlap policy.");
}

function scheduleMisfirePolicy(value: ScheduleMisfirePolicy): MobileAutomationSchedule["misfirePolicy"] {
  if (value === ScheduleMisfirePolicy.RUN_ONCE) return "runOnce";
  if (value === ScheduleMisfirePolicy.SKIP) return "skip";
  throw new Error("The Joko node returned an unknown Automation missed-run policy.");
}

function scheduleRecurrence(schedule: Schedule): Pick<MobileAutomationSchedule, "recurrence" | "recurrenceLabel"> {
  const recurrence = schedule.recurrence?.kind;
  if (recurrence?.case === "manual") return { recurrence: "manual", recurrenceLabel: "Manual" };
  if (recurrence?.case === "oneShot") {
    return { recurrence: "once", recurrenceLabel: new Date(requiredTimestamp(recurrence.value.triggerAt, "one-shot trigger")).toISOString() };
  }
  if (recurrence?.case === "cron") {
    return { recurrence: "cron", recurrenceLabel: `cron ${requiredLabel(recurrence.value.expression, "cron expression")}` };
  }
  if (recurrence?.case === "interval") {
    const interval = recurrence.value.interval;
    if (interval === undefined) throw new Error("The Joko node returned an Automation interval without a duration.");
    return { recurrence: "interval", recurrenceLabel: `Every ${requiredDuration(interval, "Schedule interval")} ms` };
  }
  throw new Error("The Joko node returned an unknown Automation recurrence.");
}

function scheduleRunOutcome(value: ScheduleRunOutcome): MobileAutomationRunState {
  if (value === ScheduleRunOutcome.QUEUED) return "queued";
  if (value === ScheduleRunOutcome.RUNNING) return "running";
  if (value === ScheduleRunOutcome.SUCCEEDED) return "completed";
  if (value === ScheduleRunOutcome.SKIPPED) return "skipped";
  if (value === ScheduleRunOutcome.ABORTED) return "aborted";
  if (value === ScheduleRunOutcome.INTERRUPTED) return "interrupted";
  if (value === ScheduleRunOutcome.FAILED) return "failed";
  throw new Error("The Joko node returned an unknown Automation run outcome.");
}

function scheduleCostAttribution(value: ScheduleRunCostAttribution): MobileAutomationRun["costAttribution"] {
  if (value === ScheduleRunCostAttribution.EXACT) return "exact";
  if (value === ScheduleRunCostAttribution.DIRECT) return "direct";
  if (value === ScheduleRunCostAttribution.MIXED) return "mixed";
  if (value === ScheduleRunCostAttribution.ZERO) return "zero";
  if (value === ScheduleRunCostAttribution.UNAVAILABLE) return "unavailable";
  throw new Error("The Joko node returned an unknown Automation cost attribution.");
}

function scheduleMoney(value: ScheduleRunMoney): MobileAutomationMoney {
  if ((value.currencyCode !== "CNY" && value.currencyCode !== "USD")
    || (value.kind !== "actual-cost" && value.kind !== "value-estimate")
    || value.estimateReasons.length > 32
    || value.estimateReasons.some((reason) => reason.length > 4_096)) {
    throw new Error("The Joko node returned invalid Automation cost metadata.");
  }
  return {
    amountMicros: value.amountMicros,
    currencyCode: value.currencyCode,
    approximate: value.approximate,
    kind: value.kind,
    estimateReasons: [...value.estimateReasons]
  };
}

function schedulePreRun(value: SchedulePreRunResult): MobileAutomationPreRun {
  const statuses = new Set<MobileAutomationPreRun["status"]>(["passed", "skipped", "failed", "timed_out", "aborted"]);
  const decisions = new Set<MobileAutomationPreRun["decision"]>(["run", "skip", "block"]);
  if (!statuses.has(value.status as MobileAutomationPreRun["status"])
    || !decisions.has(value.decision as MobileAutomationPreRun["decision"])
    || value.duration === undefined
    || value.exitCode !== undefined && !Number.isSafeInteger(value.exitCode)) {
    throw new Error("The Joko node returned invalid Automation pre-run metadata.");
  }
  return {
    status: value.status as MobileAutomationPreRun["status"],
    decision: value.decision as MobileAutomationPreRun["decision"],
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    durationMs: requiredDuration(value.duration, "Automation pre-run"),
    ...(value.stdout.length === 0 ? {} : { stdout: boundedText(value.stdout, "Automation pre-run output", 131_072) }),
    ...(value.stderr.length === 0 ? {} : { stderr: boundedText(value.stderr, "Automation pre-run error output", 131_072) }),
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    timedOut: value.timedOut,
    aborted: value.aborted,
    ...(value.spawnError.length === 0 ? {} : { spawnError: boundedText(value.spawnError, "Automation pre-run spawn error") }),
    ...(value.error.length === 0 ? {} : { error: boundedText(value.error, "Automation pre-run error") })
  };
}

function assertKnownRunState(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 11) {
    throw new Error("The Joko node returned an unknown Automation run state.");
  }
}

function scheduleRunPhase(value: ScheduleRunPhase): void {
  if (!Number.isInteger(value) || value < ScheduleRunPhase.LOADING || value > ScheduleRunPhase.RECOVERING) {
    throw new Error("The Joko node returned an unknown Scheduler run phase.");
  }
}

function scheduleFireSource(value: ScheduleFireSource): void {
  if (value !== ScheduleFireSource.AUTOMATIC && value !== ScheduleFireSource.RUN_NOW) {
    throw new Error("The Joko node returned an unknown Scheduler fire source.");
  }
}

function requiredIdentifier(value: string, label: string): string {
  if (value.length === 0 || value.length > 512 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`The Joko node returned an invalid ${label} identity.`);
  }
  return value;
}

function optionalIdentifier(value: string, label: string): string | undefined {
  return value.length === 0 ? undefined : requiredIdentifier(value, label);
}

function requiredLabel(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  return value;
}

function optionalLabel(value: string, label: string): string | undefined {
  return value.length === 0 ? undefined : requiredLabel(value, label);
}

function boundedText(value: string, label: string, maximum = 16_384): string {
  if (value.length > maximum || /\u0000/u.test(value)) throw new Error(`The Joko node returned an invalid ${label}.`);
  return value;
}

function requiredTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (value === undefined || value.seconds < 0n || value.seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
    || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    throw new Error(`The Joko node returned an invalid ${label} timestamp.`);
  }
  const result = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(result)) throw new Error(`The Joko node returned an invalid ${label} timestamp.`);
  return result;
}

function optionalTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number | undefined {
  return value === undefined ? undefined : requiredTimestamp(value, label);
}

function requiredDuration(value: { readonly seconds: bigint; readonly nanos: number }, label: string): number {
  if (value.seconds < 0n || value.seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
    || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    throw new Error(`The Joko node returned an invalid ${label} duration.`);
  }
  const result = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(result)) throw new Error(`The Joko node returned an invalid ${label} duration.`);
  return result;
}

function counter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`The Joko node returned an invalid ${label}.`);
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`The Joko node returned a duplicate ${label} identity.`);
}
