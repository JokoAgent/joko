import { JokoError } from "@joko/core";

const PI_COMPACTION_NOOP_REJECTIONS = new Set([
  "Already compacted",
  "Nothing to compact (session too small)"
]);

export function isPiCompactionNoopMessage(value: unknown): boolean {
  return typeof value === "string" && PI_COMPACTION_NOOP_REJECTIONS.has(value.trim());
}

export function isPiCompactionNoopRejection(error: unknown): boolean {
  return error instanceof JokoError
    && error.publicError.code === "PI_RPC_REJECTED"
    && isPiCompactionNoopMessage(error.publicError.message);
}

export function isPiCompactionNoopEvent(event: Record<string, unknown>): boolean {
  if (
    event.reason !== "manual"
    || event.result !== undefined
    || event.aborted !== false
    || event.willRetry !== false
    || typeof event.errorMessage !== "string"
  ) return false;
  const prefix = "Compaction failed: ";
  return event.errorMessage.startsWith(prefix)
    && isPiCompactionNoopMessage(event.errorMessage.slice(prefix.length));
}
