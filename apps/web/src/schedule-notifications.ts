import type { ScheduleRunHistoryView, ScheduleView } from "./model.js";

export const MAXIMUM_TRACKED_SCHEDULE_NOTIFICATION_RUNS = 4_096;

export interface ScheduleNotificationCandidate {
  readonly title: string;
  readonly kind: "done" | "error";
  readonly sessionId?: string;
}

export interface ScheduleNotificationObservation {
  readonly notifications: readonly ScheduleNotificationCandidate[];
  /** Sessions whose current attention edge belongs to a Scheduler run. */
  readonly attentionOwnedSessionIds: ReadonlySet<string>;
}

/**
 * Converts authoritative Schedule history transitions into one-shot Desktop
 * notifications. Running ownership is included so the earlier adapter `done`
 * event cannot race ahead and also produce an ordinary task notification.
 */
export class ScheduleNotificationTracker {
  #ownerId: string | undefined;
  #initialized = false;
  readonly #seen = new Map<string, string>();

  observe(ownerId: string, schedules: readonly ScheduleView[]): ScheduleNotificationObservation {
    if (this.#ownerId !== ownerId) {
      this.#ownerId = ownerId;
      this.#initialized = false;
      this.#seen.clear();
    }

    const attentionOwnedSessionIds = new Set<string>();
    const notifications: ScheduleNotificationCandidate[] = [];
    for (const schedule of schedules) {
      for (const run of schedule.history) {
        const key = `${schedule.id}\u0000${run.id}`;
        const fingerprint = runFingerprint(run);
        const previous = this.#seen.get(key);
        const newlyTerminal = this.#initialized && terminalRun(run) &&
          (previous === undefined || previous.startsWith("running\u0000"));
        if (run.state === "running" || newlyTerminal) addSession(attentionOwnedSessionIds, run.sessionId);
        this.#remember(key, fingerprint);
        if (!newlyTerminal || !schedule.notifyDesktop || run.state === "skipped") continue;
        if (run.state === "completed" && run.readAt !== undefined) continue;
        notifications.push({
          title: schedule.name,
          kind: run.state === "completed" ? "done" : "error",
          ...(run.sessionId.trim() === "" ? {} : { sessionId: run.sessionId })
        });
      }
    }
    this.#initialized = true;
    return { notifications, attentionOwnedSessionIds };
  }

  reset(): void {
    this.#ownerId = undefined;
    this.#initialized = false;
    this.#seen.clear();
  }

  #remember(key: string, fingerprint: string): void {
    this.#seen.set(key, fingerprint);
    while (this.#seen.size > MAXIMUM_TRACKED_SCHEDULE_NOTIFICATION_RUNS) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#seen.delete(oldest);
    }
  }
}

function terminalRun(run: ScheduleRunHistoryView): boolean {
  return run.state === "completed" || run.state === "failed" || run.state === "aborted" ||
    run.state === "interrupted" || run.state === "skipped";
}

function runFingerprint(run: ScheduleRunHistoryView): string {
  return `${run.state}\u0000${run.finishedAt ?? ""}\u0000${run.readAt ?? ""}`;
}

function addSession(target: Set<string>, sessionId: string): void {
  if (sessionId.trim() !== "") target.add(sessionId);
}
