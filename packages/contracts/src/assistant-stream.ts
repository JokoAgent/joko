import type { Event } from "./gen/joko/v1/event_pb.js";

export function isClaudeStreamBlock(messageId: string): boolean {
  return /^claude-block-(?:[0-9a-f-]{36}-)?\d+-\d+$/u.test(messageId);
}

export function isAssistantStreamBlock(messageId: string): boolean {
  return isClaudeStreamBlock(messageId)
    || /^assistant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+-\d+$/u.test(messageId);
}

/** A completion replaces temporary stream blocks from the same Run attempt only. */
export function assistantStreamAttempt(event: Event): string | undefined {
  const identity = event.identity;
  if (!identity?.sessionId || !identity.runId || !identity.attemptId || !event.cursor) return undefined;
  return JSON.stringify([
    identity.sessionId, identity.runId, identity.attemptId,
    identity.generation.toString(), event.cursor.generation.toString()
  ]);
}
