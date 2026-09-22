import { randomUUID } from "node:crypto";

import { MessagingTransportError } from "../types.js";

const DEFAULT_API_BASE_URL = "https://api.dingtalk.com";
const DEFAULT_OAPI_BASE_URL = "https://oapi.dingtalk.com";
const MAXIMUM_JSON_BYTES = 1024 * 1024;
const MAXIMUM_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
export const DINGTALK_MAXIMUM_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface DingTalkApiOptions {
  readonly appKey: string;
  readonly appSecret: string;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly oapiBaseUrl?: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface DingTalkGatewayConnection {
  readonly endpoint: string;
  readonly ticket: string;
}

export interface DingTalkOutboundTarget {
  readonly kind: "direct" | "group";
  readonly id: string;
  readonly sessionWebhook: string | null;
  readonly sessionWebhookExpiresAt: number | null;
}

export interface DingTalkOutboundAttachment {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

export class DingTalkApi {
  readonly #appKey: string;
  readonly #appSecret: string;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: URL;
  readonly #oapiBaseUrl: URL;
  readonly #allowLoopbackProvider: boolean;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #active = new Set<AbortController>();
  #accessToken: CachedAccessToken | null = null;
  #oapiAccessToken: CachedAccessToken | null = null;
  #closed = false;

  constructor(options: DingTalkApiOptions) {
    this.#appKey = requiredSecret(options.appKey, "app key", 256);
    this.#appSecret = requiredSecret(options.appSecret, "app secret", 512);
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = serviceBase(options.apiBaseUrl ?? DEFAULT_API_BASE_URL, "API");
    this.#oapiBaseUrl = serviceBase(options.oapiBaseUrl ?? DEFAULT_OAPI_BASE_URL, "OAPI");
    this.#allowLoopbackProvider = isLoopback(this.#apiBaseUrl.hostname) && isLoopback(this.#oapiBaseUrl.hostname);
    if (!this.#allowLoopbackProvider && (
      this.#apiBaseUrl.origin !== DEFAULT_API_BASE_URL || this.#oapiBaseUrl.origin !== DEFAULT_OAPI_BASE_URL
    )) {
      throw invalidInput("DingTalk provider endpoints are invalid.");
    }
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  get allowsLoopbackProvider(): boolean {
    return this.#allowLoopbackProvider;
  }

  async validateCredentials(signal?: AbortSignal): Promise<void> {
    await this.#modernAccessToken(signal);
  }

  async openGateway(signal?: AbortSignal): Promise<DingTalkGatewayConnection> {
    const payload = await this.#postJson(
      new URL("/v1.0/gateway/connections/open", this.#apiBaseUrl),
      {
        clientId: this.#appKey,
        clientSecret: this.#appSecret,
        ua: "Joko",
        subscriptions: [{ type: "CALLBACK", topic: "/v1.0/im/bot/messages/get" }]
      },
      { signal, credentialRequest: true, effect: "none" }
    );
    const endpoint = stringField(payload, "endpoint");
    const ticket = stringField(payload, "ticket");
    if (endpoint === null || ticket === null || ticket.length > 4_096) {
      throw malformed("DingTalk Gateway returned an invalid connection ticket.");
    }
    return { endpoint: gatewayEndpoint(endpoint, this.#allowLoopbackProvider), ticket };
  }

  async sendText(
    target: DingTalkOutboundTarget,
    text: string,
    signal?: AbortSignal
  ): Promise<string> {
    const webhook = this.#usableSessionWebhook(target);
    if (webhook !== null) {
      try {
        const payload = await this.#postJson(webhook, {
          msgtype: "text",
          text: { content: text }
        }, { signal, effect: "unknown" });
        return providerMessageId(payload) ?? `dingtalk:${this.#idFactory()}`;
      } catch (error) {
        if (!(error instanceof MessagingTransportError) || error.options.effect !== "none") throw error;
      }
    }
    const payload = await this.#sendProactive(target, "sampleText", { content: text }, signal);
    return providerMessageId(payload) ?? `dingtalk:${this.#idFactory()}`;
  }

  async sendAttachment(
    target: DingTalkOutboundTarget,
    attachment: DingTalkOutboundAttachment,
    signal?: AbortSignal
  ): Promise<string> {
    const normalized = validateOutboundAttachment(attachment);
    const mediaId = await this.#uploadMedia(normalized, signal);
    const message = normalized.kind === "image"
      ? { key: "sampleImageMsg", parameter: { photoURL: `@${mediaId}` } }
      : {
          key: "sampleFile",
          parameter: {
            mediaId: `@${mediaId}`,
            fileName: normalized.fileName,
            fileType: fileType(normalized.fileName, normalized.mimeType),
            fileSize: normalized.bytes.byteLength
          }
        };
    const payload = await this.#sendProactive(target, message.key, message.parameter, signal);
    return providerMessageId(payload) ?? `dingtalk:${this.#idFactory()}`;
  }

  async downloadAttachment(
    downloadCode: string,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    const boundedMaximum = boundedInteger(
      maximumBytes,
      1,
      DINGTALK_MAXIMUM_ATTACHMENT_BYTES,
      "attachment limit"
    );
    const token = await this.#modernAccessToken(signal);
    const payload = await this.#postJson(
      new URL("/v1.0/robot/messageFiles/download", this.#apiBaseUrl),
      { downloadCode: requiredSecret(downloadCode, "download code", 4_096), robotCode: this.#appKey },
      { signal, accessToken: token, effect: "none" }
    );
    const rawUrl = stringField(payload, "downloadUrl");
    if (rawUrl === null) throw malformed("DingTalk media response omitted its download URL.");
    let current = trustedMediaUrl(rawUrl, this.#allowLoopbackProvider, this.#apiBaseUrl, this.#oapiBaseUrl);
    for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
      const response = await this.#request(current, { method: "GET", redirect: "manual" }, signal, "none");
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (location === null || redirects === MAXIMUM_REDIRECTS) {
          throw providerRejected("DingTalk media redirect is invalid.");
        }
        current = trustedMediaUrl(
          new URL(location, current).toString(),
          this.#allowLoopbackProvider,
          this.#apiBaseUrl,
          this.#oapiBaseUrl
        );
        continue;
      }
      if (!response.ok) throw responseFailure(response, "DingTalk media download failed.", "none");
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > boundedMaximum) throw tooLarge("DingTalk attachment is too large.");
      const bytes = await readBodyLimited(response, boundedMaximum);
      if (bytes.byteLength === 0) throw malformed("DingTalk returned an empty attachment.");
      return {
        bytes,
        mimeType: normalizedMime(response.headers.get("content-type") ?? "application/octet-stream")
      };
    }
    throw providerRejected("DingTalk media redirect is invalid.");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#accessToken = null;
    this.#oapiAccessToken = null;
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
  }

  async #sendProactive(
    target: DingTalkOutboundTarget,
    msgKey: string,
    msgParam: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const token = await this.#modernAccessToken(signal);
    const group = target.kind === "group";
    return this.#postJson(
      new URL(group ? "/v1.0/robot/groupMessages/send" : "/v1.0/robot/oToMessages/batchSend", this.#apiBaseUrl),
      {
        robotCode: this.#appKey,
        ...(group ? { openConversationId: target.id } : { userIds: [target.id] }),
        msgKey,
        msgParam: JSON.stringify(msgParam)
      },
      { signal, accessToken: token, effect: "unknown" }
    );
  }

  async #uploadMedia(
    attachment: DingTalkOutboundAttachment,
    signal?: AbortSignal
  ): Promise<string> {
    const token = await this.#legacyAccessToken(signal);
    const url = new URL("/media/upload", this.#oapiBaseUrl);
    url.searchParams.set("access_token", token);
    url.searchParams.set("type", attachment.kind === "image" ? "image" : "file");
    const form = new FormData();
    form.set(
      "media",
      new Blob([new Uint8Array(attachment.bytes).buffer], { type: attachment.mimeType }),
      attachment.fileName
    );
    const response = await this.#request(url, { method: "POST", redirect: "error", body: form }, signal, "none");
    const payload = await jsonResponse(response);
    if (!response.ok) throw responseFailure(response, "DingTalk media upload failed.", "none");
    assertProviderSuccess(payload, "DingTalk media upload was rejected.");
    const mediaId = stringField(payload, "media_id");
    if (mediaId === null || mediaId.length > 4_096) throw malformed("DingTalk media upload omitted its media identity.");
    return mediaId.startsWith("@") ? mediaId.slice(1) : mediaId;
  }

  async #modernAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.#accessToken !== null && this.#accessToken.expiresAt - 60_000 > this.#now()) {
      return this.#accessToken.value;
    }
    const payload = await this.#postJson(
      new URL("/v1.0/oauth2/accessToken", this.#apiBaseUrl),
      { appKey: this.#appKey, appSecret: this.#appSecret },
      { signal, credentialRequest: true, effect: "none" }
    );
    const value = stringField(payload, "accessToken");
    if (value === null || value.length > 8_192) throw invalidCredential("DingTalk rejected the managed app credential.");
    const expiresIn = finiteNumberField(payload, "expireIn") ?? 7_200;
    this.#accessToken = { value, expiresAt: this.#now() + Math.max(60, Math.min(expiresIn, 86_400)) * 1_000 };
    return value;
  }

  async #legacyAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.#oapiAccessToken !== null && this.#oapiAccessToken.expiresAt - 60_000 > this.#now()) {
      return this.#oapiAccessToken.value;
    }
    const url = new URL("/gettoken", this.#oapiBaseUrl);
    url.searchParams.set("appkey", this.#appKey);
    url.searchParams.set("appsecret", this.#appSecret);
    const response = await this.#request(url, { method: "GET", redirect: "error" }, signal, "none");
    const payload = await jsonResponse(response);
    if (!response.ok) throw responseFailure(response, "DingTalk rejected the managed app credential.", "none", true);
    try {
      assertProviderSuccess(payload, "DingTalk rejected the managed app credential.");
    } catch {
      throw invalidCredential("DingTalk rejected the managed app credential.");
    }
    const value = stringField(payload, "access_token");
    if (value === null || value.length > 8_192) throw invalidCredential("DingTalk rejected the managed app credential.");
    const expiresIn = finiteNumberField(payload, "expires_in") ?? 7_200;
    this.#oapiAccessToken = { value, expiresAt: this.#now() + Math.max(60, Math.min(expiresIn, 86_400)) * 1_000 };
    return value;
  }

  async #postJson(
    url: URL,
    body: Readonly<Record<string, unknown>>,
    options: {
      readonly signal?: AbortSignal;
      readonly accessToken?: string;
      readonly credentialRequest?: boolean;
      readonly effect: "none" | "unknown";
    }
  ): Promise<unknown> {
    const response = await this.#request(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(options.accessToken === undefined ? {} : { "x-acs-dingtalk-access-token": options.accessToken })
      },
      body: JSON.stringify(body)
    }, options.signal, options.effect);
    const payload = await jsonResponse(response);
    if (!response.ok) {
      throw responseFailure(
        response,
        options.credentialRequest === true
          ? "DingTalk rejected the managed app credential."
          : "DingTalk API request failed.",
        options.effect,
        options.credentialRequest === true
      );
    }
    try {
      assertProviderSuccess(payload, "DingTalk API request was rejected.");
    } catch (error) {
      if (options.credentialRequest === true) throw invalidCredential("DingTalk rejected the managed app credential.");
      throw error;
    }
    return payload;
  }

  async #request(
    input: URL,
    init: RequestInit,
    signal: AbortSignal | undefined,
    effect: "none" | "unknown"
  ): Promise<Response> {
    if (this.#closed) throw cancelled();
    signal?.throwIfAborted();
    const controller = new AbortController();
    this.#active.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    try {
      return await this.#fetch(input, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted === true || this.#closed) throw cancelled();
      throw new MessagingTransportError("network", "DingTalk network request failed.", {
        retryable: true,
        effect
      });
    } finally {
      clearTimeout(timeout);
      this.#active.delete(controller);
    }
  }

  #usableSessionWebhook(target: DingTalkOutboundTarget): URL | null {
    if (target.sessionWebhook === null) return null;
    if (target.sessionWebhookExpiresAt !== null && target.sessionWebhookExpiresAt <= this.#now()) return null;
    let url: URL;
    try {
      url = new URL(target.sessionWebhook);
    } catch {
      return null;
    }
    if (url.protocol === "https:" && ["api.dingtalk.com", "oapi.dingtalk.com"].includes(url.hostname)) return url;
    if (
      this.#allowLoopbackProvider && ["http:", "https:"].includes(url.protocol)
      && isLoopback(url.hostname)
      && [this.#apiBaseUrl.host, this.#oapiBaseUrl.host].includes(url.host)
    ) return url;
    return null;
  }
}

