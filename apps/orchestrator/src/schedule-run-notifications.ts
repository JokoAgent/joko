import type { OperationalStore, ScheduleRecord } from "@joko/store";

import { scheduleExtensionSnapshot } from "./schedule-extensions.js";
import { persistSessionTaskActivity } from "./session-task-activity.js";

export type ScheduleRunTerminalState = "completed" | "aborted" | "failed";

const ACTIVE_RUN_SCAN_PAGE_SIZE = 10_000;

/**
 * Ephemeral per-run attention override. Restart deliberately loses silence
 * markers so an uncertain completion alerts the owner in the fail-safe direction.
 */
export class ScheduleRunNotificationController {
  readonly #store: OperationalStore;
  readonly #overrides = new Map<string, "silent" | "notify">();

  constructor(store: OperationalStore) {
    this.#store = store;
  }

  silence(input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly runId?: string;
  }): { readonly runId: string; readonly scheduleId: string } {
    const resolved = this.#resolveActiveScheduleRun(input);
    this.#overrides.set(resolved.runId, "silent");
    return resolved;
  }

  notify(input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly runId?: string;
  }): { readonly runId: string; readonly scheduleId: string } {
    const resolved = this.#resolveActiveScheduleRun(input);
    this.#overrides.set(resolved.runId, "notify");
    return resolved;
  }

  /** Consume the one-run marker exactly once at the terminal transition. */
  settle(runId: string, state: ScheduleRunTerminalState): {
    readonly suppressAttention: boolean;
    readonly markHistoryRead: boolean;
  } {
    const override = this.#overrides.get(runId);
    this.#overrides.delete(runId);
    const finish = (suppressAttention: boolean, markHistoryRead: boolean) => {
      const run = this.#store.findRun(runId);
      if (run) persistSessionTaskActivity(this.#store, run.descriptor.sessionId, { runId, silent: state === "completed" && markHistoryRead });
      return { suppressAttention, markHistoryRead };
    };
    if (state !== "completed") return finish(false, false);
    if (override === "notify") return finish(true, false);
    if (override === "silent") return finish(true, true);
    const schedule = this.#findScheduleForRun(runId);
    if (schedule === undefined) return finish(false, false);
    try {
      return finish(true, scheduleExtensionSnapshot(schedule.executionSnapshot).silentWhenIdle);
    } catch {
      return finish(false, false);
    }
  }

  hasOverride(runId: string): boolean {
    return this.#overrides.has(runId);
  }

  #resolveActiveScheduleRun(input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly runId?: string;
  }): { readonly runId: string; readonly scheduleId: string } {
    const active = input.runId === undefined
      ? this.#listActiveRuns(input.sessionId)
      : [this.#store.findRun(input.runId)].flatMap((run) =>
          run !== undefined && run.descriptor.sessionId === input.sessionId && activeRunState(run.descriptor.state)
            ? [run]
            : []);
    const candidates = active.flatMap((run) => {
      const schedule = this.#findScheduleForRun(run.descriptor.id, input.targetId, input.sessionId);
      return schedule === undefined ? [] : [{ runId: run.descriptor.id, scheduleId: schedule.id }];
    });
    if (candidates.length === 0) throw new Error("In-flight schedule run was not found for the current task.");
    if (candidates.length > 1 && input.runId === undefined) {
      throw new Error("Current task has more than one in-flight schedule run; provide runId.");
    }
    return candidates[0]!;
  }

  #findScheduleForRun(runId: string, targetId?: string, sessionId?: string): ScheduleRecord | undefined {
    const linked = this.#store.findScheduleRunByRunId(runId);
    if (linked === undefined || (sessionId !== undefined && linked.sessionId !== sessionId)) return undefined;
    const schedule = this.#store.findSchedule(linked.scheduleId);
    if (schedule === undefined || (targetId !== undefined && schedule.targetId !== targetId)) return undefined;
    return schedule;
  }

  #listActiveRuns(sessionId: string): ReturnType<OperationalStore["listRuns"]> {
    const runs: ReturnType<OperationalStore["listRuns"]> = [];
    for (;;) {
      const page = this.#store.listRuns({
        sessionId,
        activeOnly: true,
        limit: ACTIVE_RUN_SCAN_PAGE_SIZE,
        offset: runs.length
      });
      runs.push(...page);
      if (page.length < ACTIVE_RUN_SCAN_PAGE_SIZE) return runs;
    }
  }
}

function activeRunState(state: string): boolean {
  return state === "queued" || state === "running" || state === "waiting" ||
    state === "retrying" || state === "dispatch_unknown";
}
