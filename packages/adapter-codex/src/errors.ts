import { JokoError, type PublicError } from "@joko/core";

export type CodexFailurePhase = "probe" | "provision" | "dispatch" | "stream" | "interaction" | "shutdown";

export function adapterError(input: {
  readonly code: string;
  readonly message: string;
  readonly phase: CodexFailurePhase;
  readonly retryable?: boolean;
  readonly stateMayHaveChanged?: boolean;
  readonly recovery: string;
}): JokoError {
  return new JokoError({
    code: input.code,
    message: input.message,
    phase: input.phase,
    retryable: input.retryable ?? false,
    stateMayHaveChanged: input.stateMayHaveChanged ?? false,
    recovery: input.recovery
  });
}

/** Native tags and numeric HTTP status are the only data admitted to the public failure category. */
export function publicNativeTurnError(error: unknown): PublicError {
  const record = objectRecord(error), info = record?.["codexErrorInfo"], variant = objectRecord(info);
  const keys = variant === undefined ? [] : Object.keys(variant);
  const tag = typeof info === "string" ? info : keys.length === 1 ? keys[0] : undefined;
  const details = variant !== undefined && tag !== undefined ? objectRecord(variant[tag]) : undefined;
  const networkTag = tag === "httpConnectionFailed" || tag === "responseStreamConnectionFailed" || tag === "responseStreamDisconnected";
  const rawStatus = networkTag || tag === "responseTooManyFailedAttempts" ? details?.["httpStatusCode"] : undefined;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined;
  const code = tag === "usageLimitExceeded" || tag === "sessionBudgetExceeded" ? "QUOTA_EXCEEDED"
    : tag === "unauthorized" || status === 401 || status === 403 ? "AUTH_REQUIRED"
    : tag === "serverOverloaded" || status === 529 ? "UPSTREAM_OVERLOADED"
    : status === 402 ? "QUOTA_EXCEEDED"
    : status === 429 ? "RATE_LIMITED"
    : networkTag ? "NETWORK_ERROR"
    : "CODEX_TURN_FAILED";
  const messages: Record<typeof code, string> = {
    AUTH_REQUIRED: "Codex authentication is required.",
    QUOTA_EXCEEDED: "The active Codex account reached its usage or session budget limit.",
    RATE_LIMITED: "The Codex provider temporarily limited requests.",
    UPSTREAM_OVERLOADED: "The Codex model service is temporarily busy.",
    NETWORK_ERROR: "Codex could not maintain its provider connection.",
    CODEX_TURN_FAILED: "The Codex turn failed."
  };
  return {
    code,
    message: messages[code],
    phase: "stream",
    retryable: code !== "AUTH_REQUIRED",
    stateMayHaveChanged: true,
    recovery: code === "AUTH_REQUIRED"
      ? "Sign in to the Codex account and explicitly retry the queued input."
      : "Inspect the durable timeline and explicitly retry only if another native turn is safe."
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class TransportFault extends Error {
  readonly code: "not_started" | "spawn_failed" | "request_timeout" | "protocol_violation" | "buffer_overflow" | "process_exited" | "write_failed" | "closed" | "shutdown_unconfirmed";
  readonly stateMayHaveChanged: boolean;

  constructor(
    code: TransportFault["code"],
    message: string,
    options: { readonly stateMayHaveChanged?: boolean } = {}
  ) {
    super(message);
    this.name = "TransportFault";
    this.code = code;
    this.stateMayHaveChanged = options.stateMayHaveChanged ?? false;
  }
}

export class RpcRemoteFault extends Error {
  readonly rpcCode: number;
  readonly archivedResumeThreadId: string | undefined;

  constructor(rpcCode: number, archivedResumeThreadId?: string) {
    super("The Codex app-server rejected the request.");
    this.name = "RpcRemoteFault";
    this.rpcCode = rpcCode;
    this.archivedResumeThreadId = archivedResumeThreadId;
  }
}

/** Retain only an exact protocol refusal; remote error text/data can contain secrets. */
export function remoteRpcFault(code: number, message: unknown, data: unknown, resumeThreadId?: string): RpcRemoteFault {
  const archived = code === -32600 && data === undefined && resumeThreadId !== undefined
    && message === `session ${resumeThreadId} is archived. Run \`codex unarchive ${resumeThreadId}\` to unarchive it first.`;
  return new RpcRemoteFault(code, archived ? resumeThreadId : undefined);
}

export function isAmbiguousDispatchFailure(error: unknown): boolean {
  return error instanceof TransportFault && error.stateMayHaveChanged;
}
