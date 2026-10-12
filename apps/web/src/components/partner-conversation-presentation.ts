import type { TimelineItemView } from "../model.js";
import { isInternalContinuationTimelineItem } from "../runtime-recovery.js";
import { readPartnerDelegationCardData } from "./partner-delegation-card-data.js";
import { TIMELINE_WORK_HISTORY_GAP_MS, type TimelineLeafRenderItem, type TimelineRenderItem } from "./timeline-render-items.js";
import { renderedTimelineMarkdownImageTargets } from "./timeline-markdown.js";

const TIME_GROUP_WINDOW_MS = 5 * 60 * 1_000;
const isProse = (item: TimelineRenderItem): item is TimelineLeafRenderItem => item.type === "item" && item.item.kind === "assistant";
const hasAttachments = (item: TimelineItemView): boolean => (item.attachments?.length ?? 0) > 0;

/** Adapt the stable turn/window projection to durable Joko Run outcomes. A
 * completed segment never seals a turn. Technical history remains persisted. */
export function simplifyPartnerRenderItems(source: readonly TimelineRenderItem[], active: boolean): readonly TimelineRenderItem[] {
  const result: TimelineRenderItem[] = [];
  let window: TimelineRenderItem[] = [];
  let previousEnd: number | undefined;
  for (const row of source) {
    const first = row.type === "work" ? row.children[0] : row.type === "item" ? row.item : undefined;
    const last = row.type === "work" ? row.children.at(-1) : first;
    const start = validTimestamp(first?.createdAt);
    const end = validTimestamp(last?.endedAt ?? last?.createdAt);
    if (first?.kind !== "user" && (row.historyGapBefore !== undefined
      || start !== undefined && previousEnd !== undefined && start - previousEnd > TIMELINE_WORK_HISTORY_GAP_MS)) {
      result.push(...projectWindow(window, false)); window = [];
    }
    window.push(row);
    if (end !== undefined) previousEnd = first?.kind === "user" ? end : Math.max(previousEnd ?? end, end);
  }
  result.push(...projectWindow(window, active));
  return result;
}