function serviceBase(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput(`DingTalk ${label} endpoint is invalid.`);
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalidInput(`DingTalk ${label} endpoint is invalid.`);
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
    throw invalidInput(`DingTalk ${label} endpoint must use HTTPS.`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

function gatewayEndpoint(value: string, allowLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformed("DingTalk Gateway endpoint is invalid.");
  }
  const providerHost = isDingTalkMediaHost(url.hostname);
  const loopback = allowLoopback && isLoopback(url.hostname);
  if ((url.protocol !== "wss:" || !providerHost) && (url.protocol !== "ws:" || !loopback)) {
    throw malformed("DingTalk Gateway endpoint is not trusted.");
  }
  if (url.username || url.password || url.hash) throw malformed("DingTalk Gateway endpoint is invalid.");
  return url.toString();
}

function trustedMediaUrl(
  value: string,
  allowLoopback: boolean,
  apiBase: URL,
  oapiBase: URL
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw malformed("DingTalk media URL is invalid.");
  }
  const provider = url.protocol === "https:" && isDingTalkMediaHost(url.hostname);
  const loopback = allowLoopback && ["http:", "https:"].includes(url.protocol)
    && isLoopback(url.hostname) && [apiBase.host, oapiBase.host].includes(url.host);
  if ((!provider && !loopback) || url.username || url.password) {
    throw providerRejected("DingTalk returned an untrusted media URL.");
  }
  return url;
}

