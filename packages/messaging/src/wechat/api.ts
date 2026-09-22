import { randomBytes } from "node:crypto";

import type { MessagingEffectCertainty } from "../types.js";
import { parseWeChatJson } from "./codec.js";
import {
  mapWeChatFetchFailure,
  weChatAuthLoss,
  weChatHttp,
  weChatInvalid,
  weChatMalformed,
  weChatProviderRejected
} from "./errors.js";
import {
  WECHAT_ITEM_TYPE,
  WECHAT_MESSAGE_STATE,
  WECHAT_MESSAGE_TYPE,
  type WeChatCredentials,
  type WeChatRawItem,
  type WeChatRawMessage,
  type WeChatSendContext,
  type WeChatTransientMedia
} from "./model.js";

export type WeChatFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WeChatApiOptions {
  readonly credentials?: WeChatCredentials;
  readonly fetch?: WeChatFetch;
  readonly apiTimeoutMs?: number;
  readonly longPollTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

export interface WeChatQrStatus {
  readonly status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  readonly ilink_user_id?: string;
  readonly baseurl?: string;
  readonly redirect_host?: string;
}

const AUTHORIZATION_ORIGIN = new URL("https://ilinkai.weixin.qq.com/");
const MAXIMUM_POLL_MESSAGES = 100;
const MAXIMUM_ITEMS_PER_MESSAGE = 20;

export class WeChatApiClient {
  readonly #credentials: WeChatCredentials | undefined;
  readonly #fetch: WeChatFetch;
  readonly #apiTimeoutMs: number;
  readonly #longPollTimeoutMs: number;
  readonly #maximumResponseBytes: number;

  constructor(options: WeChatApiOptions = {}) {
    this.#credentials = options.credentials === undefined ? undefined : validateCredentials(options.credentials);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiTimeoutMs = boundedTimeout(options.apiTimeoutMs ?? 15_000);
    this.#longPollTimeoutMs = boundedTimeout(options.longPollTimeoutMs ?? 35_000);
    this.#maximumResponseBytes = boundedPositive(options.maximumResponseBytes ?? 4 * 1024 * 1024, "response size");
  }

  async probe(signal: AbortSignal): Promise<void> {
    this.#requireCredentials();
    await this.getUpdates("", signal);
  }

  beginQr(localTokens: readonly string[], signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.#request("ilink/bot/get_bot_qrcode?bot_type=3", {
      method: "POST",
      body: { local_token_list: localTokens.slice(-10).filter((token) => validSecret(token)) },
      authenticated: false,
      baseUrl: AUTHORIZATION_ORIGIN,
      effect: "none",
      operation: "WeChat authorization"
    }, signal);
  }

  async pollQr(input: {
    readonly qrCode: string;
    readonly verificationCode?: string;
    readonly baseUrl: string;
    readonly signal: AbortSignal;
  }): Promise<WeChatQrStatus> {
    const query = new URLSearchParams({ qrcode: requiredSecret(input.qrCode, "QR identity") });
    if (input.verificationCode !== undefined) query.set("verify_code", input.verificationCode);
    try {
      return await this.#request(`ilink/bot/get_qrcode_status?${query}`, {
        method: "GET",
        authenticated: false,
        baseUrl: validateWeChatOrigin(input.baseUrl),
        effect: "none",
        operation: "WeChat authorization poll",
        timeoutMs: this.#longPollTimeoutMs
      }, input.signal) as WeChatQrStatus;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "network" && /timed out/u.test(error.message)) return { status: "wait" };
      throw error;
    }
  }

  async getUpdates(cursor: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return await this.#request("ilink/bot/getupdates", {
        method: "POST",
        authenticated: true,
        body: { get_updates_buf: cursor, base_info: this.#baseInfo() },
        effect: "none",
        operation: "WeChat update poll",
        timeoutMs: this.#longPollTimeoutMs
      }, signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "network" && /timed out/u.test(error.message)) {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  messagesFrom(response: Record<string, unknown>): readonly WeChatRawMessage[] {
    if (response["msgs"] === undefined) return [];
    if (!Array.isArray(response["msgs"]) || response["msgs"].length > MAXIMUM_POLL_MESSAGES) {
      throw weChatMalformed("WeChat returned an invalid message list.");
    }
    if (response["msgs"].some((message) => !isRecord(message))) {
      throw weChatMalformed("WeChat returned a malformed message.");
    }
    const messages = response["msgs"] as WeChatRawMessage[];
    if (messages.some((message) => !Array.isArray(message.item_list ?? []) || (message.item_list?.length ?? 0) > MAXIMUM_ITEMS_PER_MESSAGE)) {
      throw weChatMalformed("WeChat returned an invalid message item list.");
    }
    if (messages.some((message) => message.item_list?.some((item) => !isRecord(item)))) {
      throw weChatMalformed("WeChat returned a malformed message item.");
    }
    return messages;
  }

  async sendText(input: {
    readonly peerId: string;
    readonly text: string;
    readonly context: WeChatSendContext;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const text = input.text;
    if (text.length === 0 || Array.from(text).length > 3_500) throw weChatInvalid("WeChat text must contain 1 to 3500 Unicode characters.");
    await this.#sendMessage(input.peerId, input.context, [{ type: WECHAT_ITEM_TYPE.text, text_item: { text } }], input.signal);
  }

  async getUploadUrl(input: {
    readonly peerId: string;
    readonly fileKey: string;
    readonly mediaType: number;
    readonly rawSize: number;
    readonly rawMd5: string;
    readonly encryptedSize: number;
    readonly aesKeyHex: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly uploadParam?: string; readonly uploadFullUrl?: string }> {
    const response = await this.#request("ilink/bot/getuploadurl", {
      method: "POST",
      authenticated: true,
      body: {
        filekey: input.fileKey,
        media_type: input.mediaType,
        to_user_id: requiredProviderId(input.peerId, "peer"),
        rawsize: input.rawSize,
        rawfilemd5: input.rawMd5,
        filesize: input.encryptedSize,
        no_need_thumb: true,
        aeskey: input.aesKeyHex,
        base_info: this.#baseInfo()
      },
      effect: "none",
      operation: "WeChat upload admission"
    }, input.signal);
    assertProviderSuccess(response, "upload admission");
    return {
      ...(typeof response["upload_param"] === "string" ? { uploadParam: response["upload_param"] } : {}),
      ...(typeof response["upload_full_url"] === "string" ? { uploadFullUrl: response["upload_full_url"] } : {})
    };
  }

  async sendMedia(input: {
    readonly peerId: string;
    readonly context: WeChatSendContext;
    readonly media: WeChatTransientMedia;
    readonly fileName: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    await this.#sendMessage(input.peerId, input.context, [mediaItem(input.media, input.fileName)], input.signal);
  }

  getConfig(peerId: string, contextToken: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.#request("ilink/bot/getconfig", {
      method: "POST",
      authenticated: true,
      body: { ilink_user_id: requiredProviderId(peerId, "peer"), context_token: requiredSecret(contextToken, "context"), base_info: this.#baseInfo() },
      effect: "none",
      operation: "WeChat typing configuration"
    }, signal);
  }

  async setTyping(peerId: string, ticket: string, active: boolean, signal: AbortSignal): Promise<void> {
    const response = await this.#request("ilink/bot/sendtyping", {
      method: "POST",
      authenticated: true,
      body: { ilink_user_id: requiredProviderId(peerId, "peer"), typing_ticket: requiredSecret(ticket, "typing ticket"), status: active ? 1 : 2, base_info: this.#baseInfo() },
      effect: "unknown",
      operation: "WeChat typing update"
    }, signal);
    assertProviderSuccess(response, "typing update");
  }

  async notifyLifecycle(active: boolean, signal: AbortSignal): Promise<void> {
    const response = await this.#request(active ? "ilink/bot/msg/notifystart" : "ilink/bot/msg/notifystop", {
      method: "POST",
      authenticated: true,
      body: { base_info: this.#baseInfo() },
      effect: "none",
      operation: `WeChat lifecycle ${active ? "start" : "stop"}`,
      timeoutMs: 5_000
    }, signal);
    assertProviderSuccess(response, "lifecycle notification");
  }

  async #sendMessage(peerId: string, context: WeChatSendContext, items: readonly WeChatRawItem[], signal: AbortSignal): Promise<void> {
    const response = await this.#request("ilink/bot/sendmessage", {
      method: "POST",
      authenticated: true,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: requiredProviderId(peerId, "peer"),
          client_id: requiredProviderId(context.clientId, "delivery"),
          message_type: WECHAT_MESSAGE_TYPE.bot,
          message_state: WECHAT_MESSAGE_STATE.finished,
          item_list: items,
          context_token: requiredSecret(context.contextToken, "context"),
          ...(context.runId === undefined ? {} : { run_id: requiredProviderId(context.runId, "run") })
        },
        base_info: this.#baseInfo()
      },
      effect: "unknown",
      operation: "WeChat message send"
    }, signal);
    assertProviderSuccess(response, "message send");
  }

  async #request(endpoint: string, input: {
    readonly method: "GET" | "POST";
    readonly body?: unknown;
    readonly authenticated: boolean;
    readonly baseUrl?: URL;
    readonly effect: MessagingEffectCertainty;
    readonly operation: string;
    readonly timeoutMs?: number;
  }, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const baseUrl = input.baseUrl ?? validateWeChatOrigin(this.#requireCredentials().baseUrl);
    const url = new URL(endpoint, baseUrl);
    const timeout = timeoutSignal(signal, input.timeoutMs ?? this.#apiTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: input.method,
        redirect: "manual",
        signal: timeout.signal,
        headers: this.#headers(input.authenticated, input.body !== undefined),
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
      });
      const text = await readBoundedText(response, this.#maximumResponseBytes);
      if (response.status >= 300 && response.status < 400) throw weChatHttp(response.status, `${input.operation} refused an external redirect.`, input.effect);
      if (!response.ok) throw weChatHttp(response.status, `${input.operation} failed with HTTP ${response.status}.`, input.effect);
      return parseWeChatJson(text);
    } catch (error) {
      throw mapWeChatFetchFailure(error, { signal, timedOut: timeout.timedOut(), effect: input.effect, operation: input.operation });
    } finally {
      timeout.cleanup();
    }
  }

  #headers(authenticated: boolean, json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String((0 << 16) | (1 << 8)),
      "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64")
    };
    if (json) {
      headers["Content-Type"] = "application/json";
      headers["AuthorizationType"] = "ilink_bot_token";
    }
    if (authenticated) headers["Authorization"] = `Bearer ${requiredSecret(this.#requireCredentials().token, "credential")}`;
    return headers;
  }

  #baseInfo(): Record<string, string> {
    return { channel_version: "0.1.0", bot_agent: "Joko/0.1.0" };
  }

  #requireCredentials(): WeChatCredentials {
    if (this.#credentials === undefined) throw weChatInvalid("WeChat credentials are unavailable for this operation.");
    return this.#credentials;
  }
}

