import type {
  ScheduleDeletionResultView,
  ScheduleGeneratedSessionDispositionView,
  ScheduleHistoryPageView,
  SchedulerRuntimeView,
  ScheduleView,
  SessionView
} from "./model.js";

export type GeneratedSessionDisposition = ScheduleGeneratedSessionDispositionView;

export interface ScheduleDeletionAccess {
  listScheduleRunHistory(scheduleId: string, pageToken?: string, pageSize?: number): Promise<ScheduleHistoryPageView>;
  getSchedulerRuntime(signal?: AbortSignal): Promise<SchedulerRuntimeView>;
  deleteSchedule(scheduleId: string, disposition: GeneratedSessionDisposition): Promise<ScheduleDeletionResultView>;
}

export type ScheduleDeletionResult = ScheduleDeletionResultView;

export interface ScheduleDeletionPreview {
  readonly generatedSessionIds: readonly string[];
  readonly inflightCount: number;
}

/** Preview only Sessions carrying the authoritative automation origin. A history
 * primary may be a pre-existing task selected by a script and is never ownership proof. */
export async function collectScheduleGeneratedSessionIds(
  _access: Pick<ScheduleDeletionAccess, "listScheduleRunHistory">,
  schedule: ScheduleView,
  knownSessions?: readonly SessionView[]
): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const session of knownSessions ?? []) {
    if (session.automationOrigin?.scheduleId === schedule.id) {
      ids.add(session.id);
    }
  }
  return [...ids];
}

export async function prepareScheduleDeletion(
  access: Pick<ScheduleDeletionAccess, "listScheduleRunHistory" | "getSchedulerRuntime">,
  schedule: ScheduleView,
  knownSessions?: readonly SessionView[]
): Promise<ScheduleDeletionPreview> {
  const [generatedSessionIds, runtime] = await Promise.all([
    collectScheduleGeneratedSessionIds(access, schedule, knownSessions),
    access.getSchedulerRuntime()
  ]);
  return {
    generatedSessionIds,
    inflightCount: runtime.runs.filter((run) => run.scheduleId === schedule.id).length
  };
}

/**
 * Submit one durable service operation. The service re-collects generated tasks at commit time,
 * fences active occurrences, and persists the cleanup manifest before removing the Schedule.
 */
export async function deleteScheduleWithGeneratedSessions(
  access: ScheduleDeletionAccess,
  schedule: ScheduleView,
  disposition: GeneratedSessionDisposition,
  _knownSessions?: readonly SessionView[]
): Promise<ScheduleDeletionResult> {
  return access.deleteSchedule(schedule.id, disposition);
}
