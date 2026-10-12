import type { ScheduleRecord } from "@joko/store";

/** This marker is written only by the Partner owner, never by public Schedule inputs. */
export function isPartnerRoutineSchedule(schedule: Pick<ScheduleRecord, "executionSnapshot">): boolean {
  return Object.hasOwn(schedule.executionSnapshot ?? {}, "partnerRoutine");
}