function isDingTalkMediaHost(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "dingtalk.com" || value.endsWith(".dingtalk.com")
    || value === "aliyuncs.com" || value.endsWith(".aliyuncs.com")
    || value === "alicdn.com" || value.endsWith(".alicdn.com");
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function validateOutboundAttachment(value: DingTalkOutboundAttachment): DingTalkOutboundAttachment {
  if (value.bytes.byteLength < 1 || value.bytes.byteLength > DINGTALK_MAXIMUM_ATTACHMENT_BYTES) {
    throw tooLarge("DingTalk attachment size is invalid.");
  }
  const fileName = value.fileName.replace(/[\\/\u0000-\u001f\u007f]/gu, "_").trim().slice(0, 200);
  if (fileName.length === 0) throw invalidInput("DingTalk attachment file name is invalid.");
  const mimeType = normalizedMime(value.mimeType);
  if (value.kind === "image" && !mimeType.startsWith("image/")) {
    throw invalidInput("DingTalk image attachment has an invalid MIME type.");
  }
  return { ...value, fileName, mimeType };
}

function fileType(fileName: string, mimeType: string): string {
  const extension = /\.([A-Za-z0-9]{1,16})$/u.exec(fileName)?.[1]?.toLowerCase();
  if (extension !== undefined) return extension;
  const subtype = mimeType.split("/", 2)[1]?.replace(/[^A-Za-z0-9]/gu, "").slice(0, 16);
  return subtype || "file";
}

function providerMessageId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ["processQueryKey", "messageId", "msgId"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim() !== "" && candidate.length <= 512) return candidate;
  }
  const result = value["result"];
  return isRecord(result) ? providerMessageId(result) : null;
}

