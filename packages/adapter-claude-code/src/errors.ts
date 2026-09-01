import { JokoError, type PublicError } from "@joko/core";

export class ClaudeCodeAdapterError extends JokoError {}

export function claudeCodeError(
  code: string,
  message: string,
  phase: string,
  options: Partial<Pick<PublicError, "retryable" | "stateMayHaveChanged" | "recovery">> = {}
): ClaudeCodeAdapterError {
  return new ClaudeCodeAdapterError({
    code,
    message,
    phase,
    retryable: options.retryable ?? false,
    stateMayHaveChanged: options.stateMayHaveChanged ?? false,
    recovery: options.recovery ?? "Inspect the native session before retrying."
  });
}
