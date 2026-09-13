import type { BackgroundTaskHistoryView, BackgroundTaskView, TimelineItemView } from "../model.js";

export interface ProjectedBackgroundTask extends BackgroundTaskView {
  readonly createdAt: number;
  readonly sequence: bigint;
}

export interface BackgroundTaskGroups {
  readonly running: readonly ProjectedBackgroundTask[];
  readonly finished: readonly ProjectedBackgroundTask[];
}

const ACTIVE_STATES = new Set<BackgroundTaskView["state"]>(["queued", "running", "waiting"]);

export function isActiveBackgroundTask(task: Pick<BackgroundTaskView, "state">): boolean {
  return ACTIVE_STATES.has(task.state);
}

export function projectBackgroundTaskGroups(
  timeline: readonly TimelineItemView[],
  history: readonly BackgroundTaskHistoryView[] = []
): BackgroundTaskGroups {
  const byId = new Map<string, ProjectedBackgroundTask>();
  for (const task of history) {
    byId.set(task.id, {
      ...task,
      sequence: task.revision
    });
  }
  for (const item of timeline) {
    if (item.background === undefined) continue;
    const candidate: ProjectedBackgroundTask = {
      ...item.background,
      createdAt: item.createdAt,
      sequence: item.sequence
    };
    const previous = byId.get(item.background.id);
    if (previous !== undefined && !isNewerObservation(candidate, previous)) continue;
    byId.set(item.background.id, candidate);
  }
  const running: ProjectedBackgroundTask[] = [];
  const finished: ProjectedBackgroundTask[] = [];
  for (const task of byId.values()) {
    (isActiveBackgroundTask(task) ? running : finished).push(task);
  }
  running.sort(compareRunning);
  finished.sort(compareFinished);
  return { running, finished };
}

function isNewerObservation(candidate: ProjectedBackgroundTask, previous: ProjectedBackgroundTask): boolean {
  const candidateAt = candidate.updatedAt ?? candidate.createdAt;
  const previousAt = previous.updatedAt ?? previous.createdAt;
  if (candidateAt !== previousAt) return candidateAt > previousAt;
  return candidate.sequence >= previous.sequence;
}

export function backgroundTaskDuration(task: ProjectedBackgroundTask, now: number): number | undefined {
  const startedAt = task.startedAt ?? task.createdAt;
  const endedAt = task.endedAt ?? (isActiveBackgroundTask(task) ? now : undefined);
  return endedAt === undefined ? undefined : Math.max(0, endedAt - startedAt);
}

function compareRunning(left: ProjectedBackgroundTask, right: ProjectedBackgroundTask): number {
  const byStart = (left.startedAt ?? left.createdAt) - (right.startedAt ?? right.createdAt);
  if (byStart !== 0) return byStart;
  return left.sequence === right.sequence ? 0 : left.sequence < right.sequence ? -1 : 1;
}

function compareFinished(left: ProjectedBackgroundTask, right: ProjectedBackgroundTask): number {
  const leftFinishedAt = left.endedAt ?? left.updatedAt ?? left.createdAt;
  const rightFinishedAt = right.endedAt ?? right.updatedAt ?? right.createdAt;
  if (leftFinishedAt !== rightFinishedAt) return rightFinishedAt - leftFinishedAt;
  return left.sequence === right.sequence ? 0 : left.sequence > right.sequence ? -1 : 1;
}
