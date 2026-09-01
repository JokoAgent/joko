import { JokoError, redactSecrets, type PublicError } from "@joko/core";

export type PiErrorPhase =
  | "probe"
  | "provision"
  | "spawn"
  | "handshake"
  | "dispatch"
  | "stream"
  | "interaction"
  | "session"
  | "resource"
  | "shutdown";

export class PiAdapterError extends JokoError {
  constructor(error: PublicError, options?: ErrorOptions) {
    super({ ...error, message: redactSecrets(error.message) }, options);
    this.name = "PiAdapterError";
  }
}

export function piError(
  code: string,
  message: string,
  phase: PiErrorPhase,
  options: {
    readonly retryable?: boolean;
    readonly stateMayHaveChanged?: boolean;
    readonly recovery?: string;
    readonly cause?: unknown;
  } = {}
): PiAdapterError {
  return new PiAdapterError(
    {
      code,
      message: redactSecrets(message),
      phase,
      retryable: options.retryable ?? false,
      stateMayHaveChanged: options.stateMayHaveChanged ?? false,
      recovery: options.recovery ?? "Inspect adapter diagnostics and retry after correcting the reported condition."
    },
    options.cause === undefined ? undefined : { cause: options.cause }
  );
}

export function asPiError(
  error: unknown,
  fallback: {
    readonly code: string;
    readonly phase: PiErrorPhase;
    readonly retryable?: boolean;
    readonly stateMayHaveChanged?: boolean;
    readonly recovery?: string;
  },
  managedSecrets: readonly string[] = []
): PiAdapterError {
  const typed = error instanceof PiAdapterError
    ? error
    : error instanceof JokoError
      ? new PiAdapterError(error.publicError, { cause: error })
      : piError(
          fallback.code,
          error instanceof Error ? error.message : "Unknown Pi adapter error",
          fallback.phase,
          { ...fallback, cause: error }
        );
  if (managedSecrets.length === 0) return typed;
  // A native Error cause is diagnostics data too. Rebuild without the raw
  // cause whenever runtime-scoped redaction is active so a credential cannot
  // survive only in the error chain after its public message was sanitized.
  return new PiAdapterError({
    ...typed.publicError,
    message: redactManagedSecrets(typed.publicError.message, managedSecrets),
    recovery: redactManagedSecrets(typed.publicError.recovery, managedSecrets)
  });
}

export function redactedDiagnostic(error: unknown): string {
  if (error instanceof JokoError) return `${error.publicError.code}: ${redactSecrets(error.publicError.message)}`;
  if (error instanceof Error) return redactSecrets(error.message);
  return "Unknown error";
}

export function redactManagedSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  const unique = [...new Set(secrets.filter((secret) => secret.length > 0))].sort((left, right) => right.length - left.length);
  for (const secret of unique) redacted = redacted.split(secret).join("[REDACTED]");
  return redactSecrets(redacted);
}
