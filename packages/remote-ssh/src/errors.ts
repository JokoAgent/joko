export type RemoteSshErrorCode =
  | "ABORTED"
  | "AUTHENTICATION_FAILED"
  | "CONFIG_CONFLICT"
  | "CONFIG_INVALID"
  | "CONFIG_IO"
  | "CONNECTION_FAILED"
  | "CONNECTION_TIMEOUT"
  | "CONNECTOR_PROTOCOL"
  | "CONNECTOR_UNAVAILABLE"
  | "EXECUTION_FAILED"
  | "EXECUTION_PROTOCOL"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_UNAVAILABLE"
  | "FILE_TRANSFER_FAILED"
  | "FILE_TRANSFER_UNAVAILABLE"
  | "FORWARDING_FAILED"
  | "FORWARDING_UNAVAILABLE"
  | "HOST_KEY_CHANGED"
  | "HOST_KEY_CONFLICT"
  | "HOST_KEY_INVALID"
  | "HOST_KEY_MISSING"
  | "HOST_KEY_STORE_CORRUPT"
  | "HOST_KEY_STORE_MISSING"
  | "HOST_KEY_STORE_UNREADABLE"
  | "HOST_KEY_STORE_WRITE_FAILED"
  | "INVALID_ARGUMENT"
  | "OWNER_SCOPE_MISMATCH";

export interface RemoteSshErrorShape {
  readonly code: RemoteSshErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, boolean | number | string>>;
}

const RETRYABLE_CODES: ReadonlySet<RemoteSshErrorCode> = new Set([
  "ABORTED",
  "CONNECTION_FAILED",
  "CONNECTION_TIMEOUT",
  "CONNECTOR_UNAVAILABLE",
  "EXECUTION_FAILED",
  "EXECUTION_TIMEOUT",
  "FILE_TRANSFER_FAILED",
  "FORWARDING_FAILED"
]);

export function isRemoteSshErrorRetryable(code: RemoteSshErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export class RemoteSshError extends Error {
  readonly code: RemoteSshErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, boolean | number | string>> | undefined;

  constructor(
    code: RemoteSshErrorCode,
    message: string,
    _retryable: boolean,
    details?: Readonly<Record<string, boolean | number | string>>
  ) {
    super(message);
    this.name = "RemoteSshError";
    this.code = code;
    this.retryable = isRemoteSshErrorRetryable(code);
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }

  toJSON(): RemoteSshErrorShape {
    return Object.freeze({
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details })
    });
  }
}

export function isRemoteSshError(value: unknown): value is RemoteSshError {
  return value instanceof RemoteSshError;
}

export function safeRemoteSshError(error: unknown): RemoteSshError {
  if (isRemoteSshError(error)) return error;
  return new RemoteSshError(
    "CONNECTION_FAILED",
    "The SSH connection failed safely.",
    true
  );
}
