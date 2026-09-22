import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { MessagingTransportError, type MessagingEffectCertainty } from "../types.js";
import { slackId, slackTimestamp } from "./codec.js";

const DEFAULT_API_BASE = "https://slack.com/api/";
const MAXIMUM_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_FILE_BYTES = 50 * 1024 * 1024;
const MAXIMUM_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN = /^[A-Za-z0-9._-]{16,512}$/u;

interface SlackResponse {
  readonly ok?: unknown;
  readonly error?: unknown;
  readonly [key: string]: unknown;
}

export interface SlackApiOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly fetch?: typeof globalThis.fetch;
  /** HTTPS Slack endpoint in production; HTTP is accepted only on loopback for fixtures. */
  readonly apiBaseUrl?: string;
  /** Test seam; production DNS answers are pinned before file transfer. */
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
}

export interface SlackAuthIdentity {
  readonly teamId: string;
  readonly botUserId: string;
  readonly botId: string;
  readonly teamName: string;
}

export interface SlackFileInfo {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly size: number | null;
  readonly downloadUrl: string;
}

export class SlackApi {
  readonly #appToken: string;
  readonly #botToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #base: URL;
  readonly #loopbackOrigin: string | null;
  readonly #resolveAddresses: ((hostname: string) => Promise<readonly string[]>) | undefined;
  readonly #usesFetchSeam: boolean;

  constructor(options: SlackApiOptions) {
    this.#appToken = requiredToken(options.appToken, "app", "xapp-");
    this.#botToken = requiredToken(options.botToken, "bot", "xoxb-");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw invalid("Slack HTTP transport is unavailable.");
    this.#usesFetchSeam = options.fetch !== undefined;
    this.#base = apiBase(options.apiBaseUrl ?? DEFAULT_API_BASE);
    this.#loopbackOrigin = isLoopback(this.#base) ? this.#base.origin : null;
    this.#resolveAddresses = options.resolveAddresses;
  }

