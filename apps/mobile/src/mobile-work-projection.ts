import type { MobileThinkingView } from "./mobile-thinking-projection";
import type { MobileToolCallView } from "./mobile-tool-call";
import { groupMobileWorkRuns } from "./mobile-work-run-grouping";

export interface MobileWorkCandidate {
  readonly id: string;
  readonly eventId: string;
  readonly sequence: bigint;
  readonly kind: string;
  readonly text: string;
  readonly completed: boolean;
  readonly thinking?: MobileThinkingView;
  readonly tool?: MobileToolCallView;
  readonly ownerScope?: string;
  readonly runScope?: string;
  readonly startedAtMs?: number;
  readonly lastActivityAtMs?: number;
  readonly turnFinal?: boolean;
  readonly compactBoundary?: boolean;
  readonly workActivity?: boolean;
  readonly workStreaming?: boolean;
  /** Typed live-task affinity keeps the owning row visible at its original position. */
  readonly persistentTask?: boolean;
  /** Completed prose is delivered after its work; canonical message cursor stays unchanged. */
  readonly answerSequence?: bigint;
  readonly planSequence?: bigint;
}

export interface MobileWorkGroup<T extends MobileWorkCandidate> extends MobileWorkCandidate {
  readonly id: string;
  readonly eventId: string;
  readonly sequence: bigint;
  readonly kind: "work";
  readonly text: "";
  readonly label: "Work";
  readonly completed: boolean;
  readonly ownerScope?: string;
  readonly runScope?: string;
  readonly startedAtMs?: number;
  readonly children: readonly MobileWorkItem<T>[];
  readonly streaming: boolean;
}

export type MobileWorkItem<T extends MobileWorkCandidate> = T | MobileWorkGroup<T>;

/** Preserve existing message/tool objects while adapting the fixed generic turn grouping. */
export function mobileWorkItems<T extends MobileWorkCandidate>(rows: readonly T[], sessionStreaming: boolean): MobileWorkItem<T>[] {
  const segments: T[][] = [];
  let current: T[] = [];
  const ordered = [...rows].sort((a, b) => {
    const first = a.planSequence ?? a.answerSequence ?? a.sequence;
    const second = b.planSequence ?? b.answerSequence ?? b.sequence;
    return first < second ? -1 : first > second ? 1 : a.id.localeCompare(b.id);
  });
  for (const row of ordered) {
    const previous = current.at(-1);
    if (previous && ((row.ownerScope && previous.ownerScope && row.ownerScope !== previous.ownerScope)
      || (row.runScope && previous.runScope && row.runScope !== previous.runScope && row.kind !== "user"))) {
      segments.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) segments.push(current);
  return segments.flatMap((segment, index) => groupMobileWorkRuns<MobileWorkItem<T>, T>(segment, sessionStreaming && index === segments.length - 1, {
    isUserBoundary: (row) => row.kind === "user",
    isAnswer: (row) => row.kind === "assistant" && !row.workActivity && row.text.trim() !== "" && row.text !== "…",
    isSealedAnswer: (row) => row.kind !== "work" && row.turnFinal === true,
    isCompactBoundary: (row) => row.kind !== "work" && row.compactBoundary === true,
    isActivity: (row): row is T => activity(row),
    isArchivable: (row): row is T => row.planSequence === undefined && row.persistentTask !== true && (activity(row)
      || (row.kind === "assistant" && row.text.trim() !== "" && !deliveryProse(row.text))),
    startTimestamp: (row) => row.startedAtMs ?? null,
    endTimestamp: (row) => row.kind === "work" ? row.startedAtMs ?? null
      : row.tool?.endedAtMs ?? row.lastActivityAtMs ?? row.startedAtMs ?? null,
    boundaryTimestamp: (row) => row?.kind === "user" || row?.kind === "assistant" ? row.startedAtMs ?? null : null,
    userBoundaryEnd: (row, end) => row.startedAtMs === undefined ? end : Math.max(end ?? row.startedAtMs, row.startedAtMs),
    createGroup: (children, _next, streaming) => createGroup(children, streaming),
    createCompletedGroup: (children) => {
      if (children.every(activity)) return createGroup(children, false);
      const inner: MobileWorkItem<T>[] = [];
      let run: T[] = [];
      const flush = (): void => { if (run.length) inner.push(createGroup(run, false)); run = []; };
      for (const row of children) {
        if (activity(row)) run.push(row);
        else { flush(); inner.push(row); }
      }
      flush();
      return createGroup(inner, false, "summary");
    }
  }));
}

function createGroup<T extends MobileWorkCandidate>(children: readonly MobileWorkItem<T>[], streaming: boolean, prefix = "activity"): MobileWorkGroup<T> {
  const first = children[0]!;
  const actualStreaming = streaming && children.some((row) => isWorkGroup(row) ? row.streaming
    : row.thinking?.streaming === true || row.workStreaming === true || (row.tool !== undefined && !row.completed));
  return { id: JSON.stringify(["work", prefix, first.ownerScope ?? "", first.id]), kind: "work", text: "", label: "Work",
    eventId: first.eventId, sequence: first.sequence, children, streaming: actualStreaming, completed: !actualStreaming,
    ...(first.ownerScope === undefined ? {} : { ownerScope: first.ownerScope }),
    ...(first.runScope === undefined ? {} : { runScope: first.runScope }),
    ...(first.startedAtMs === undefined ? {} : { startedAtMs: first.startedAtMs }) };
}

export function isWorkGroup<T extends MobileWorkCandidate>(row: MobileWorkItem<T>): row is MobileWorkGroup<T> {
  return row.kind === "work" && "children" in row;
}

export function mobileWorkContains<T extends MobileWorkCandidate>(item: MobileWorkItem<T>, matches: (row: T) => boolean): boolean {
  return isWorkGroup(item) ? item.children.some((child) => mobileWorkContains(child, matches)) : matches(item);
}

/** Navigation opens only the ancestors of the exact original message. */
export function mobileWorkExpansionKeys<T extends MobileWorkCandidate>(items: readonly MobileWorkItem<T>[], matches: (row: T) => boolean): string[] {
  return items.flatMap((item) => isWorkGroup(item) && mobileWorkContains(item, matches)
    ? [item.id, ...mobileWorkExpansionKeys(item.children, matches)] : []);
}

function deliveryProse(text: string): boolean {
  const value = text.trim();
  return value.length >= 600 || /^[ \t]{0,3}#{1,6}[ \t]+\S/m.test(value)
    || /^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*\|[-:| \t]*$/m.test(value)
    || (value.match(/^[ \t]{0,3}(?:[-*+][ \t]+|\d{1,3}[.)][ \t]+)\S/gm)?.length ?? 0) >= 3;
}

function activity(row: MobileWorkCandidate): boolean {
  return row.planSequence === undefined && row.persistentTask !== true
    && (row.kind === "thinking" || row.kind === "tool" || row.workActivity === true);
}
