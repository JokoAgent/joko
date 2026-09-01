import type { ComposerMessageMentionDraft, ComposerMentionDraft } from "./model.js";

export function sessionMessageDeepLink(
  sessionId: string,
  messageId: string,
  eventId: string | undefined,
  currentHref: string
): string {
  const fragmentIndex = currentHref.indexOf("#");
  const base = safeMessageLinkBase(fragmentIndex < 0 ? currentHref : currentHref.slice(0, fragmentIndex));
  const query = new URLSearchParams();
  if (eventId !== undefined) query.set("event", eventId);
  query.set("message", messageId);
  return `${base}#/tasks/${encodeURIComponent(sessionId)}?${query.toString()}`;
}

function safeMessageLinkBase(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:auth|api)[_-]?key|token|secret|password|credential/iu.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    const queryIndex = value.indexOf("?");
    return queryIndex < 0 ? value : value.slice(0, queryIndex);
  }
}

export function messageMentionWireText(mention: ComposerMessageMentionDraft, currentHref: string): string {
  return sessionMessageDeepLink(mention.sessionId, mention.reference, mention.sourceEventId, currentHref);
}

export function activeComposerMentions(
  text: string,
  mentions: readonly ComposerMentionDraft[]
): readonly ComposerMentionDraft[] {
  return mentions.filter((mention) => mention.kind === "message" || text.includes(mention.token));
}

export function upsertComposerMention(
  mentions: readonly ComposerMentionDraft[],
  mention: ComposerMentionDraft
): readonly ComposerMentionDraft[] {
  return [...mentions.filter((candidate) => candidate.id !== mention.id), mention];
}
