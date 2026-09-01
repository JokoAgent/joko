import type { OperationalStore, ScheduleRecord } from "@joko/store";

import { scheduleExtensionSnapshot } from "./schedule-extensions.js";

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
    if (state !== "completed") return { suppressAttention: false, markHistoryRead: false };
    if (override === "notify") return { suppressAttention: true, markHistoryRead: false };
    if (override === "silent") return { suppressAttention: true, markHistoryRead: true };
    const schedule = this.#findScheduleForRun(runId);
    if (schedule === undefined) return { suppressAttention: false, markHistoryRead: false };
    try {
      return {
        suppressAttention: true,
        markHistoryRead: scheduleExtensionSnapshot(schedule.executionSnapshot).silentWhenIdle
      };
    } catch {
      return { suppressAttention: false, markHistoryRead: false };
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
