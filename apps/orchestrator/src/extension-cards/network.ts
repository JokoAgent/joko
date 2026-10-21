// Adapted from the fixed reference's network slot; see NOTICE / LICENSE.cindy.
import { extensionNetworkCredentialReference, extensionNetworkUrl, extensionNetworkHostMatches, type ExtensionNetworkDeclaration, type ExtensionNetworkSecret } from "./network-manifest.js";
import { randomUUID } from "node:crypto";
import type { ExtensionCardMedia } from "./media.js";
import type { ExtensionCardScope } from "./service.js";
import { sniffMediaMime } from "./media-sniff.js";

const STRIPPED = new Set(["host", "connection", "content-length", "transfer-encoding", "upgrade", "cookie", "set-cookie", "origin", "referer", "authorization"]);
const RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "etag", "last-modified", "retry-after", "mcp-session-id"];
const MAX_RESPONSE = 50 * 1024 * 1024;
export interface ExtensionNetworkScope {
  readonly extensionId: string; readonly authorityKey: string; readonly declaration: ExtensionNetworkDeclaration;
  readonly signal: AbortSignal; readonly readOnly: boolean; readonly assertCurrent: () => void;
  readonly task?: ExtensionCardScope;
}
interface Options {
  readonly fetch: typeof fetch;
  readonly resolveCredential: (reference: string) => string;
  readonly redact: (value: string) => string;
  readonly media?: ExtensionCardMedia;
}
interface Exchange { readonly source: string; readonly value: string; readonly expiresAt: number }

/** HTTP runs in the host. The author page receives bounded, redacted text and
 * never receives credentials, cookies or an unrestricted transport. */
