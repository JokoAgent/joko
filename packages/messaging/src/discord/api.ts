import {
  MessagingTransportError,
  type MessagingEffectCertainty
} from "../types.js";
import type {
  DiscordChannel,
  DiscordGatewayBot,
  DiscordInteraction,
  DiscordMessage,
  DiscordUser
} from "./model.js";

const DEFAULT_API_BASE = "https://discord.com/api/v10/";
const MAXIMUM_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_DOWNLOAD_REDIRECTS = 3;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{24,256}$/u;
const INTERACTION_TOKEN_PATTERN = /^[A-Za-z0-9._-]{16,512}$/u;

export interface DiscordApiOptions {
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  /** HTTPS in production; HTTP is accepted only for an isolated loopback provider. */
  readonly apiBaseUrl?: string;
}

export interface DiscordRequestOptions {
  readonly signal?: AbortSignal;
  readonly effect?: MessagingEffectCertainty;
}

export class DiscordApi {
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #base: URL;
  readonly #loopbackOrigin: string | null;

  constructor(options: DiscordApiOptions) {
    const token = options.token.trim();
    if (!TOKEN_PATTERN.test(token)) throw invalidInput("Invalid Discord bot token shape.");
    this.#token = token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw invalidInput("Discord HTTP transport is unavailable.");
    this.#base = parseApiBase(options.apiBaseUrl ?? DEFAULT_API_BASE);
    this.#loopbackOrigin = isLoopback(this.#base) ? this.#base.origin : null;
  }

  get allowsLoopbackProvider(): boolean {
    return this.#loopbackOrigin !== null;
  }

  currentUser(signal?: AbortSignal): Promise<DiscordUser> {
    return this.requestJson<DiscordUser>("GET", "users/@me", undefined, { signal });
  }

  gatewayBot(signal?: AbortSignal): Promise<DiscordGatewayBot> {
    return this.requestJson("GET", "gateway/bot", undefined, { signal });
  }

  createOwnerDm(ownerUserId: string, signal?: AbortSignal): Promise<DiscordChannel> {
    return this.requestJson("POST", "users/@me/channels", { recipient_id: ownerUserId }, {
      signal,
      effect: "unknown"
    });
  }

  channel(channelId: string, signal?: AbortSignal): Promise<DiscordChannel> {
    return this.requestJson("GET", `channels/${channelId}`, undefined, { signal });
  }

  message(channelId: string, messageId: string, signal?: AbortSignal): Promise<DiscordMessage> {
    return this.requestJson("GET", `channels/${channelId}/messages/${messageId}`, undefined, { signal });
  }

  sendMessage(channelId: string, payload: unknown, signal?: AbortSignal): Promise<DiscordMessage> {
    return this.requestJson("POST", `channels/${channelId}/messages`, payload, {
      signal,
      effect: "unknown"
    });
  }

  sendMessageForm(channelId: string, form: FormData, signal?: AbortSignal): Promise<DiscordMessage> {
    return this.requestForm("POST", `channels/${channelId}/messages`, form, {
      signal,
      effect: "unknown"
    });
  }

  editMessage(channelId: string, messageId: string, payload: unknown, signal?: AbortSignal): Promise<DiscordMessage> {
    return this.requestJson("PATCH", `channels/${channelId}/messages/${messageId}`, payload, {
      signal,
      effect: "unknown"
    });
  }

  async typing(channelId: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson("POST", `channels/${channelId}/typing`, undefined, {
      signal,
      effect: "unknown"
    });
  }

  async addReaction(channelId: string, messageId: string, emoji: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson(
      "PUT",
      `channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      undefined,
      { signal, effect: "unknown" }
    );
  }

  async removeReaction(channelId: string, messageId: string, emoji: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson(
      "DELETE",
      `channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
      undefined,
      { signal, effect: "unknown" }
    );
  }

  async acknowledgeInteraction(interaction: DiscordInteraction): Promise<void> {
    const token = interaction.token;
    if (typeof token !== "string" || !INTERACTION_TOKEN_PATTERN.test(token)) {
      throw invalidInput("Discord interaction token is invalid.");
    }
    await this.requestJson(
      "POST",
      `interactions/${interaction.id}/${token}/callback`,
      { type: 6 },
      { effect: "unknown", redact: token }
    );
  }

