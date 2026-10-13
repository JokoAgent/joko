export type ClipboardSyncFailureReason =
  | "empty" | "unsupported" | "too-large" | "changed" | "conflict" | "expired"
  | "unavailable" | "permission" | "temporary-focus" | "write-failed" | "outcome-unknown" | "unknown";

/** Metadata only. Adapters map native/wire errors without retaining raw content. */
export class ClipboardSyncError extends Error {
  constructor(readonly reason: ClipboardSyncFailureReason) {
    super(`Remote Desktop clipboard sync ${reason}.`);
    this.name = "ClipboardSyncError";
  }
}

export interface ClipboardSyncFailure {
  readonly reason: ClipboardSyncFailureReason;
  readonly notice: "permission" | "conflict" | "failed";
  readonly delay: number | null;
}

export function getClipboardSyncFailure(error: unknown, failures: number): ClipboardSyncFailure {
  const reason = error instanceof ClipboardSyncError ? error.reason : "unknown";
  if (reason === "permission") return { reason, notice: "permission", delay: null };
  if (reason === "outcome-unknown") return { reason, notice: "failed", delay: null };
  if (reason === "changed" || reason === "conflict") return { reason, notice: "conflict", delay: 1_500 };
  const count = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0;
  return { reason, notice: "failed", delay: Math.min(30_000, 1_500 * 2 ** Math.min(count, 5)) };
}