function projectWindow(source: readonly TimelineRenderItem[], active: boolean): readonly TimelineRenderItem[] {
  const rows: TimelineRenderItem[] = source.flatMap((row): TimelineRenderItem[] => row.type !== "work" ? [row]
    : row.children.map((item, index) => ({ type: "item", key: item.id, childIds: [item.id], item,
      ...(index !== 0 || row.historyGapBefore === undefined ? {} : { historyGapBefore: row.historyGapBefore }) })));
  const completedRuns = new Set(rows.flatMap((row) => row.type === "item" && row.item.runTerminal === "completed" && row.item.runId ? [row.item.runId] : []));
  const sealedAnswers = new Set<TimelineItemView>();
  let contiguousSeal = false;
  const lastProseByRun = new Map<string, TimelineItemView>();
  for (const row of rows) if (isProse(row) && row.item.runId && row.item.streaming !== true && row.item.text?.trim()) lastProseByRun.set(row.item.runId, row.item);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    // A terminal notice carries the seal rather than breaking adjacent prose.
    if (row.type === "item" && row.item.runTerminal !== undefined) continue;
    if (!isProse(row) || !row.item.text?.trim() || row.item.streaming === true) { contiguousSeal = false; continue; }
    contiguousSeal ||= row.item.runId !== undefined && completedRuns.has(row.item.runId) && lastProseByRun.get(row.item.runId) === row.item;
    if (contiguousSeal) sealedAnswers.add(row.item);
  }
  const result: TimelineRenderItem[] = [];
  let turn: TimelineRenderItem[] = [];
  let pendingGap: TimelineRenderItem["historyGapBefore"];
  const push = (row: TimelineRenderItem): void => {
    result.push(pendingGap === undefined || row.historyGapBefore !== undefined ? row : { ...row, historyGapBefore: pendingGap });
    pendingGap = undefined;
  };
  const flushTurn = (running: boolean): void => {
    let lastProse = -1;
    let lastDelivery = -1;
    const markdownDeliveries = new Set<TimelineItemView>();
    turn.forEach((row, index) => {
      if (isProse(row) && row.item.text?.trim()) lastProse = index;
      if (isProse(row) && renderedTimelineMarkdownImageTargets(row.item.text ?? "").length > 0) markdownDeliveries.add(row.item);
      if (row.type === "item" && (hasAttachments(row.item) || markdownDeliveries.has(row.item)
        || row.item.artifact !== undefined || row.item.tool !== undefined && readPartnerDelegationCardData(row.item.tool) !== undefined)) lastDelivery = index;
    });
    const fallback = !running && lastProse > lastDelivery ? lastProse : -1;
    turn.forEach((row, index) => {
      pendingGap ??= row.historyGapBefore;
      if (row.type !== "item") { push(row); return; }
      const item = row.item;
      if (item.inlinePlan !== undefined || item.kind === "diff" || item.kind === "thinking" || isInternalContinuationTimelineItem(item)
        || item.kind === "status" && item.streaming !== undefined) return;
      if ((item.kind === "tool" || item.kind === "toolResult") && (item.tool === undefined || readPartnerDelegationCardData(item.tool) === undefined)) {
        if (hasAttachments(item)) {
          const { tool: _tool, text: _text, ...delivery } = item;
          push({ ...row, item: { ...delivery, kind: "assistant", text: "", streaming: false } });
        }
        return;
      }
      if (isProse(row) && ((!item.text?.trim() && !hasAttachments(item))
        || !sealedAnswers.has(item) && !hasAttachments(item) && !markdownDeliveries.has(item) && index !== fallback)) return;
      push(row);
    });
    turn = [];
  };
  for (const row of rows) {
    if (row.type === "item" && row.item.kind === "user" && row.item.inputDelivery !== "steer") {
      flushTurn(false); pendingGap ??= row.historyGapBefore;
      if (!isInternalContinuationTimelineItem(row.item)) push(row);
    } else turn.push(row);
  }
  flushTurn(active);
  return result;
}

export function partnerTimeGroupStarts(rows: readonly TimelineRenderItem[]): ReadonlyMap<string, number> {
  const starts = new Map<string, number>();
  let groupStart: number | undefined;
  for (const row of rows) {
    if (row.type !== "item" || row.item.kind !== "user" && row.item.kind !== "assistant" || row.item.partnerPrivateOrigin !== undefined && row.item.kind === "user") continue;
    const createdAt = validTimestamp(row.item.createdAt);
    if (createdAt === undefined) continue;
    if (groupStart === undefined || createdAt - groupStart >= TIME_GROUP_WINDOW_MS) { groupStart = createdAt; starts.set(row.key, createdAt); }
  }
  return starts;
}

export function firstUnreadPartnerReply(rows: readonly TimelineRenderItem[], throughCursor: bigint | undefined): string | undefined {
  if (throughCursor === undefined) return undefined;
  return rows.find((row) => row.type === "item" && row.item.kind === "assistant" && row.item.streaming !== true
    && row.item.partnerPrivateOrigin === undefined && (row.item.completionCursor ?? 0n) > throughCursor)?.key;
}

export function latestVisiblePartnerReplyCursor(rows: readonly TimelineRenderItem[]): bigint | undefined {
  let cursor: bigint | undefined;
  for (const row of rows) if (row.type === "item" && row.item.kind === "assistant" && row.item.streaming !== true
    && row.item.partnerPrivateOrigin === undefined && row.item.completionCursor !== undefined
    && row.item.completionCursor > (cursor ?? 0n)) cursor = row.item.completionCursor;
  return cursor;
}

export function formatPartnerTimeGroup(timestamp: number, locale: string, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const }), month: "short", day: "numeric" }),
    hour: "numeric", minute: "2-digit"
  }).format(date);
}
function validTimestamp(value: number | undefined): number | undefined { return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined; }
