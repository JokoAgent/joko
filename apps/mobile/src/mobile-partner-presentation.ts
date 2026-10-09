import { collectMobileMarkdownImages } from "./mobile-markdown";
import { isWorkGroup, type MobileWorkItem } from "./mobile-work-projection";
import type { TimelineRow } from "./timeline";

const HISTORY_GAP_MS = 30 * 60 * 1_000;
const TIME_GROUP_MS = 5 * 60 * 1_000;
const flatten = (items: readonly MobileWorkItem<TimelineRow>[]): TimelineRow[] =>
  items.flatMap((item) => isWorkGroup(item) ? flatten(item.children) : [item]);
const prose = (row: TimelineRow): boolean => row.kind === "assistant" && row.completed && !row.workActivity && !!row.text.trim() && row.text !== "…";
const media = (row: TimelineRow): boolean => !!row.images?.length || !!row.artifacts?.length;
const delivery = (row: TimelineRow): boolean => media(row) || row.partnerDelivery === true || row.partnerPrivatePreview !== undefined
  || row.kind === "assistant" && collectMobileMarkdownImages(row.text).length > 0;

/** Host-owned bookkeeping/private prompts are not authored public input, including offline fallback. */
export function mobilePublicConversationInputs(rows: readonly TimelineRow[], partnerId?: string): TimelineRow[] {
  return rows.flatMap((row) => {
    if (row.internalInput) return [];
    if (row.kind !== "user" || row.partnerPrivateOrigin === undefined) return [row];
    const origin = row.partnerPrivateOrigin;
    const safeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
    if (partnerId !== undefined && origin.recipientPartnerId !== partnerId
      || origin.senderPartnerId === origin.recipientPartnerId
      || ![origin.threadId, origin.senderPartnerId, origin.recipientPartnerId, origin.messageId].every(safeId)
      || !origin.senderDisplayName.trim() || origin.senderDisplayName.length > 100
      || /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(origin.senderDisplayName)) return [];
    const { quoteSource: _quote, images: _images, artifacts: _artifacts, messageParts: _parts, ...receipt } = row;
    return [{ ...receipt, kind: "activity", text: "", partnerPrivatePreview: {
      threadId: origin.threadId, targetPartnerId: origin.senderPartnerId, targetName: origin.senderDisplayName
    } }];
  });
}

/** Presentation only: persisted Events, original message identity and lazy history stay intact. */
export function mobilePartnerConversationRows(items: readonly MobileWorkItem<TimelineRow>[], running: boolean,
  partnerId: string): TimelineRow[] {
  const source = flatten(items);
  const windows: TimelineRow[][] = [];
  let window: TimelineRow[] = [];
  let end: number | undefined;
  let owner: string | undefined;
  for (const row of source) {
    const start = validTime(row.startedAtMs);
    if (window.length && (row.ownerScope && owner && row.ownerScope !== owner
      || row.kind !== "user" && start !== undefined && end !== undefined && start - end > HISTORY_GAP_MS)) {
      windows.push(window); window = []; end = undefined;
    }
    window.push(row); owner = row.ownerScope ?? owner;
    const at = validTime(row.lastActivityAtMs ?? row.startedAtMs);
    if (at !== undefined) end = row.kind === "user" ? at : Math.max(end ?? at, at);
  }
  if (window.length) windows.push(window);
  return windows.flatMap((rows, index) => projectWindow(rows, running && index === windows.length - 1, partnerId));
}

function projectWindow(rows: readonly TimelineRow[], running: boolean, partnerId: string): TimelineRow[] {
  const lastByRun = new Map<string, TimelineRow>();
  for (const row of rows) if (prose(row) && row.runScope) lastByRun.set(row.runScope, row);
  const sealed = new Set<string>();
  let seal = false;
  let nextRun: string | undefined;
  for (const row of [...rows].reverse()) {
    if (row.kind === "activity" && row.runOutcome !== undefined && !delivery(row)) continue;
    if (!prose(row)) { seal = false; nextRun = undefined; continue; }
    if (nextRun !== undefined && row.runScope !== nextRun) seal = false;
    nextRun = row.runScope;
    seal ||= row.runOutcome === "completed" && !!row.runScope && lastByRun.get(row.runScope) === row;
    if (seal) sealed.add(row.id);
  }
  const result: TimelineRow[] = [];
  let turn: TimelineRow[] = [];
  const flush = (active: boolean): void => {
    let lastProse = -1; let lastDelivery = -1;
    turn.forEach((row, index) => { if (prose(row)) lastProse = index; if (delivery(row)) lastDelivery = index; });
    const fallback = !active && lastProse > lastDelivery ? lastProse : -1;
    turn.forEach((row, index) => {
      if (row.internalInput) return;
      if (row.kind === "user" && row.partnerPrivateOrigin !== undefined) {
        result.push(...mobilePublicConversationInputs([row], partnerId));
        return;
      }
      if (row.plan || row.workActivity && !media(row)) return;
      if (row.kind === "system" || row.kind === "status" || row.kind === "activity" && !delivery(row) && !row.runStopped) return;
      if (row.kind === "tool") {
        if (delivery(row)) {
          const { tool: _tool, ...receipt } = row;
          result.push({ ...receipt, kind: "activity", text: "" });
        }
        return;
      }
      if (row.kind === "assistant" && (!row.completed && !delivery(row) || !sealed.has(row.id) && !delivery(row) && index !== fallback)) return;
      if (row.messageParts?.some((part) => part.kind === "thinking")) {
        result.push({ ...row, messageParts: row.messageParts.filter((part) => part.kind !== "thinking") });
      } else result.push(row);
    });
    turn = [];
  };
  for (const row of rows) {
    if (row.kind === "user" && row.partnerPrivateOrigin === undefined) {
      flush(false); if (!row.internalInput) result.push(row);
    } else turn.push(row);
  }
  flush(running);
  return result;
}

export function mobilePartnerTimeGroups(rows: readonly TimelineRow[]): ReadonlyMap<string, number> {
  const groups = new Map<string, number>(); let start: number | undefined;
  for (const row of rows) {
    if (row.kind !== "user" && row.kind !== "assistant" && !row.partnerPrivatePreview && !row.partnerDelivery) continue;
    const at = validTime(row.startedAtMs);
    if (at === undefined) continue;
    if (start === undefined || at - start >= TIME_GROUP_MS) { groups.set(row.id, at); start = at; }
  }
  return groups;
}

export function formatMobilePartnerTime(timestamp: number, locale: string, now = Date.now()): string {
  const date = new Date(timestamp); const today = new Date(now);
  return new Intl.DateTimeFormat(locale, {
    ...(date.toDateString() === today.toDateString() ? {} : {
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const }), month: "short", day: "numeric"
    }), hour: "numeric", minute: "2-digit"
  }).format(date);
}

function validTime(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