export function validateWeChatOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw weChatInvalid("WeChat returned an invalid service origin."); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")
    || url.search !== "" || url.hash !== "" || url.pathname !== "/" || !trustedWeChatHost(url.hostname)) {
    throw weChatInvalid("WeChat service origin is not trusted.");
  }
  return url;
}

export function validateWeChatHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw weChatInvalid(`${label} is invalid.`); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.port !== "" && url.port !== "443")
    || url.hash !== "" || !trustedWeChatHost(url.hostname)) {
    throw weChatInvalid(`${label} is not a trusted HTTPS URL.`);
  }
  return url;
}

function trustedWeChatHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "weixin.qq.com" || normalized.endsWith(".weixin.qq.com");
}

function validateCredentials(value: WeChatCredentials): WeChatCredentials {
  validateWeChatOrigin(value.baseUrl);
  return {
    token: requiredSecret(value.token, "credential"),
    botId: requiredProviderId(value.botId, "bot"),
    userId: requiredProviderId(value.userId, "account"),
    baseUrl: value.baseUrl
  };
}

function mediaItem(media: WeChatTransientMedia, fileName: string): WeChatRawItem {
  if (media.kind === "voice") throw weChatInvalid("Outbound WeChat voice is unsupported.");
  if (!media.encryptedQuery || !media.aesKeyBase64) throw weChatInvalid("WeChat uploaded media is incomplete.");
  const coordinate = { encrypt_query_param: media.encryptedQuery, aes_key: media.aesKeyBase64, encrypt_type: 1 };
  switch (media.kind) {
    case "image": return { type: WECHAT_ITEM_TYPE.image, image_item: { media: coordinate, mid_size: media.encryptedByteLength } };
    case "video": return { type: WECHAT_ITEM_TYPE.video, video_item: { media: coordinate, video_size: media.encryptedByteLength } };
    case "file": return { type: WECHAT_ITEM_TYPE.file, file_item: { media: coordinate, file_name: fileName, len: media.byteLength === undefined ? undefined : String(media.byteLength) } };
  }
}

function assertProviderSuccess(response: Record<string, unknown>, operation: string): void {
  if (response["ret"] === undefined) return;
  if (typeof response["ret"] !== "number") throw weChatMalformed(`WeChat returned an invalid ${operation} status.`);
  if (response["ret"] !== 0) throw weChatProviderRejected(`WeChat rejected the ${operation}.`, true);
}

function requiredSecret(value: string, label: string): string {
  if (!validSecret(value)) throw weChatInvalid(`WeChat ${label} is invalid.`);
  return value.trim();
}

function validSecret(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 8_192 && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

function requiredProviderId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw weChatInvalid(`WeChat ${label} identity is invalid.`);
  return normalized;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw weChatInvalid("WeChat timeout is invalid.");
  return value;
}

function boundedPositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64 * 1024 * 1024) throw weChatInvalid(`WeChat ${label} is invalid.`);
  return value;
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw weChatMalformed("WeChat response exceeded the size limit.");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw weChatMalformed("WeChat response exceeded the size limit.");
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts.map((part) => Buffer.from(part))).toString("utf8");
}

function timeoutSignal(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; timedOut(): boolean; cleanup(): void } {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timeoutReached = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, timedOut: () => timeoutReached, cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
