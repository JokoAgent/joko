import { MessagingTransportError, type MessagingEffectCertainty } from "../types.js";
import type { TelegramFile } from "./model.js";

const DEFAULT_API_BASE = "https://api.telegram.org";
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOKEN_PATTERN = /^[0-9]{4,20}:[A-Za-z0-9_-]{20,256}$/u;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

export interface TelegramApiOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** HTTPS in production; HTTP is accepted only for a loopback test provider. */
  readonly apiBaseUrl?: string;
}

export interface TelegramCallOptions {
  readonly signal?: AbortSignal;
  readonly effect?: MessagingEffectCertainty;
}

interface TelegramApiEnvelope<T> {
  readonly ok?: boolean;
  readonly result?: T;
  readonly error_code?: number;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
}

export class TelegramApi {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: URL;

  constructor(options: TelegramApiOptions) {
    const token = options.token.trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw new MessagingTransportError("invalid_input", "Invalid Telegram bot token shape.", {
        retryable: false,
        effect: "none"
      });
    }
    this.#token = token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#base = parseApiBase(options.apiBaseUrl ?? DEFAULT_API_BASE);
  }

  async call<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    options: TelegramCallOptions = {}
  ): Promise<T> {
    if (!METHOD_PATTERN.test(method)) throw invalidInput("Invalid Telegram API method.");
    const response = await this.#request(
      new URL(`/bot${this.#token}/${method}`, this.#base),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      },
      options.effect ?? "none"
    );
    const bytes = await readBounded(response, MAX_API_RESPONSE_BYTES, options.effect ?? "none");
    let envelope: TelegramApiEnvelope<T>;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as TelegramApiEnvelope<T>;
    } catch {
      throw new MessagingTransportError("malformed_response", "Telegram returned malformed JSON.", {
        retryable: false,
        effect: options.effect ?? "none",
        providerStatus: response.status
      });
    }
    if (response.ok && envelope.ok === true && "result" in envelope) return envelope.result as T;
    throw providerFailure(method, response.status, envelope, options.effect ?? "none", this.#token);
  }

  async callForm<T>(
    method: string,
    form: FormData,
    options: TelegramCallOptions = {}
  ): Promise<T> {
    if (!METHOD_PATTERN.test(method)) throw invalidInput("Invalid Telegram API method.");
    const effect = options.effect ?? "none";
    const response = await this.#request(
      new URL(`/bot${this.#token}/${method}`, this.#base),
      {
        method: "POST",
        body: form,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      },
      effect
    );
    const bytes = await readBounded(response, MAX_API_RESPONSE_BYTES, effect);
    let envelope: TelegramApiEnvelope<T>;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as TelegramApiEnvelope<T>;
    } catch {
      throw new MessagingTransportError("malformed_response", "Telegram returned malformed JSON.", {
        retryable: false,
        effect,
        providerStatus: response.status
      });
    }
    if (response.ok && envelope.ok === true && "result" in envelope) return envelope.result as T;
    throw providerFailure(method, response.status, envelope, effect, this.#token);
  }

  async downloadFile(
    providerFileId: string,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    if (providerFileId.length === 0 || providerFileId.length > 512) {
      throw invalidInput("Invalid Telegram file identifier.");
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw invalidInput("Invalid Telegram download limit.");
    }
    const file = await this.call<TelegramFile>("getFile", { file_id: providerFileId }, { signal });
    const filePath = file.file_path;
    if (
      typeof filePath !== "string" || filePath.length === 0 || filePath.length > 1_024 ||
      filePath.startsWith("/") || filePath.split("/").some((part) => part === "..") ||
      !/^[A-Za-z0-9._/-]+$/u.test(filePath)
    ) {
      throw new MessagingTransportError("malformed_response", "Telegram returned an invalid file path.", {
        retryable: false,
        effect: "none"
      });
    }
    if (file.file_size !== undefined && file.file_size > maximumBytes) {
      throw payloadTooLarge();
    }
    const response = await this.#request(
      new URL(`/file/bot${this.#token}/${filePath}`, this.#base),
      { method: "GET", ...(signal === undefined ? {} : { signal }) },
      "none"
    );
    if (!response.ok) {
      throw new MessagingTransportError(
        response.status >= 500 ? "provider_unavailable" : "provider_rejected",
        `Telegram file download failed with HTTP ${response.status}.`,
        { retryable: response.status >= 500, effect: "none", providerStatus: response.status }
      );
    }
    const bytes = await readBounded(response, maximumBytes, "none");
    return {
      bytes,
      mimeType: normalizedMime(response.headers.get("content-type"))
    };
  }

  async #request(url: URL, init: RequestInit, effect: MessagingEffectCertainty): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (error instanceof MessagingTransportError) throw error;
      if (init.signal?.aborted || isAbortError(error)) {
        throw new MessagingTransportError("cancelled", "Telegram request was cancelled.", {
          retryable: false,
          effect
        });
      }
      throw new MessagingTransportError("network", "Telegram request failed before a response was available.", {
        retryable: true,
        effect
      });
    }
  }
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  effect: MessagingEffectCertainty
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    throw payloadTooLarge(effect);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw payloadTooLarge(effect);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function providerFailure<T>(
  method: string,
  httpStatus: number,
  envelope: TelegramApiEnvelope<T>,
  effect: MessagingEffectCertainty,
  token: string
): MessagingTransportError {
  const status = Number.isSafeInteger(envelope.error_code) ? envelope.error_code as number : httpStatus;
  const description = sanitizeProviderDescription(envelope.description, token);
  const retryAfterSeconds = envelope.parameters?.retry_after;
  const retryAfterMs = typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
    ? Math.min(Math.ceil(retryAfterSeconds * 1_000), 24 * 60 * 60 * 1_000)
    : undefined;
  if (status === 401 || (status === 404 && method === "getMe")) {
    return new MessagingTransportError("invalid_credential", `Telegram rejected the credential: ${description}`, {
      retryable: false,
      effect,
      providerStatus: status
    });
  }
  if (status === 409) {
    return new MessagingTransportError("conflict", `Telegram reported a polling conflict: ${description}`, {
      retryable: true,
      effect,
      providerStatus: status
    });
  }
  if (status === 429) {
    return new MessagingTransportError("rate_limited", `Telegram rate limited the request: ${description}`, {
      retryable: true,
      effect,
      providerStatus: status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    });
  }
  const unavailable = status >= 500;
  return new MessagingTransportError(
    unavailable ? "provider_unavailable" : "provider_rejected",
    `Telegram API rejected the request: ${description}`,
    { retryable: unavailable, effect, providerStatus: status }
  );
}

function parseApiBase(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidInput("Invalid Telegram API base URL.");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
  ) {
    throw invalidInput("Telegram API base URL must be HTTPS or an HTTP loopback URL.");
  }
  return parsed;
}

function sanitizeProviderDescription(value: string | undefined, token: string): string {
  const fallback = "provider error";
  if (typeof value !== "string") return fallback;
  const redacted = value.replaceAll(token, "[redacted]").replace(/[\r\n\t]+/gu, " ").trim();
  return redacted.slice(0, 256) || fallback;
}

function normalizedMime(value: string | null): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime)
    ? mime
    : "application/octet-stream";
}

function payloadTooLarge(effect: MessagingEffectCertainty = "none"): MessagingTransportError {
  return new MessagingTransportError("payload_too_large", "Telegram payload exceeded the configured size limit.", {
    retryable: false,
    effect
  });
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