  get loopbackOrigin(): string | null { return this.#loopbackOrigin; }

  async authTest(signal?: AbortSignal): Promise<SlackAuthIdentity> {
    const body = await this.#request("auth.test", this.#botToken, undefined, "none", signal);
    const teamId = slackId(asString(body.team_id), "Slack team identifier");
    const botUserId = slackId(asString(body.user_id), "Slack bot user identifier");
    const botId = slackId(asString(body.bot_id), "Slack bot identifier");
    const teamName = asString(body.team);
    if (teamName.length < 1 || teamName.length > 256) throw malformed("Slack auth identity is incomplete.", "none");
    return { teamId, botUserId, botId, teamName };
  }

  async openSocketUrl(signal?: AbortSignal): Promise<string> {
    const body = await this.#request("apps.connections.open", this.#appToken, undefined, "none", signal);
    const raw = asString(body.url);
    if (raw.length < 1 || raw.length > 8_192) throw malformed("Slack Socket URL is invalid.", "none");
    let url: URL;
    try { url = new URL(raw); } catch { throw malformed("Slack Socket URL is invalid.", "none"); }
    const official = url.protocol === "wss:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) && (url.port === "" || url.port === "443");
    const loopback = this.#loopbackOrigin !== null && url.protocol === "ws:" &&
      url.hostname === this.#base.hostname && url.port === this.#base.port;
    if ((!official && !loopback) || url.username !== "" || url.password !== "" || url.hash !== "") {
      throw malformed("Slack Socket URL is not an approved endpoint.", "none");
    }
    return url.toString();
  }

  async openOwnerDm(ownerUserId: string, signal?: AbortSignal): Promise<string> {
    const body = await this.#request("conversations.open", this.#botToken, {
      users: slackId(ownerUserId, "Slack owner user identifier"),
      return_im: true
    }, "unknown", signal);
    const channel = object(body.channel);
    const channelId = slackId(asString(channel.id), "Slack owner DM identifier");
    if (!channelId.startsWith("D")) throw malformed("Slack did not return an owner DM.", "unknown");
    return channelId;
  }

  async postMessage(input: {
    readonly channelId: string;
    readonly text: string;
    readonly threadTs: string | null;
    readonly blocks?: readonly unknown[];
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const body = await this.#request("chat.postMessage", this.#botToken, {
      channel: slackId(input.channelId, "Slack channel identifier"),
      text: input.text,
      mrkdwn: false,
      parse: "none",
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
      ...(input.threadTs === null ? {} : { thread_ts: slackTimestamp(input.threadTs) }),
      ...(input.blocks === undefined ? {} : { blocks: input.blocks })
    }, "unknown", input.signal);
    const ts = slackTimestamp(asString(body.ts));
    if (body.channel !== input.channelId) throw malformed("Slack returned a different message channel.", "unknown");
    return ts;
  }

  async updateMessage(input: {
    readonly channelId: string;
    readonly ts: string;
    readonly text: string;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const body = await this.#request("chat.update", this.#botToken, {
      channel: slackId(input.channelId, "Slack channel identifier"),
      ts: slackTimestamp(input.ts),
      text: input.text,
      blocks: [],
      parse: "none",
      link_names: false
    }, "unknown", input.signal);
    const ts = slackTimestamp(asString(body.ts));
    if (ts !== input.ts || body.channel !== input.channelId) throw malformed("Slack edited a different message.", "unknown");
    return ts;
  }

  async addReaction(channelId: string, timestamp: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.#request("reactions.add", this.#botToken, {
      channel: slackId(channelId, "Slack channel identifier"),
      timestamp: slackTimestamp(timestamp),
      name: reactionName(name)
    }, "unknown", signal, "already_reacted");
  }

  async removeReaction(channelId: string, timestamp: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.#request("reactions.remove", this.#botToken, {
      channel: slackId(channelId, "Slack channel identifier"),
      timestamp: slackTimestamp(timestamp),
      name: reactionName(name)
    }, "unknown", signal, "no_reaction");
  }

  async fileInfo(fileId: string, signal?: AbortSignal): Promise<SlackFileInfo> {
    const body = await this.#request("files.info", this.#botToken, { file: slackId(fileId, "Slack file identifier") }, "none", signal);
    const file = object(body.file);
    const id = slackId(asString(file.id), "Slack file identifier");
    if (id !== fileId) throw malformed("Slack returned a different file.", "none");
    const url = asString(file.url_private_download) || asString(file.url_private);
    this.#fileUrl(url);
    const name = asString(file.name) || id;
    if (name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name)) throw malformed("Slack file name is invalid.", "none");
    const mimeType = asString(file.mimetype) || null;
    const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null;
    return { id, name, mimeType, size, downloadUrl: url };
  }

  async downloadFile(file: SlackFileInfo, maximumBytes: number, signal?: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string }> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAXIMUM_FILE_BYTES) throw invalid("Slack file limit is invalid.");
    let url = this.#fileUrl(file.downloadUrl);
    for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
      const response = await this.#fileRequest(url, "GET", undefined, { authorization: `Bearer ${this.#botToken}` }, "none", signal);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null || redirects === MAXIMUM_REDIRECTS) throw rejected("Slack file redirect was rejected.", response.status);
        url = this.#fileUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw httpError(response.status, "none", response.headers);
      return { bytes: await readBounded(response, maximumBytes, "none"), mimeType: contentType(response.headers.get("content-type")) };
    }
    throw rejected("Slack file redirect was rejected.");
  }

  async uploadFile(input: {
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly channelId: string;
    readonly threadTs: string | null;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    const fileName = input.fileName.trim();
    if (fileName.length < 1 || fileName.length > 255 || /[\u0000-\u001f\u007f]/u.test(fileName)) throw invalid("Slack upload file name is invalid.");
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAXIMUM_FILE_BYTES) throw tooLarge();
    const ticket = await this.#request("files.getUploadURLExternal", this.#botToken, {
      filename: fileName,
      length: input.bytes.byteLength
    }, "none", input.signal);
    const fileId = slackId(asString(ticket.file_id), "Slack upload file identifier");
    const url = this.#fileUrl(asString(ticket.upload_url));
    const response = await this.#fileRequest(url, "POST", input.bytes, { "content-type": "application/octet-stream" }, "unknown", input.signal);
    if (response.status !== 200) throw httpError(response.status, "unknown", response.headers);
    await readBounded(response, 64 * 1024, "unknown");
    const complete = await this.#request("files.completeUploadExternal", this.#botToken, {
      files: [{ id: fileId, title: fileName }],
      channel_id: slackId(input.channelId, "Slack channel identifier"),
      ...(input.threadTs === null ? {} : { thread_ts: slackTimestamp(input.threadTs) })
    }, "unknown", input.signal);
    const files = Array.isArray(complete.files) ? complete.files : [];
    if (!files.some((item) => object(item).id === fileId)) throw malformed("Slack file completion did not confirm the uploaded file.", "unknown");
    return fileId;
  }

  async #request(
    method: string,
    token: string,
    payload: unknown,
    effect: MessagingEffectCertainty,
    signal?: AbortSignal,
    acceptedError?: string
  ): Promise<SlackResponse> {
    const response = await requestWithTimeout(this.#fetch, new URL(method, this.#base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      redirect: "manual"
    }, effect, signal);
    if (response.status === 429) throw httpError(429, "none", response.headers);
    if (!response.ok) throw httpError(response.status, effect, response.headers);
    const bytes = await readBounded(response, MAXIMUM_API_RESPONSE_BYTES, effect);
    let body: SlackResponse;
    try { body = JSON.parse(new TextDecoder().decode(bytes)) as SlackResponse; }
    catch { throw malformed("Slack API returned invalid JSON.", effect); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw malformed("Slack API returned invalid data.", effect);
    if (body.ok === true) return body;
    const code = typeof body.error === "string" ? body.error : "unknown_error";
    if (code === acceptedError) return body;
    throw slackFailure(code, response.status, effect);
  }

  #fileUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw invalid("Slack file URL is invalid."); }
    const official = url.protocol === "https:" && url.port === "" &&
      (url.hostname === "files.slack.com" || url.hostname.endsWith(".slack.com"));
    const loopback = this.#loopbackOrigin !== null && url.origin === this.#loopbackOrigin && url.protocol === "http:";
    if ((!official && !loopback) || url.username !== "" || url.password !== "" || url.hash !== "" || value.length > 16_384) {
      throw invalid("Slack file URL is not an approved endpoint.");
    }
    return url;
  }

  async #fileRequest(
    url: URL,
    method: "GET" | "POST",
    body: Uint8Array | undefined,
    headers: Record<string, string>,
    effect: MessagingEffectCertainty,
    signal?: AbortSignal
  ): Promise<Response> {
    if (this.#loopbackOrigin !== null || this.#usesFetchSeam) {
      return requestWithTimeout(this.#fetch, url, {
        method, headers, redirect: "manual", ...(body === undefined ? {} : { body: Buffer.from(body) })
      }, effect, signal);
    }
    return pinnedHttpsRequest(url, method, body, headers, effect, signal, this.#resolveAddresses);
  }
}

function apiBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("Slack API endpoint is invalid."); }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const official = url.protocol === "https:" && url.hostname === "slack.com" && url.pathname === "/api/" && url.port === "";
  const loopback = url.protocol === "http:" && isLoopback(url) && url.pathname.startsWith("/api/");
  if ((!official && !loopback) || url.username !== "" || url.password !== "" || url.hash !== "" || url.search !== "") {
    throw invalid("Slack API endpoint is not approved.");
  }
  return url;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

function requiredToken(value: string, label: string, prefix: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!token.startsWith(prefix) || !TOKEN.test(token)) throw invalid(`Slack ${label} token shape is invalid.`);
  return token;
}

function reactionName(value: string): string {
  const names: Record<string, string> = { "👀": "eyes", "👍": "+1", "👎": "-1" };
  const name = names[value] ?? value;
  if (!/^[a-z0-9_+\-]{1,64}$/u.test(name)) throw invalid("Slack reaction name is invalid.");
  return name;
}

function asString(value: unknown): string { return typeof value === "string" ? value : ""; }
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function contentType(raw: string | null): string {
  const mime = raw?.split(";", 1)[0]?.trim().toLowerCase();
  return mime !== undefined && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : "application/octet-stream";
}

async function readBounded(response: Response, maximumBytes: number, effect: MessagingEffectCertainty): Promise<Uint8Array> {
  const declaredRaw = response.headers.get("content-length");
  const declared = declaredRaw === null ? null : Number(declaredRaw);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes)) throw tooLarge(effect);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) { await reader.cancel(); throw tooLarge(effect); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((part) => Buffer.from(part)));
}

async function requestWithTimeout(
  fetcher: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  effect: MessagingEffectCertainty,
  signal?: AbortSignal
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try { return await fetcher(url, { ...init, signal: merged }); }
  catch {
    if (signal?.aborted) throw new MessagingTransportError("cancelled", "Slack request was cancelled.", { retryable: false, effect });
    throw new MessagingTransportError("network", "Slack request failed before a response was available.", { retryable: true, effect });
  }
}

