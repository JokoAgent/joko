import { WorktreeServiceError } from "./errors.js";
import type { WorktreeCallOptions } from "./types.js";

export const DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS = 120_000;
export const MAXIMUM_WORKTREE_OPERATION_TIMEOUT_MS = 10 * 60_000;

export class WorktreeOperationControl {
  readonly signal: AbortSignal | undefined;
  readonly #deadline: number;
  readonly #now: () => number;

  constructor(
    options: WorktreeCallOptions | undefined,
    defaultTimeoutMs: number,
    now: () => number = Date.now
  ) {
    this.signal = options?.signal;
    this.#now = now;
    const timeoutMs = validateWorktreeTimeout(options?.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
    this.#deadline = now() + timeoutMs;
  }

  check(): void {
    if (this.signal?.aborted === true) {
      throw new WorktreeServiceError("ABORTED", "The worktree operation was aborted.");
    }
    if (this.#now() >= this.#deadline) {
      throw new WorktreeServiceError("OPERATION_TIMEOUT", "The worktree operation exceeded its deadline.");
    }
  }

  remaining(maximumMs: number): number {
    this.check();
    return Math.max(1, Math.min(maximumMs, this.#deadline - this.#now()));
  }
}

export function validateWorktreeTimeout(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1
    || (value as number) > MAXIMUM_WORKTREE_OPERATION_TIMEOUT_MS) {
    throw new WorktreeServiceError(
      "INVALID_ARGUMENT",
      `${field} must be a positive bounded integer.`,
      { field, maximum: MAXIMUM_WORKTREE_OPERATION_TIMEOUT_MS }
    );
  }
  return value as number;
}
