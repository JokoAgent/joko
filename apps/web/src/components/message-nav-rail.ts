import type { TimelineItemView } from "../model.js";
import { visibleSelectionQuoteMessageText } from "../selection-quote.js";

export interface MessageNavEntry {
  readonly id: string;
  readonly preview: string;
  readonly isAutomation?: boolean;
  readonly attachmentsOnly?: number;
  readonly answerExcerpt?: string;
}

export const MESSAGE_NAV_MIN_ENTRIES = 4;
export const MESSAGE_NAV_MIN_GUTTER_PX = 44;
export const MESSAGE_NAV_TICK_PITCH_PX = 9;
export const MESSAGE_NAV_TICK_MIN_PITCH_PX = 5;
export const MESSAGE_NAV_MIN_HEIGHT_PX = MESSAGE_NAV_MIN_ENTRIES * MESSAGE_NAV_TICK_PITCH_PX;
export const MESSAGE_NAV_JUMP_TOP_PX = 12;
export const MESSAGE_NAV_ACTIVE_TOP_PX = 40;
export const MESSAGE_NAV_RANGE_BOTTOM_EDGE_PX = 8;
export const MESSAGE_NAV_EXCERPT_MAX_CHARS = 200;

export interface MessageNavPlan {
  readonly startIndex: number;
  readonly pitchPx: number;
  readonly hiddenCount: number;
}

export interface MessageNavVisibleRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export function deriveMessageNavEntries(items: readonly TimelineItemView[]): readonly MessageNavEntry[] {
  const entries: Array<{ id: string; preview: string; isAutomation?: boolean; attachmentsOnly?: number; answerExcerpt?: string }> = [];
  for (const item of items) {
    if (item.kind === "user") {
      // An accepted steer/follow-up belongs to the running turn. Untyped
      // imported rows remain navigable because their delivery cannot be proven.
      if (item.inputDelivery === "steer" || item.inputDelivery === "followUp") continue;
      const preview = promptPreviewLine(visibleSelectionQuoteMessageText(item.text ?? "", item.quotesEncoded === true));
      const attachmentNames = (item.attachments ?? []).map((attachment) => attachment.fileName.trim()).filter(Boolean);
      const isAutomation = item.automationOrigin !== undefined;
      if (preview !== "") entries.push({ id: item.id, preview, ...(isAutomation ? { isAutomation: true } : {}) });
      else if (attachmentNames.length > 0) entries.push({ id: item.id, preview: attachmentNames.join(" · "), ...(isAutomation ? { isAutomation: true } : {}) });
      else if ((item.attachments?.length ?? 0) > 0) entries.push({ id: item.id, preview: "", attachmentsOnly: item.attachments!.length, ...(isAutomation ? { isAutomation: true } : {}) });
      continue;
    }
    if (item.kind !== "assistant") continue;
    const last = entries.at(-1);
    if (last === undefined || last.answerExcerpt !== undefined) continue;
    const excerpt = normalizeMessageNavExcerpt(item.text ?? "");
    if (excerpt !== "") last.answerExcerpt = excerpt;
  }
  return entries;
}

export function promptPreviewLine(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const own = lines.find((line) => line.trim() !== "" && !line.trimStart().startsWith(">"));
  const any = lines.find((line) => line.trim() !== "") ?? "";
  return (own ?? any).replace(/^\s*>\s?/u, "").trim();
}

export function normalizeMessageNavExcerpt(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^>\s?/gmu, "")
    .replace(/^[-+]\s+/gmu, "")
    .replace(/[*`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MESSAGE_NAV_EXCERPT_MAX_CHARS);
}

export function planMessageNavTicks(entryCount: number, availableHeightPx: number): MessageNavPlan {
  if (entryCount <= 0 || availableHeightPx <= 0) return { startIndex: 0, pitchPx: MESSAGE_NAV_TICK_PITCH_PX, hiddenCount: 0 };
  if (entryCount * MESSAGE_NAV_TICK_PITCH_PX <= availableHeightPx) return { startIndex: 0, pitchPx: MESSAGE_NAV_TICK_PITCH_PX, hiddenCount: 0 };
  const compressed = Math.floor(availableHeightPx / entryCount);
  if (compressed >= MESSAGE_NAV_TICK_MIN_PITCH_PX) return { startIndex: 0, pitchPx: compressed, hiddenCount: 0 };
  const slots = Math.max(2, Math.floor(availableHeightPx / MESSAGE_NAV_TICK_MIN_PITCH_PX));
  const shown = Math.min(entryCount, slots - 1);
  return { startIndex: entryCount - shown, pitchPx: MESSAGE_NAV_TICK_MIN_PITCH_PX, hiddenCount: entryCount - shown };
}

export function pickActiveMessageNavId(
  ids: readonly string[],
  thresholdTop: number,
  topAt: (index: number) => number | null
): string | undefined {
  if (ids.length === 0) return undefined;
  let low = 0;
  let high = ids.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const top = topAt(middle) ?? Number.NEGATIVE_INFINITY;
    if (top <= thresholdTop) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return ids[Math.max(0, found)];
}

export function pickVisibleMessageNavRange(
  ids: readonly string[],
  viewTop: number,
  viewBottom: number,
  topAt: (index: number) => number | null
): MessageNavVisibleRange | undefined {
  if (ids.length === 0) return undefined;
  const endIndex = lastMessageNavIndexAtOrBelow(ids.length, viewBottom, topAt, false);
  if (endIndex < 0) return undefined;
  const startIndex = Math.min(
    endIndex,
    Math.max(0, lastMessageNavIndexAtOrBelow(ids.length, viewTop, topAt, true))
  );
  return { startIndex, endIndex };
}

export function messageNavTickProgress(distance: number | undefined): number {
  if (distance === undefined) return 0;
  if (distance === 0) return 1;
  if (distance === 1) return 0.7;
  if (distance === 2) return 0.4;
  if (distance === 3) return 0.2;
  return 0;
}

function lastMessageNavIndexAtOrBelow(
  count: number,
  limit: number,
  topAt: (index: number) => number | null,
  inclusive: boolean
): number {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const top = topAt(middle) ?? Number.NEGATIVE_INFINITY;
    if (inclusive ? top <= limit : top < limit) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

export function messageNavHasRoom(containerWidth: number, contentWidth: number): boolean {
  return containerWidth > 0 && Math.max(0, (containerWidth - Math.min(containerWidth, contentWidth)) / 2) >= MESSAGE_NAV_MIN_GUTTER_PX;
}