  async download(
    source: string,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw invalidInput("Invalid Discord download limit.");
    let url = this.#cdnUrl(source);
    for (let redirects = 0; redirects <= MAXIMUM_DOWNLOAD_REDIRECTS; redirects += 1) {
      const response = await this.#request(url, {
        method: "GET",
        redirect: "manual",
        ...(signal === undefined ? {} : { signal })
      }, "none");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null || redirects === MAXIMUM_DOWNLOAD_REDIRECTS) {
          throw new MessagingTransportError("provider_rejected", "Discord attachment redirect was rejected.", {
            retryable: false,
            effect: "none",
            providerStatus: response.status
          });
        }
        url = this.#cdnUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw providerFailure(response.status, undefined, "none", this.#token);
      const bytes = await readBounded(response, maximumBytes, "none");
      return { bytes, mimeType: normalizedMime(response.headers.get("content-type")) };
    }
    throw new MessagingTransportError("provider_rejected", "Discord attachment redirect was rejected.", {
      retryable: false,
      effect: "none"
    });
  }

  async requestJson<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    options: DiscordRequestOptions & { readonly redact?: string } = {}
  ): Promise<T> {
    const effect = options.effect ?? "none";
    const response = await this.#request(this.#apiUrl(path), {
      method,
      headers: {
        authorization: `Bot ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }, effect);
    if (response.status === 204) return undefined as T;
    const bytes = await readBounded(response, MAXIMUM_API_RESPONSE_BYTES, effect);
    const parsed = parseJson(bytes);
    if (response.ok) {
      if (parsed === undefined) throw malformed(effect, response.status);
      return parsed as T;
    }
    throw providerFailure(response.status, parsed, effect, options.redact ?? this.#token);
  }

  async requestForm<T>(
    method: "POST" | "PATCH",
    path: string,
    form: FormData,
    options: DiscordRequestOptions = {}
  ): Promise<T> {
    const effect = options.effect ?? "none";
    const response = await this.#request(this.#apiUrl(path), {
      method,
      headers: { authorization: `Bot ${this.#token}` },
      body: form,
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }, effect);
    const bytes = await readBounded(response, MAXIMUM_API_RESPONSE_BYTES, effect);
    const parsed = parseJson(bytes);
    if (response.ok && parsed !== undefined) return parsed as T;
    if (response.ok) throw malformed(effect, response.status);
    throw providerFailure(response.status, parsed, effect, this.#token);
  }

  async #request(url: URL, init: RequestInit, effect: MessagingEffectCertainty): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (error instanceof MessagingTransportError) throw error;
      if (init.signal?.aborted || isAbortError(error)) {
        throw new MessagingTransportError("cancelled", "Discord request was cancelled.", {
          retryable: false,
          effect
        });
      }
      throw new MessagingTransportError("network", "Discord request failed before a response was available.", {
        retryable: true,
        effect
      });
    }
  }

  #apiUrl(path: string): URL {
    if (
      path.length === 0 || path.length > 2_048 || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some((part) => part === "..") || /[\u0000-\u001f\u007f?#]/u.test(path)
    ) throw invalidInput("Invalid Discord API path.");
    const url = new URL(path, this.#base);
    if (url.origin !== this.#base.origin || !url.pathname.startsWith(this.#base.pathname)) {
      throw invalidInput("Invalid Discord API path.");
    }
    return url;
  }

  #cdnUrl(source: string): URL {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw invalidInput("Invalid Discord attachment URL.");
    }
    const official = url.protocol === "https:" &&
      (url.hostname === "cdn.discordapp.com" || url.hostname === "media.discordapp.net");
    const loopback = this.#loopbackOrigin !== null && url.origin === this.#loopbackOrigin && url.protocol === this.#base.protocol;
    if (!official && !loopback) throw invalidInput("Discord attachment URL is not an approved CDN origin.");
    if (url.username !== "" || url.password !== "" || url.hash !== "") {
      throw invalidInput("Invalid Discord attachment URL.");
    }
    return url;
  }
}

function parseApiBase(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidInput("Invalid Discord API base URL.");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  const loopback = isLoopback(parsed);
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== ""
  ) throw invalidInput("Discord API base URL must be HTTPS or an HTTP loopback URL.");
  return parsed;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  effect: MessagingEffectCertainty
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
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
        await reader.cancel().catch(() => undefined);
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

function parseJson(bytes: Uint8Array): unknown | undefined {
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function providerFailure(
  status: number,
  body: unknown,
  effect: MessagingEffectCertainty,
  redact: string
): MessagingTransportError {
  const description = providerDescription(body, redact);
  if (status === 401) {
    return new MessagingTransportError("invalid_credential", `Discord rejected the credential: ${description}`, {
      retryable: false,
      effect,
      providerStatus: status
    });
  }
  if (status === 429) {
    const retryAfterMs = retryAfter(body);
    return new MessagingTransportError("rate_limited", `Discord rate limited the request: ${description}`, {
      retryable: true,
      effect,
      providerStatus: status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    });
  }
  const unavailable = status >= 500;
  return new MessagingTransportError(
    unavailable ? "provider_unavailable" : "provider_rejected",
    `Discord API rejected the request: ${description}`,
    { retryable: unavailable, effect, providerStatus: status }
  );
}

function providerDescription(body: unknown, redact: string): string {
  const value = isRecord(body) && typeof body["message"] === "string" ? body["message"] : "provider error";
  return value.replaceAll(redact, "[redacted]").replace(/[\r\n\t]+/gu, " ").trim().slice(0, 256) || "provider error";
}

function retryAfter(body: unknown): number | undefined {
  const value = isRecord(body) ? body["retry_after"] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.ceil(value * 1_000), 24 * 60 * 60 * 1_000);
}

function normalizedMime(value: string | null): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime)
    ? mime
    : "application/octet-stream";
}

function malformed(effect: MessagingEffectCertainty, status?: number): MessagingTransportError {
  return new MessagingTransportError("malformed_response", "Discord returned a malformed response.", {
    retryable: false,
    effect,
    ...(status === undefined ? {} : { providerStatus: status })
  });
}

function payloadTooLarge(effect: MessagingEffectCertainty): MessagingTransportError {
  return new MessagingTransportError("payload_too_large", "Discord payload exceeded the configured size limit.", {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
