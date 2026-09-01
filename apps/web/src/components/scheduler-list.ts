import type { SchedulerRuntimeView, ScheduleRuntimeRunView, ScheduleRuntimeWaitingView, ScheduleView, TargetView } from "../model.js";

export type ScheduleStatusFilter = "active" | "paused" | "all";
export type ScheduleDisplayStatus = "active" | "paused" | "expired";

export function normalizeScheduleStatusFilter(value: unknown): ScheduleStatusFilter {
  return value === "active" || value === "paused" ? value : "all";
}

export function selectVisibleScheduleId(schedules: readonly ScheduleView[], selectedId?: string): string | undefined {
  return selectedId !== undefined && schedules.some((schedule) => schedule.id === selectedId)
    ? selectedId
    : schedules[0]?.id;
}

/** Keep consumed one-shot automations in the Active bucket as an
 * immutable "expired" task. Treating them as paused exposes a Resume action
 * that can only submit a past trigger and fail validation. */
export function scheduleDisplayStatus(schedule: ScheduleView): ScheduleDisplayStatus {
  if (schedule.enabled) return "active";
  if (schedule.kind === "once" && schedule.nextRunAt === undefined && schedule.history.length > 0) return "expired";
  return "paused";
}

export function countActiveSchedules(schedules: readonly ScheduleView[]): number {
  return schedules.filter((schedule) => scheduleDisplayStatus(schedule) !== "paused").length;
}

export interface ScheduleProjectGroup {
  readonly key: string;
  readonly name: string;
  readonly schedules: readonly ScheduleView[];
}

export type ScheduleRuntimeStatus =
  | { readonly kind: "run"; readonly run: ScheduleRuntimeRunView }
  | { readonly kind: "capacity"; readonly waiting: ScheduleRuntimeWaitingView };

export function scheduleRuntimeStatus(runtime: SchedulerRuntimeView | undefined, scheduleId: string): ScheduleRuntimeStatus | undefined {
  if (runtime === undefined) return undefined;
  const run = runtime.runs.find((candidate) => candidate.scheduleId === scheduleId);
  if (run !== undefined) return { kind: "run", run };
  const waiting = runtime.waiting.find((candidate) => candidate.scheduleId === scheduleId);
  return waiting === undefined ? undefined : { kind: "capacity", waiting };
}

export function filterSchedules(schedules: readonly ScheduleView[], filter: ScheduleStatusFilter): readonly ScheduleView[] {
  if (filter === "all") return schedules;
  return schedules.filter((schedule) => {
    const status = scheduleDisplayStatus(schedule);
    return filter === "active" ? status !== "paused" : status === "paused";
  });
}

export function groupSchedulesByProject(schedules: readonly ScheduleView[], targets: readonly TargetView[], fallbackName: string): readonly ScheduleProjectGroup[] {
  const targetById = new Map(targets.map((target) => [target.id, target] as const));
  const groups = new Map<string, { name: string; schedules: ScheduleView[] }>();
  for (const schedule of schedules) {
    const target = targetById.get(schedule.targetId);
    const key = target?.workspaceId || target?.id || "other";
    const group = groups.get(key) ?? { name: target?.workspaceName || target?.name || fallbackName, schedules: [] };
    group.schedules.push(schedule);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      name: group.name,
      schedules: [...group.schedules].sort(compareScheduleRecency)
    }))
    .sort((left, right) => {
      const leftPaused = left.schedules.every((schedule) => scheduleDisplayStatus(schedule) === "paused");
      const rightPaused = right.schedules.every((schedule) => scheduleDisplayStatus(schedule) === "paused");
      if (leftPaused !== rightPaused) return leftPaused ? 1 : -1;
      const recency = scheduleRecency(right.schedules[0]) - scheduleRecency(left.schedules[0]);
      return recency || left.name.localeCompare(right.name);
    });
}

/** Merge a refreshed authoritative recent window into already-paged history.
 * Matching rows are replaced in place so running → terminal transitions appear
 * without remounting the detail pane; older loaded pages remain available. */
export function reconcileScheduleHistory(
  current: ScheduleView["history"],
  recent: ScheduleView["history"]
): ScheduleView["history"] {
  if (recent.length === 0) return current;
  const currentById = new Map(current.map((run) => [run.id, run] as const));
  const mergedRecent = recent.map((run) => {
    const acknowledgedAt = currentById.get(run.id)?.readAt;
    return run.readAt === undefined && acknowledgedAt !== undefined ? { ...run, readAt: acknowledgedAt } : run;
  });
  const authoritativeIds = new Set(recent.map((run) => run.id));
  return [...mergedRecent, ...current.filter((run) => !authoritativeIds.has(run.id))];
}

export function clampScheduleListWidth(width: number): number {
  return Math.min(480, Math.max(240, Math.round(width)));
}

function compareScheduleRecency(left: ScheduleView, right: ScheduleView): number {
  if (left.source !== right.source) return left.source === "project" ? -1 : 1;
  return scheduleRecency(right) - scheduleRecency(left) || left.name.localeCompare(right.name);
}

function scheduleRecency(schedule: ScheduleView | undefined): number {
  return schedule?.lastRun?.at ?? schedule?.history[0]?.triggeredAt ?? 0;
}
