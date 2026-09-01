import type { ComposerMessageMentionDraft, TimelineItemView } from "../model.js";

export interface MessageForkTarget {
  readonly entryId: string;
  /** Fork before a user prompt and restore its text into the new composer. */
  readonly composerText?: string;
}

export interface MessageDeleteTarget {
  readonly messageId: string;
  readonly eventId: string;
}

/**
 * A running task keeps stable history forkable. Only a same-turn steer user
 * row and assistant output in the active tail lack a stable fork boundary.
 */
export function messageForkBlocked(
  items: readonly TimelineItemView[],
  item: TimelineItemView,
  sessionActive: boolean
): boolean {
  if (!sessionActive) return false;
  if (item.kind === "user") return item.inputDelivery === "steer";
  return item.kind === "assistant" && assistantForkBlockedMessageIds(items, true).has(item.id);
}

/** Assistant rows before a later non-steer user input are stable history. */
export function assistantForkBlockedMessageIds(
  items: readonly TimelineItemView[],
  sessionActive: boolean
): ReadonlySet<string> {
  const blocked = new Set<string>();
  if (!sessionActive) return blocked;
  let hasFollowingUserBoundary = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user") {
      if (item.inputDelivery !== "steer") hasFollowingUserBoundary = true;
      continue;
    }
    if (item?.kind === "assistant" && !hasFollowingUserBoundary) blocked.add(item.id);
  }
  return blocked;
}

/**
 * Message deletion is addressed only by the durable product Event identity.
 * The visible message ID remains part of the fence so a refreshed projection
 * cannot silently retarget an already-open confirmation.
 */
export function resolveMessageDeleteTarget(item: TimelineItemView): MessageDeleteTarget | undefined {
  if (
    (item.kind !== "user" && item.kind !== "assistant")
    || item.streaming === true
    || !boundedIdentity(item.id)
    || item.sourceEventId === undefined
    || !boundedIdentity(item.sourceEventId)
  ) return undefined;
  return { messageId: item.id, eventId: item.sourceEventId };
}

/** Resolve only forks whose native boundary is exact. */
export function resolveMessageForkTarget(item: TimelineItemView): MessageForkTarget | undefined {
  if (item.kind === "assistant" && item.nativeEntryId !== undefined) {
    return { entryId: item.nativeEntryId };
  }
  if (
    item.kind === "user" &&
    item.nativeParentEntryId !== undefined &&
    ((item.text?.trim().length ?? 0) > 0 || (item.attachments?.length ?? 0) > 0)
  ) {
    return {
      entryId: item.nativeParentEntryId,
      // A fork restores only the textual prompt. Historical attachment bytes
      // belong to the source turn and must never be silently copied.
      ...(item.text?.trim() ? { composerText: item.text } : {})
    };
  }
  return undefined;
}

export function createMessageComposerMention(
  sessionId: string,
  sessionName: string,
  item: TimelineItemView
): ComposerMessageMentionDraft | undefined {
  if (
    (item.kind !== "user" && item.kind !== "assistant")
    || !boundedIdentity(sessionId)
    || !boundedIdentity(item.id)
    || (item.sourceEventId !== undefined && !boundedIdentity(item.sourceEventId))
  ) return undefined;
  const label = sessionName.trim().slice(0, 120) || "Untitled task";
  const anchor = item.sourceEventId ?? item.id;
  return {
    id: `message:${sessionId}:${anchor}`,
    kind: "message",
    reference: item.id,
    label,
    sessionId,
    role: item.kind,
    ...(item.sourceEventId === undefined ? {} : { sourceEventId: item.sourceEventId })
  };
}

/** Expose assistant actions only on the final assistant message in a turn. */
export function finalAssistantMessageIds(items: readonly TimelineItemView[]): ReadonlySet<string> {
  const result = new Set<string>();
  const lastByRun = new Map<string, string>();
  let unscopedLast: string | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      if (item.inputDelivery === "steer") continue;
      if (unscopedLast !== undefined) result.add(unscopedLast);
      unscopedLast = undefined;
      continue;
    }
    if (item.kind !== "assistant" || item.streaming === true) continue;
    if (item.runId !== undefined) lastByRun.set(item.runId, item.id);
    else unscopedLast = item.id;
  }
  if (unscopedLast !== undefined) result.add(unscopedLast);
  for (const id of lastByRun.values()) result.add(id);
  return result;
}

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 1_024 && !/[\u0000-\u001f\u007f]/u.test(value);
}
