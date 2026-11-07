import type { ScheduleHistoryPageView, ScheduleRunHistoryView, ScheduleView } from "./model.js";

const OWNER_SNAPSHOT_HISTORY_LIMIT = 100;

export interface ScheduleNotificationCandidate {
  readonly title: string;
  readonly kind: "done" | "error";
  readonly sessionId?: string;
  readonly failureHistory?: { readonly scheduleId: string; readonly run: ScheduleRunHistoryView };
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
  readonly #observedScheduleIds = new Set<string>();
  readonly #recencyByScheduleId = new Map<string, ScheduleRunRecency>();

  observe(ownerId: string, schedules: readonly ScheduleView[]): ScheduleNotificationObservation {
    if (this.#ownerId !== ownerId) {
      this.#ownerId = ownerId;
      this.#initialized = false;
      this.#seen.clear();
      this.#observedScheduleIds.clear();
      this.#recencyByScheduleId.clear();
    }

    const attentionOwnedSessionIds = new Set<string>();
    const notifications: ScheduleNotificationCandidate[] = [];
    for (const schedule of schedules) {
      const scheduleObserved = this.#initialized && this.#observedScheduleIds.has(schedule.id);
      const observedRecency = this.#recencyByScheduleId.get(schedule.id);
      let latestRecency = observedRecency;
      for (const run of schedule.history) {
        const key = `${schedule.id}\u0000${run.id}`;
        const fingerprint = runFingerprint(run);
        const previous = this.#seen.get(key);
        const terminal = terminalRun(run);
        const newlyTerminal = scheduleObserved && terminal && (
          previous?.startsWith("running\u0000") === true
          || previous === undefined && isNewerScheduleRun(run, observedRecency)
        );
        if (run.state === "running" || newlyTerminal || !scheduleObserved && terminal) {
          addSession(attentionOwnedSessionIds, run.sessionId);
        }
        this.#seen.set(key, fingerprint);
        if (isNewerScheduleRun(run, latestRecency)) latestRecency = scheduleRunRecency(run);
        if (!newlyTerminal || !schedule.notifyDesktop || run.state === "skipped") continue;
        if (run.state === "completed" && run.readAt !== undefined) continue;
        const checkFailure = schedule.silentWhenIdle && run.state === "failed" && failureSignature(run) !== undefined;
        const repeated = checkFailure ? repeatedFailureInHistory(run, schedule.history) : false;
        if (repeated === true) continue;
        notifications.push({
          title: schedule.name,
          kind: run.state === "completed" ? "done" : "error",
          ...(run.sessionId.trim() === "" ? {} : { sessionId: run.sessionId }),
          ...(repeated === undefined && schedule.history.length >= OWNER_SNAPSHOT_HISTORY_LIMIT
            ? { failureHistory: { scheduleId: schedule.id, run } } : {})
        });
      }
      this.#observedScheduleIds.add(schedule.id);
      if (latestRecency !== undefined) this.#recencyByScheduleId.set(schedule.id, latestRecency);
    }
    // History windows may temporarily omit an older run and later expose it
    // again. Keep its terminal edge tombstone for this owner lifetime so a
    // window change cannot replay a Desktop notification.
    this.#initialized = true;
    return { notifications, attentionOwnedSessionIds };
  }

  reset(): void {
    this.#ownerId = undefined;
    this.#initialized = false;
    this.#seen.clear();
    this.#observedScheduleIds.clear();
    this.#recencyByScheduleId.clear();
  }
}

/** Resolve a failure outside the bounded owner snapshot through the original history pages. */
export async function hasUnrecoveredScheduleFailure(
  run: ScheduleRunHistoryView,
  readPage: (pageToken: string) => Promise<ScheduleHistoryPageView>,
  signal: AbortSignal
): Promise<boolean> {
  let token = "";
  const requested = new Set<string>();
  while (!requested.has(token)) {
    signal.throwIfAborted();
    requested.add(token);
    const page = await readPage(token);
    signal.throwIfAborted();
    const repeated = repeatedFailureInHistory(run, page.history);
    if (repeated !== undefined) return repeated;
    if (page.nextPageToken === undefined) return false;
    token = page.nextPageToken;
  }
  return false;
}

function repeatedFailureInHistory(run: ScheduleRunHistoryView, history: readonly ScheduleRunHistoryView[]): boolean | undefined {
  const signature = failureSignature(run);
  if (signature === undefined) return false;
  const preCheckFailure = run.preRun?.decision === "block";
  let latest: ScheduleRunRecency | undefined;
  let repeated: boolean | undefined;
  for (const prior of history) {
    if (!isNewerScheduleRun(run, scheduleRunRecency(prior)) || !isNewerScheduleRun(prior, latest)) continue;
    const recovered = prior.state === "completed" || (preCheckFailure && (prior.state === "failed" || prior.state === "skipped") &&
      (prior.preRun?.decision === "run" || prior.preRun?.decision === "skip"));
    const matches = (prior.state === "failed" || prior.state === "interrupted") && failureSignature(prior) === signature;
    if (recovered || matches) {
      latest = scheduleRunRecency(prior);
      repeated = !recovered;
    }
  }
  return repeated;
}

function failureSignature(run: ScheduleRunHistoryView): string | undefined {
  if (!run.error?.trim() || run.error === "Schedule execution failed." || run.preRun?.stderrTruncated === true) return undefined;
  return JSON.stringify([run.preRun?.decision === "block", run.errorCode ?? "", run.errorPhase ?? "", run.error, run.preRun?.stderr ?? ""]);
}

interface ScheduleRunRecency {
  readonly triggeredAt: number;
  readonly id: string;
}

function terminalRun(run: ScheduleRunHistoryView): boolean {
  return run.state === "completed" || run.state === "failed" || run.state === "aborted" ||
    run.state === "interrupted" || run.state === "skipped";
}

function runFingerprint(run: ScheduleRunHistoryView): string {
  return `${run.state}\u0000${run.finishedAt ?? ""}\u0000${run.readAt ?? ""}`;
}

function scheduleRunRecency(run: ScheduleRunHistoryView): ScheduleRunRecency {
  return { triggeredAt: run.triggeredAt, id: run.id };
}

/** Mirrors the authoritative Store order: `fired_at DESC, id DESC`. */
function isNewerScheduleRun(
  run: ScheduleRunHistoryView,
  current: ScheduleRunRecency | undefined
): boolean {
  if (current === undefined) return true;
  if (run.triggeredAt !== current.triggeredAt) return run.triggeredAt > current.triggeredAt;
  return compareScheduleRunIds(run.id, current.id) > 0;
}

function compareScheduleRunIds(left: string, right: string): number {
  const leftNumeric = decimalTriggerId(left);
  const rightNumeric = decimalTriggerId(right);
  if (leftNumeric !== undefined && rightNumeric !== undefined) {
    return leftNumeric < rightNumeric ? -1 : leftNumeric > rightNumeric ? 1 : 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function decimalTriggerId(value: string): bigint | undefined {
  return /^(?:0|[1-9][0-9]*)$/u.test(value) ? BigInt(value) : undefined;
}

function addSession(target: Set<string>, sessionId: string): void {
  if (sessionId.trim() !== "") target.add(sessionId);
}