export class ExtensionNetwork {
  readonly #inflight = new Map<string, number>();
  readonly #exchanged = new Map<string, Exchange>();
  readonly #exchanging = new Map<string, Promise<string>>();
  #largeResponse = false;
  constructor(private readonly options: Options) {}
  retire(authorityKey: string): void {
    for (const key of this.#exchanged.keys()) if (key.startsWith(authorityKey + "\0")) this.#exchanged.delete(key);
  }
  async request(scope: ExtensionNetworkScope, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    let admitted = false, holdingLarge = false;
    let lastResponse: Response | undefined;
    let timer: NodeJS.Timeout | undefined;
    const secrets = new Set<string>();
    const scrub = (value: string) => {
      let result = this.options.redact(value);
      for (const secret of secrets) for (const fragment of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
        if (fragment) result = result.split(fragment).join("[REDACTED]");
      }
      return result;
    };
    const ownAbort = new AbortController(), signal = AbortSignal.any([scope.signal, ownAbort.signal]);
    const current = () => { signal.throwIfAborted(); scope.assertCurrent(); };
    try {
      current();
      let url = extensionNetworkUrl(payload.url, scope.declaration.hosts);
      const method = payload.method ?? "GET";
      if (typeof method !== "string" || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)
        || scope.readOnly && !["GET", "HEAD"].includes(method)) throw new Error();
      const asMedia = payload.as === "media";
      if (payload.as !== undefined && payload.as !== "text" && !asMedia || payload.uploadDir !== undefined || asMedia && (!this.options.media || !scope.task)) throw new Error();
      let upload: { hashes: string[]; field: string; fields: Record<string, string> } | undefined;
      if (payload.upload !== undefined) {
        if (!payload.upload || typeof payload.upload !== "object" || Array.isArray(payload.upload) || method !== "POST" || payload.body !== undefined || asMedia || !this.options.media || !scope.task) throw new Error();
        const value = payload.upload as Record<string, unknown>, field = value.field ?? "file";
        if (Object.keys(value).some(key => !["hashes", "field", "fields"].includes(key)) || !Array.isArray(value.hashes) || !value.hashes.length || value.hashes.length > 4
          || value.hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) || new Set(value.hashes).size !== value.hashes.length
          || typeof field !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(field)) throw new Error();
        const fields: Record<string, string> = {};
        if (value.fields !== undefined) {
          if (!value.fields || typeof value.fields !== "object" || Array.isArray(value.fields) || Object.keys(value.fields).length > 16) throw new Error();
          for (const [key, item] of Object.entries(value.fields)) {
            if (!/^[A-Za-z0-9_-]{1,64}$/u.test(key) || typeof item !== "string" || item.length > 8192 || /[\u0000]/u.test(item)) throw new Error();
            fields[key] = item;
          }
        }
        upload = { hashes: value.hashes as string[], field, fields };
      }
      if (payload.body !== undefined && (typeof payload.body !== "string" || ["GET", "HEAD"].includes(method) || Buffer.byteLength(payload.body) > 256 * 1024)) throw new Error();
      if (payload.timeoutMs !== undefined && (typeof payload.timeoutMs !== "number" || !Number.isFinite(payload.timeoutMs))) throw new Error();
      const timeoutMs = Math.min(upload || asMedia ? 300_000 : 60_000, Math.max(1000, typeof payload.timeoutMs === "number" ? payload.timeoutMs : upload || asMedia ? 120_000 : 30_000));
      const authorHeaders = new Headers();
      if (payload.headers !== undefined) {
        if (!payload.headers || typeof payload.headers !== "object" || Array.isArray(payload.headers) || Object.keys(payload.headers).length > 16) throw new Error();
        for (const [name, value] of Object.entries(payload.headers)) {
          if (!/^[A-Za-z0-9-]{1,64}$/u.test(name) || typeof value !== "string" || value.length > 2048 || /[\r\n]/u.test(value)) throw new Error();
          const lower = name.toLowerCase();
          if (!STRIPPED.has(lower) && !lower.startsWith("sec-") && !lower.startsWith("proxy-")
            && !scope.declaration.secrets?.some(secret => secret.inject.header.toLowerCase() === lower)) authorHeaders.set(name, value);
        }
      }
      const count = this.#inflight.get(scope.authorityKey) ?? 0;
      if (count >= 4 || this.#inflight.size >= 64 && count === 0) return { ok: false, message: "Extension network capacity reached. Retry after the current requests finish." };
      this.#inflight.set(scope.authorityKey, count + 1); admitted = true;
      timer = setTimeout(() => ownAbort.abort(), timeoutMs); timer.unref();
      let preparedBody: string | ArrayBuffer | undefined = payload.body as string | undefined;
      if (upload) {
        if (this.#largeResponse) throw new Error(); holdingLarge = this.#largeResponse = true;
        const boundary = `----joko-extension-${randomUUID()}`, parts: Uint8Array[] = [], files: Uint8Array[] = [], encoder = new TextEncoder(); let total = 0;
        for (const hash of upload.hashes) {
          const media = await this.options.media!.read(scope.task!, hash, current); current();
          if (media.data.byteLength > 64 * 1024 * 1024 || (total += media.data.byteLength) > 128 * 1024 * 1024) throw new Error();
          files.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${upload.field}"; filename="${hash.slice(0, 16)}.${media.uri.split(".").at(-1)}"\r\nContent-Type: ${media.mimeType}\r\n\r\n`), media.data, encoder.encode("\r\n"));
        }
        for (const [key, value] of Object.entries(upload.fields)) parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value.replace("{bytes}", () => String(total))}\r\n`));
        parts.push(...files, encoder.encode(`--${boundary}--\r\n`));
        const bytes = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0)); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        preparedBody = bytes.buffer; authorHeaders.set("content-type", `multipart/form-data; boundary=${boundary}`);
      }
      const originalUrl = url;
      for (let attempt = 0; attempt < 2; attempt++) {
        let currentMethod: string = method, body: string | ArrayBuffer | undefined = preparedBody, usedExchange = false;
        url = originalUrl;
        let response: Response | undefined;
        for (let hop = 0; hop <= 3; hop++) {
          current();
          const headers = new Headers(authorHeaders);
          if (body === undefined && currentMethod === "GET" && currentMethod !== method) { headers.delete("content-type"); headers.delete("content-encoding"); }
          for (const secret of scope.declaration.secrets ?? []) {
            if (!(secret.inject.hosts ?? scope.declaration.hosts).some(pattern => extensionNetworkHostMatches(pattern, url.hostname))) continue;
            const raw = this.options.resolveCredential(extensionNetworkCredentialReference(scope.extensionId, scope.declaration, secret));
            if (!raw || /[\r\n]/u.test(raw)) throw new Error();
            secrets.add(raw);
            const value = secret.exchange ? await this.#exchange(scope, secret, raw, signal, secrets) : raw;
            current(); secrets.add(value); usedExchange ||= secret.exchange !== undefined;
            headers.set(secret.inject.header, secret.inject.format.replace("{value}", () => value));
          }
          current();
          response = await this.options.fetch(url, { method: currentMethod, headers, ...(body === undefined ? {} : { body }), redirect: "manual", signal });
          lastResponse = response;
          current();
          const location = response.headers.get("location");
          if (![301, 302, 303, 307, 308].includes(response.status) || !location) break;
          await response.body?.cancel();
          if (hop === 3) throw new Error();
          const next = extensionNetworkUrl(new URL(location, url).href, scope.declaration.hosts);
          if (response.status === 303 || [301, 302].includes(response.status) && currentMethod === "POST") { currentMethod = "GET"; body = undefined; }
          url = next;
        }
        if (!response) throw new Error();
        if (response.status === 401 && usedExchange && attempt === 0) {
          await response.body?.cancel();
          this.retire(scope.authorityKey); continue;
        }
        const contentType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        const textual = contentType.startsWith("text/") || ["application/json", "application/xml", "application/x-www-form-urlencoded", "application/javascript"].includes(contentType) || contentType.endsWith("+json") || contentType.endsWith("+xml");
        if (asMedia && response.status >= 200 && response.status < 300 && !textual) {
          if (this.#largeResponse && !holdingLarge) throw new Error(); holdingLarge = this.#largeResponse = true;
          const read = await readCapped(response, 256 * 1024 * 1024, () => {}, current); current();
          if (read.truncated) throw new Error();
          const headers: Record<string, string> = {};
          for (const name of RESPONSE_HEADERS) { const value = response.headers.get(name); if (value !== null) headers[name] = scrub(value); }
          if (sniffMediaMime(read.bytes, contentType)) {
            const media = await this.options.media!.ingest(scope.task!, read.bytes, contentType, current); current();
            return { ok: true, status: response.status, headers, media: { ...media, bytes: read.bytes.byteLength } };
          }
          if (["", "application/octet-stream", "binary/octet-stream"].includes(contentType)) {
            const probe = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes.subarray(0, 65_536), { stream: read.bytes.byteLength > 65_536 });
            if (probe && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(probe)) return { ok: true, status: response.status, headers,
              body: scrub(new TextDecoder().decode(read.bytes.subarray(0, MAX_RESPONSE))), ...(read.bytes.byteLength > MAX_RESPONSE ? { truncated: true } : {}) };
          }
          return { ok: false, message: "The response is not a supported media type." };
        }
        if (contentType !== "" && !contentType.startsWith("text/") && !["application/json", "application/xml", "application/x-www-form-urlencoded", "application/javascript"].includes(contentType)
          && !contentType.endsWith("+json") && !contentType.endsWith("+xml")) { await response.body?.cancel(); return { ok: false, message: "The response is not a supported text type." }; }
        const read = await readCapped(response, MAX_RESPONSE, () => {
          if (holdingLarge) return;
          if (this.#largeResponse) throw new Error("Large response channel busy.");
          holdingLarge = this.#largeResponse = true;
        }, current);
        current();
        const headers: Record<string, string> = {};
        for (const name of RESPONSE_HEADERS) { const value = response.headers.get(name); if (value !== null) headers[name] = scrub(value); }
        return { ok: true, status: response.status, headers, body: scrub(new TextDecoder().decode(read.bytes)), ...(read.truncated ? { truncated: true } : {}) };
      }
      throw new Error();
    } catch { return { ok: false, message: signal.aborted ? "Extension network request cancelled or timed out." : "Extension network request failed. Check its declared destinations and credential setup." }; }
    finally {
      clearTimeout(timer);
      await lastResponse?.body?.cancel().catch(() => undefined);
      if (holdingLarge) this.#largeResponse = false;
      if (admitted) {
        const remaining = (this.#inflight.get(scope.authorityKey) ?? 1) - 1;
        if (remaining) this.#inflight.set(scope.authorityKey, remaining); else this.#inflight.delete(scope.authorityKey);
      }
    }
  }
  async #exchange(scope: ExtensionNetworkScope, secret: ExtensionNetworkSecret, raw: string, signal: AbortSignal, secrets: Set<string>): Promise<string> {
    const key = `${scope.authorityKey}\0${secret.key}`, cached = this.#exchanged.get(key);
    if (cached?.source === raw && cached.expiresAt > Date.now()) return cached.value;
    let pending = this.#exchanging.get(key);
    if (!pending) {
      pending = this.#performExchange(scope, secret, raw, secrets).finally(() => this.#exchanging.delete(key));
      this.#exchanging.set(key, pending);
    }
    return await abortable(pending, signal);
  }
  async #performExchange(scope: ExtensionNetworkScope, secret: ExtensionNetworkSecret, raw: string, secrets: Set<string>): Promise<string> {
    const exchange = secret.exchange!;
    const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(15_000)]);
    const contentType = exchange.contentType ?? "application/json";
    const escaped = contentType === "application/json" ? JSON.stringify(raw).slice(1, -1) : encodeURIComponent(raw);
    scope.assertCurrent(); signal.throwIfAborted();
    const response = await this.options.fetch(extensionNetworkUrl(exchange.url, scope.declaration.hosts), {
      method: "POST", headers: { "content-type": contentType }, body: exchange.bodyFormat.replace("{value}", () => escaped), redirect: "manual", signal
    });
    if (response.status < 200 || response.status >= 300) { await response.body?.cancel(); throw new Error(); }
    const read = await readCapped(response, 256 * 1024, () => {}, () => { signal.throwIfAborted(); scope.assertCurrent(); });
    if (read.truncated) throw new Error();
    let value: unknown = JSON.parse(new TextDecoder().decode(read.bytes));
    for (const part of exchange.tokenPath.split(".")) value = value && typeof value === "object" && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
    if (typeof value !== "string" || !value || value.length > 16_384 || /[\r\n]/u.test(value)) throw new Error();
    secrets.add(value); signal.throwIfAborted(); scope.assertCurrent();
    this.#exchanged.set(`${scope.authorityKey}\0${secret.key}`, { source: raw, value, expiresAt: Date.now() + (exchange.ttlSeconds ?? 3600) * 1000 });
    return value;
  }
}

async function readCapped(response: Response, maximum: number, large: () => void, current: () => void): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, truncated = false, done = false;
  try {
    while (!done) {
      current(); const chunk = await reader.read(); current();
      if (chunk.done) { done = true; break; }
      const remaining = maximum - size;
      if (size + chunk.value.byteLength > 1024 * 1024) large();
      chunks.push(chunk.value.subarray(0, remaining)); size += Math.min(remaining, chunk.value.byteLength);
      if (chunk.value.byteLength > remaining) { truncated = true; break; }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, truncated };
  } finally { if (!done) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { abort = () => reject(new Error("Cancelled.")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([value, aborted]); } finally { signal.removeEventListener("abort", abort); }
}
