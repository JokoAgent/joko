const SCHEDULE_FAILURE_DISMISSAL_PREFIX = "joko:schedule-failure-dismissal:v1:";
const DISMISSAL_VALUE = "1";

export interface ScheduleFailureDismissal {
  readonly completedAt: number;
  readonly scheduleId: string;
  readonly runId: string;
  readonly triggerId: string;
}

export function compareScheduleFailureDismissals(
  left: ScheduleFailureDismissal,
  right: ScheduleFailureDismissal
): number {
  return left.completedAt - right.completedAt
    || compareIdentity(left.scheduleId, right.scheduleId)
    || compareIdentity(left.runId, right.runId)
    || compareIdentity(left.triggerId, right.triggerId);
}

export function scheduleFailureDismissalPrefix(ownerId: string, sessionId: string): string {
  return `${SCHEDULE_FAILURE_DISMISSAL_PREFIX}${JSON.stringify([ownerId, sessionId])}:`;
}

export function readLatestDismissedScheduleFailure(
  storage: Storage,
  prefix: string
): ScheduleFailureDismissal | null {
  try {
    return readDismissals(storage, prefix)[0]?.failure ?? null;
  } catch {
    return null;
  }
}

/**
 * Each dismissal has its own key. A stale window can therefore add an older
 * record, but it cannot replace a newer record written by another window.
 * Cleanup only removes records older than the greatest observed identity.
 */
export function dismissScheduleFailure(
  storage: Storage,
  prefix: string,
  failure: ScheduleFailureDismissal
): void {
  if (!validFailure(failure)) throw new TypeError("Invalid schedule failure dismissal identity.");
  storage.setItem(dismissalKey(prefix, failure), DISMISSAL_VALUE);
  const records = readDismissals(storage, prefix);
  for (const record of records.slice(1)) storage.removeItem(record.key);
}

function dismissalKey(prefix: string, failure: ScheduleFailureDismissal): string {
  return `${prefix}${JSON.stringify([
    failure.completedAt,
    failure.scheduleId,
    failure.runId,
    failure.triggerId
  ])}`;
}

function readDismissals(
  storage: Storage,
  prefix: string
): Array<{ readonly key: string; readonly failure: ScheduleFailureDismissal }> {
  const records: Array<{ key: string; failure: ScheduleFailureDismissal }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key === null || !key.startsWith(prefix) || storage.getItem(key) !== DISMISSAL_VALUE) continue;
    const failure = parseDismissalKey(key.slice(prefix.length));
    if (failure !== null) records.push({ key, failure });
  }
  records.sort((left, right) => compareScheduleFailureDismissals(right.failure, left.failure));
  return records;
}

function parseDismissalKey(serialized: string): ScheduleFailureDismissal | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length !== 4) return null;
    const [completedAt, scheduleId, runId, triggerId] = value;
    const failure = { completedAt, scheduleId, runId, triggerId };
    return validFailure(failure) ? failure : null;
  } catch {
    return null;
  }
}

function validFailure(value: {
  readonly completedAt: unknown;
  readonly scheduleId: unknown;
  readonly runId: unknown;
  readonly triggerId: unknown;
}): value is ScheduleFailureDismissal {
  return typeof value.completedAt === "number" && Number.isFinite(value.completedAt)
    && validIdentity(value.scheduleId) && validIdentity(value.runId) && validIdentity(value.triggerId);
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function compareIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
