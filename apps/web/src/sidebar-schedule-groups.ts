import type { ScheduleView, SessionView } from "./model.js";

export interface SidebarScheduleSessionGroup {
  readonly key: string;
  readonly schedule: ScheduleView;
  readonly sessions: readonly SessionView[];
}

export type SidebarScheduleSessionEntry =
  | { readonly kind: "session"; readonly session: SessionView }
  | { readonly kind: "scheduleGroup"; readonly group: SidebarScheduleSessionGroup };

/**
 * Replaces repeated schedule-owned runs with one schedule row while preserving
 * the surrounding task order. Ownership is historical: changing the schedule's
 * current execution or task mode must not split runs that it already created.
 */
export function groupSidebarScheduleSessions(
  sessions: readonly SessionView[],
  schedules: readonly ScheduleView[]
): readonly SidebarScheduleSessionEntry[] {
  const schedulesById = new Map(schedules.map((schedule) => [schedule.id, schedule]));
  const ownerBySessionId = new Map<string, ScheduleView>();
  for (const session of sessions) {
    const scheduleId = session.automationOrigin?.scheduleId;
    const schedule = scheduleId === undefined ? undefined : schedulesById.get(scheduleId);
    if (schedule !== undefined) ownerBySessionId.set(session.id, schedule);
  }

  const groups = new Map<string, { readonly schedule: ScheduleView; readonly sessions: SessionView[] }>();
  for (const session of sessions) {
    const owner = ownerBySessionId.get(session.id);
    if (owner === undefined) continue;
    const key = scheduleGroupKey(owner.id);
    const group = groups.get(key) ?? { schedule: owner, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }

  const emitted = new Set<string>();
  const result: SidebarScheduleSessionEntry[] = [];
  for (const session of sessions) {
    const owner = ownerBySessionId.get(session.id);
    if (owner === undefined) {
      result.push({ kind: "session", session });
      continue;
    }
    const key = scheduleGroupKey(owner.id);
    const group = groups.get(key);
    if (group === undefined || group.sessions.length < 2) {
      result.push({ kind: "session", session });
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    result.push({
      kind: "scheduleGroup",
      group: { key, schedule: group.schedule, sessions: group.sessions }
    });
  }
  return result;
}

export function sidebarScheduleEntrySessions(entry: SidebarScheduleSessionEntry): readonly SessionView[] {
  return entry.kind === "session" ? [entry.session] : entry.group.sessions;
}

export function sidebarScheduleEntryActivityAt(entry: SidebarScheduleSessionEntry): number {
  return sidebarScheduleEntrySessions(entry).reduce((latest, session) => Math.max(latest, session.updatedAt), 0);
}

function scheduleGroupKey(scheduleId: string): string {
  return scheduleId;
}
