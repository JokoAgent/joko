import { MessagingTransportError, type MessagingEffectCertainty } from "../types.js";

export function weChatInvalid(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

export function weChatMalformed(message: string, retryable = false): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable, effect: "none" });
}

export function weChatCancelled(message = "WeChat operation was cancelled."): MessagingTransportError {
  return new MessagingTransportError("cancelled", message, { retryable: false, effect: "none" });
}

export function weChatAuthLoss(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_credential", message, { retryable: false, effect: "none" });
}

export function weChatConflict(message: string): MessagingTransportError {
  return new MessagingTransportError("conflict", message, { retryable: false, effect: "none" });
}

export function weChatProviderRejected(message: string, retryable = false): MessagingTransportError {
  return new MessagingTransportError("provider_rejected", message, { retryable, effect: "none" });
}

export function weChatNetwork(message: string, effect: MessagingEffectCertainty = "none"): MessagingTransportError {
  return new MessagingTransportError("network", message, { retryable: effect === "none", effect });
}

export function weChatHttp(status: number, message: string, effect: MessagingEffectCertainty): MessagingTransportError {
  const retryable = effect === "none" && (status === 429 || status >= 500);
  const code = status === 401 || status === 403 ? "invalid_credential"
    : status === 429 ? "rate_limited" : status >= 500 ? "provider_unavailable" : "provider_rejected";
  return new MessagingTransportError(code, message, {
    retryable,
    effect,
    providerStatus: status
  });
}

export function mapWeChatFetchFailure(error: unknown, input: {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  readonly effect: MessagingEffectCertainty;
  readonly operation: string;
}): MessagingTransportError {
  if (error instanceof MessagingTransportError) return error;
  if (input.signal.aborted) return weChatCancelled();
  return weChatNetwork(
    input.timedOut ? `${input.operation} timed out.` : `${input.operation} failed.`,
    input.effect
  );
}
