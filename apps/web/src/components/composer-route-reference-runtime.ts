import type { AppController } from "../controller.js";
import type { NativeSessionTreeNodeView, TimelineItemView } from "../model.js";
import type { ComposerRouteReferenceResolutionTarget } from "./composer-route-reference-resolution.js";

/** Resolve chips from the freshest owner snapshot, then use bounded read APIs for history. */
export async function resolveComposerRouteReferenceFromRuntime(
  controller: AppController,
  target: ComposerRouteReferenceResolutionTarget,
  unnamedSessionLabel: string
): Promise<string | null> {
  const snapshot = controller.state.snapshot;
  if (target.kind === "project") {
    return snapshot.targets.find((candidate) => candidate.id === target.projectId)?.name.trim() || null;
  }
  if (target.kind === "session") {
    const session = snapshot.sessions.find((candidate) => candidate.id === target.sessionId);
    return session === undefined ? null : session.name.trim() || unnamedSessionLabel;
  }

  const cached = referencedTimelineText(snapshot.timelineBySession.get(target.sessionId) ?? [], target);
  if (cached !== null) return cached;
  if (target.eventId !== undefined) {
    try {
      const around = await controller.loadSessionTimelineAround(target.sessionId, target.eventId, 160);
      const resolved = referencedTimelineText(around, target);
      if (resolved !== null) return resolved;
    } catch {
      // Native history remains a useful fallback for local and remote runtimes.
    }
  }
  if (target.messageId !== undefined) {
    try {
      const tree = await controller.getSessionTree(target.sessionId);
      return referencedNativeMessageText(tree.roots, target.messageId);
    } catch {
      // Keep the stable deep link when its semantic body is unavailable.
    }
  }
  return null;
}

export function referencedTimelineText(
  items: readonly TimelineItemView[],
  target: Extract<ComposerRouteReferenceResolutionTarget, { readonly kind: "message" }>
): string | null {
  const identities = new Set([target.messageId, target.eventId].filter((value): value is string => value !== undefined));
  if (identities.size === 0) return null;
  const item = items.find((candidate) =>
    identities.has(candidate.id)
    || (candidate.sourceEventId !== undefined && identities.has(candidate.sourceEventId))
    || (candidate.nativeEntryId !== undefined && identities.has(candidate.nativeEntryId)));
  if (item?.kind !== "user" && item?.kind !== "assistant") return null;
  return item.text?.trim() || null;
}

export function referencedNativeMessageText(
  roots: readonly NativeSessionTreeNodeView[],
  messageId: string
): string | null {
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.id === messageId && node.kind === "message" && (node.role === "user" || node.role === "assistant")) {
      return node.text.trim() || null;
    }
    queue.unshift(...node.children);
  }
  return null;
}
