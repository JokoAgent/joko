import type { Event } from "./gen/joko/v1/event_pb.js";

export function codexRetryProgressKind(code: string | undefined): "reconnect" | "capacity" | "rate-limit" | undefined {
  if (code === "CODEX_NATIVE_RECONNECT") return "reconnect";
  if (code === "CODEX_CAPACITY_BACKOFF") return "capacity";
  if (code === "CODEX_RATE_LIMIT_BACKOFF") return "rate-limit";
  return undefined;
}

/** A terminal status identifies a received Codex item, not a completed native entry. */
export function codexSamplingInterruptedMessageId(status: { readonly statusId: string; readonly terminal: boolean }): string | undefined {
  const prefix = "codex_sampling_interrupted:";
  if (!status.terminal || !status.statusId.startsWith(prefix)) return undefined;
  const id = status.statusId.slice(prefix.length);
  return id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id) ? id : undefined;
}

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

/** A live thinking block can be adopted only by its exact source owner. */
export function thinkingStreamOwner(event: Event): string | undefined {
  const attempt = assistantStreamAttempt(event);
  const identity = event.identity;
  return attempt === undefined || !identity?.backendId || !identity.targetId ? undefined
    : JSON.stringify([identity.backendId, identity.targetId, attempt]);
}