async function pinnedHttpsRequest(
  url: URL,
  method: "GET" | "POST",
  body: Uint8Array | undefined,
  headers: Record<string, string>,
  effect: MessagingEffectCertainty,
  signal?: AbortSignal,
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>
): Promise<Response> {
  const addresses = resolveAddresses === undefined
    ? (await lookup(url.hostname, { all: true })).map((answer) => answer.address)
    : await resolveAddresses(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw invalid("Slack file endpoint did not resolve to public addresses.");
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest({
      hostname: addresses[0], port: 443, servername: url.hostname,
      method, path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.hostname, ...(body === undefined ? {} : { "content-length": String(body.byteLength) }) },
      rejectUnauthorized: true, signal: merged
    }, async (incoming) => {
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        const maximum = body === undefined ? MAXIMUM_FILE_BYTES + 1 : 64 * 1024;
        for await (const chunk of incoming) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += part.byteLength;
          if (total > maximum) throw tooLarge(effect);
          chunks.push(part);
        }
        const responseHeaders: [string, string][] = Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500, headers: responseHeaders }));
      } catch (error) { request.destroy(); reject(error); }
    });
    request.once("error", () => reject(merged.aborted && signal?.aborted
      ? new MessagingTransportError("cancelled", "Slack file transfer was cancelled.", { retryable: false, effect })
      : new MessagingTransportError("network", "Slack file transfer failed.", { retryable: true, effect })));
    request.end(body === undefined ? undefined : Buffer.from(body));
  });
}

function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const [a, b, c] = value.split(".").map(Number);
    if (a === undefined || b === undefined || c === undefined) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && b >= 18 && b <= 19) return false;
    return true;
  }
  if (family === 6) return /^[23]/u.test(value.toLowerCase()) && !value.includes(".");
  return false;
}

function slackFailure(code: string, status: number, effect: MessagingEffectCertainty): MessagingTransportError {
  if (["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "not_allowed_token_type"].includes(code)) {
    return new MessagingTransportError("invalid_credential", "Slack credential is no longer valid.", { retryable: false, effect: "none", providerStatus: status });
  }
  if (["missing_scope", "no_permission", "channel_not_found", "access_denied", "file_type_not_allowed"].includes(code)) {
    return new MessagingTransportError("provider_rejected", `Slack rejected the request (${code}).`, { retryable: false, effect: "none", providerStatus: status });
  }
  if (code === "ratelimited") return new MessagingTransportError("rate_limited", "Slack rate limited the request.", { retryable: true, effect: "none", providerStatus: status });
  if (["fatal_error", "internal_error", "service_unavailable"].includes(code)) {
    return new MessagingTransportError("provider_unavailable", "Slack could not confirm the request.", { retryable: true, effect, providerStatus: status });
  }
  return new MessagingTransportError("provider_rejected", `Slack rejected the request (${code}).`, { retryable: false, effect: "none", providerStatus: status });
}

function httpError(status: number, effect: MessagingEffectCertainty, headers: Headers): MessagingTransportError {
  if (status === 429) {
    const seconds = Number(headers.get("retry-after"));
    return new MessagingTransportError("rate_limited", "Slack rate limited the request.", {
      retryable: true, effect: "none", providerStatus: status,
      ...(Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.min(seconds * 1_000, 60 * 60_000) } : {})
    });
  }
  if (status === 401 || status === 403) return new MessagingTransportError("invalid_credential", "Slack credential was rejected.", { retryable: false, effect: "none", providerStatus: status });
  if (status >= 500) return new MessagingTransportError("provider_unavailable", "Slack service is unavailable.", { retryable: true, effect, providerStatus: status });
  return rejected("Slack rejected the request.", status);
}

function rejected(message: string, status?: number): MessagingTransportError {
  return new MessagingTransportError("provider_rejected", message, { retryable: false, effect: "none", ...(status === undefined ? {} : { providerStatus: status }) });
}
function malformed(message: string, effect: MessagingEffectCertainty): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable: false, effect });
}
function tooLarge(effect: MessagingEffectCertainty = "none"): MessagingTransportError {
  return new MessagingTransportError("payload_too_large", "Slack payload exceeds the size limit.", { retryable: false, effect });
}
function invalid(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
