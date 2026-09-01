import { LspToolError } from "./errors.js";
import type { LspCallOptions } from "./types.js";

export const MAXIMUM_OPERATION_TIMEOUT_MS = 120_000;

export class LspOperationControl {
  readonly signal: AbortSignal | undefined;
  readonly deadlineAtMs: number;
  readonly #now: () => number;

  constructor(
    options: LspCallOptions | undefined,
    defaultTimeoutMs: number,
    now: () => number = Date.now
  ) {
    this.signal = options?.signal;
    this.#now = now;
    const timeoutMs = validateTimeout(options?.timeoutMs ?? defaultTimeoutMs, "timeoutMs");
    const relativeDeadline = now() + timeoutMs;
    const explicitDeadline = options?.deadlineAtMs;
    if (explicitDeadline !== undefined && (!Number.isSafeInteger(explicitDeadline) || explicitDeadline < 0)) {
      throw new LspToolError("INVALID_ARGUMENT", "deadlineAtMs must be a non-negative safe integer.", {
        field: "deadlineAtMs"
      });
    }
    this.deadlineAtMs = explicitDeadline === undefined
      ? relativeDeadline
      : Math.min(relativeDeadline, explicitDeadline);
  }

  check(): void {
    if (this.signal?.aborted === true) {
      throw new LspToolError("ABORTED", "The LSP operation was aborted.");
    }
    if (this.#now() >= this.deadlineAtMs) {
      throw new LspToolError("DEADLINE_EXCEEDED", "The LSP operation exceeded its deadline.");
    }
  }

  cancellationRequested(): boolean {
    return this.signal?.aborted === true || this.#now() >= this.deadlineAtMs;
  }
}

export function validateTimeout(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_OPERATION_TIMEOUT_MS) {
    throw new LspToolError(
      "INVALID_ARGUMENT",
      `${field} must be an integer from 1 through ${MAXIMUM_OPERATION_TIMEOUT_MS}.`,
      { field, maximum: MAXIMUM_OPERATION_TIMEOUT_MS }
    );
  }
  return value;
}
