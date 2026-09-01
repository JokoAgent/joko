import type { TimelineItemView } from "../model.js";

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

export interface TimelineViewportState {
  readonly anchorItemId?: string;
  readonly anchorOffset: number;
  readonly following: boolean;
  readonly unreadCount: number;
  readonly knownItemIds: ReadonlySet<string>;
  readonly maximumSequence?: bigint;
}

/**
 * Ephemeral viewport memory. The session key is deliberately part of this
 * layer so virtualized Timeline remounts cannot leak scroll/follow state.
 */
export class TimelineViewportStore {
  readonly #states = new Map<string, TimelineViewportState>();

  restore(sessionId: string, items: readonly TimelineItemView[]): TimelineViewportState {
    const stored = this.#states.get(sessionId);
    const currentIds = new Set(items.map((item) => item.id));
    const currentMaximum = maximumTimelineSequence(items);
    if (stored === undefined) {
      const initial: TimelineViewportState = {
        anchorOffset: 0,
        following: true,
        unreadCount: 0,
        knownItemIds: currentIds,
        ...(currentMaximum === undefined ? {} : { maximumSequence: currentMaximum })
      };
      this.#states.set(sessionId, initial);
      return cloneTimelineViewportState(initial);
    }

    const added = countUnreadTimelineItems(stored.knownItemIds, stored.maximumSequence, items, stored.following);
    const maximumSequence = maximumBigInt(stored.maximumSequence, currentMaximum);
    const anchorItemId = stored.anchorItemId !== undefined && (items.length === 0 || currentIds.has(stored.anchorItemId))
      ? stored.anchorItemId
      : undefined;
    const restored: TimelineViewportState = {
      ...(anchorItemId === undefined ? {} : { anchorItemId }),
      anchorOffset: anchorItemId === undefined ? 0 : stored.anchorOffset,
      following: stored.following,
      unreadCount: stored.following ? 0 : stored.unreadCount + added,
      knownItemIds: currentIds,
      ...(maximumSequence === undefined ? {} : { maximumSequence })
    };
    this.#states.set(sessionId, restored);
    return cloneTimelineViewportState(restored);
  }

  save(sessionId: string, viewport: Pick<TimelineViewportState, "anchorItemId" | "anchorOffset" | "following" | "unreadCount">, items: readonly TimelineItemView[]): void {
    const previous = this.#states.get(sessionId);
    const currentMaximum = maximumTimelineSequence(items);
    const maximumSequence = maximumBigInt(previous?.maximumSequence, currentMaximum);
    this.#states.set(sessionId, {
      ...(viewport.anchorItemId === undefined ? {} : { anchorItemId: viewport.anchorItemId }),
      anchorOffset: viewport.anchorOffset,
      following: viewport.following,
      unreadCount: viewport.following ? 0 : viewport.unreadCount,
      knownItemIds: new Set(items.map((item) => item.id)),
      ...(maximumSequence === undefined ? {} : { maximumSequence })
    });
  }
}

export function repairStreamingMarkdown(markdown: string): string {
  if (markdown.length === 0) return markdown;
  const fence = scanOpenFence(markdown);
  if (fence.open) return markdown.endsWith("\n") ? `${markdown}${fence.marker}` : `${markdown}\n${fence.marker}`;
  if (hasUnclosedInlineCode(fence.outside)) return markdown;

  let repaired = markdown
    .replace(/!\[([^\]\n]*)\]\([^\)\n]*$/, "$1")
    .replace(/!\[([^\]\n]*)$/, "$1")
    .replace(/(^|[^!\\])\[([^\]\n]*)\]\([^\)\n]*$/, "$1$2");
  repaired = balanceTrailingEmphasis(repaired, "**");
  return balanceTrailingEmphasis(repaired, "*");
}

export function streamingMarkdownThrottleDelay(now: number, lastEmission: number, intervalMs = 100): number {
  return Math.max(0, intervalMs - Math.max(0, now - lastEmission));
}

export function streamingMarkdownRenderValue(latest: string, throttled: string, streaming: boolean): string {
  return streaming ? throttled : latest;
}

export function resolveTimelineFollowingOnScroll({
  wasFollowing,
  distanceFromEnd,
  scrollDelta,
  threshold = 100,
  directionDeadZone = 1
}: {
  readonly wasFollowing: boolean;
  readonly distanceFromEnd: number;
  readonly scrollDelta: number;
  readonly threshold?: number;
  readonly directionDeadZone?: number;
}): boolean {
  if (distanceFromEnd >= threshold) {
    if (!wasFollowing) return false;
    return scrollDelta >= -directionDeadZone;
  }
  if (wasFollowing) return true;
  return scrollDelta > directionDeadZone;
}

