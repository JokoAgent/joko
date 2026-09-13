import type { ScheduleRunHistoryView } from "../model.js";

export type ScheduleHistoryDisplayEntry =
  | { readonly kind: "run"; readonly key: string; readonly run: ScheduleRunHistoryView }
  | { readonly kind: "session"; readonly key: string; readonly sessionId: string; readonly runs: readonly ScheduleRunHistoryView[] };

/** Group persistent or bound history by concrete Session without dropping pre-Session outcomes. */
export function groupScheduleHistoryRuns(
  runs: readonly ScheduleRunHistoryView[],
  groupBySession: boolean
): readonly ScheduleHistoryDisplayEntry[] {
  if (!groupBySession) return runs.map((run) => ({ kind: "run", key: `run:${run.id}`, run }));
  const entries: Array<
    | { kind: "run"; key: string; run: ScheduleRunHistoryView }
    | { kind: "session"; key: string; sessionId: string; runs: ScheduleRunHistoryView[] }
  > = [];
  const groups = new Map<string, Extract<(typeof entries)[number], { kind: "session" }>>();
  for (const run of runs) {
    if (run.sessionId.length === 0) {
      entries.push({ kind: "run", key: `run:${run.id}`, run });
      continue;
    }
    const group = groups.get(run.sessionId);
    if (group !== undefined) {
      group.runs.push(run);
      continue;
    }
    const next = { kind: "session" as const, key: `session:${run.sessionId}`, sessionId: run.sessionId, runs: [run] };
    groups.set(run.sessionId, next);
    entries.push(next);
  }
  return entries;
}