function assertProviderSuccess(value: unknown, message: string): void {
  if (!isRecord(value)) throw malformed("DingTalk returned invalid JSON.");
  const code = value["code"];
  const legacy = value["errcode"];
  const failed = (typeof code === "string" && code !== "" && code !== "0")
    || (typeof code === "number" && code !== 0)
    || (typeof legacy === "string" && legacy !== "" && legacy !== "0")
    || (typeof legacy === "number" && legacy !== 0);
  if (failed) throw providerRejected(message);
}

async function jsonResponse(response: Response): Promise<unknown> {
  const bytes = await readBodyLimited(response, MAXIMUM_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw malformed("DingTalk returned malformed JSON.");
  }
}

async function readBodyLimited(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge("DingTalk response exceeded its size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseFailure(
  response: Response,
  message: string,
  effect: "none" | "unknown",
  credentialRequest = false
): MessagingTransportError {
  if (credentialRequest && [400, 401, 403].includes(response.status)) return invalidCredential(message);
  if (response.status === 429) {
    return new MessagingTransportError("rate_limited", message, {
      retryable: true,
      effect: "none",
      providerStatus: response.status,
      retryAfterMs: retryAfter(response.headers.get("retry-after"))
    });
  }
  const knownNoEffect = response.status >= 400 && response.status < 500;
  return new MessagingTransportError(
    knownNoEffect ? "provider_rejected" : "provider_unavailable",
    message,
    { retryable: !knownNoEffect, effect: knownNoEffect ? "none" : effect, providerStatus: response.status }
  );
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 24 * 60 * 60_000) : undefined;
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() !== "" ? candidate : null;
}

function finiteNumberField(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function normalizedMime(value: string): string {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime)
    ? mime
    : "application/octet-stream";
}

function requiredSecret(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput(`DingTalk ${label} is invalid.`);
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidInput(`DingTalk ${label} is invalid.`);
  return value;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function invalidCredential(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_credential", message, { retryable: false, effect: "none" });
}

function malformed(message: string): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable: false, effect: "none" });
}

function providerRejected(message: string): MessagingTransportError {
  return new MessagingTransportError("provider_rejected", message, { retryable: false, effect: "none" });
}

function tooLarge(message: string): MessagingTransportError {
  return new MessagingTransportError("payload_too_large", message, { retryable: false, effect: "none" });
}

function cancelled(): MessagingTransportError {
  return new MessagingTransportError("cancelled", "DingTalk request was cancelled.", { retryable: false, effect: "none" });
}