export function resolveTimelineResizeScrollTop({
  following,
  currentScrollTop,
  scrollHeight,
  clientHeight,
  anchorOffsetDelta
}: {
  readonly following: boolean;
  readonly currentScrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly anchorOffsetDelta: number;
}): number {
  if (following) return Math.max(0, scrollHeight - clientHeight);
  if (Math.abs(anchorOffsetDelta) < 0.5) return currentScrollTop;
  return Math.max(0, currentScrollTop + anchorOffsetDelta);
}

export function shouldLoadEarlierTimeline({
  scrollTop,
  hasEarlier,
  loading,
  threshold = 56
}: {
  readonly scrollTop: number;
  readonly hasEarlier: boolean;
  readonly loading: boolean;
  readonly threshold?: number;
}): boolean {
  return hasEarlier && !loading && scrollTop <= threshold;
}

export function countUnreadTimelineItems(
  previousIds: ReadonlySet<string>,
  previousMaximumSequence: bigint | undefined,
  items: readonly TimelineItemView[],
  following: boolean
): number {
  if (following || previousMaximumSequence === undefined) return 0;
  return items.reduce((count, item) => count + (!previousIds.has(item.id) && item.sequence > previousMaximumSequence ? 1 : 0), 0);
}

export function maximumTimelineSequence(items: readonly TimelineItemView[]): bigint | undefined {
  let maximum: bigint | undefined;
  for (const item of items) if (maximum === undefined || item.sequence > maximum) maximum = item.sequence;
  return maximum;
}

export function timelineJumpBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

/** Merge a search-loaded historical window with the live recent projection. */
export function mergeTimelineWindows(
  recent: readonly TimelineItemView[],
  historical: readonly TimelineItemView[]
): readonly TimelineItemView[] {
  if (historical.length === 0) return recent;
  const byId = new Map<string, TimelineItemView>();
  for (const item of historical) byId.set(item.id, item);
  // The current snapshot wins when a streamed/reduced item also exists in the
  // historical window.
  for (const item of recent) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => {
    if (left.sequence !== right.sequence) return left.sequence < right.sequence ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function cloneTimelineViewportState(state: TimelineViewportState): TimelineViewportState {
  return { ...state, knownItemIds: new Set(state.knownItemIds) };
}

function maximumBigInt(left: bigint | undefined, right: bigint | undefined): bigint | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left > right ? left : right;
}

function scanOpenFence(markdown: string): { readonly open: boolean; readonly marker: string; readonly outside: string } {
  let marker = "";
  const outside: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = FENCE_LINE.exec(line);
    if (match !== null) {
      const candidate = match[1] ?? "";
      if (marker === "") {
        marker = candidate;
        continue;
      }
      if (candidate[0] === marker[0] && candidate.length >= marker.length && /^[ \t]*$/.test(match[2] ?? "")) {
        marker = "";
      }
      continue;
    }
    if (marker === "") outside.push(line);
  }
  return { open: marker !== "", marker, outside: outside.join("\n") };
}

function hasUnclosedInlineCode(markdown: string): boolean {
  let count = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "`" && !isEscaped(markdown, index)) count += 1;
  }
  return count % 2 === 1;
}

function balanceTrailingEmphasis(markdown: string, delimiter: "**" | "*"): string {
  const scan = scanEmphasis(markdown, delimiter);
  if (scan.mixed || scan.count % 2 === 0 || scan.last < 0) return markdown;
  const trailing = markdown.slice(scan.last + delimiter.length);
  if (trailing.length === 0 || !trailing.trim() || trailing.includes("\n") || trailing.includes("`") || /^\s/.test(trailing)) return markdown;
  return `${markdown}${delimiter}`;
}

function scanEmphasis(markdown: string, delimiter: "**" | "*"): { readonly count: number; readonly last: number; readonly mixed: boolean } {
  let count = 0;
  let last = -1;
  let mixed = false;
  for (let index = 0; index < markdown.length;) {
    if (markdown[index] !== "*" || isEscaped(markdown, index)) {
      index += 1;
      continue;
    }
    let end = index;
    while (markdown[end] === "*") end += 1;
    const length = end - index;
    if (length >= 3) mixed = true;
    else if (delimiter === "**" && length === 2) {
      count += 1;
      last = index;
    } else if (delimiter === "*" && length === 1 && !isListMarker(markdown, index)) {
      count += 1;
      last = index;
    }
    index = end;
  }
  return { count, last, mixed };
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isListMarker(value: string, index: number): boolean {
  if (value[index + 1] !== " " && value[index + 1] !== "\t") return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (value[cursor] === "\n") return true;
    if (value[cursor] !== " " && value[cursor] !== "\t") return false;
  }
  return true;
}
