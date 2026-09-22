import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { MessagingTransportError } from "../types.js";
import { validateWeChatHttpsUrl, type WeChatFetch } from "./api.js";
import { weChatCancelled, weChatHttp, weChatInvalid, weChatMalformed, weChatNetwork } from "./errors.js";
import { decryptWeChatMedia, WECHAT_MEDIA_CIPHER_MAXIMUM_BYTES } from "./media-crypto.js";
import type { WeChatTransientMedia } from "./model.js";

const CDN_ORIGIN = "https://novac2c.cdn.weixin.qq.com";
const MEDIA_TIMEOUT_MS = 30_000;
const UPLOAD_REPLY_MAXIMUM_BYTES = 64 * 1_024;

export interface WeChatMediaTransferOptions {
  /** Fixture seam; production uses pinned HTTPS and one validated DNS answer. */
  readonly fetch?: WeChatFetch;
  readonly resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  readonly timeoutMs?: number;
}

export async function downloadWeChatMedia(
  ref: WeChatTransientMedia,
  signal: AbortSignal,
  options: WeChatMediaTransferOptions = {}
): Promise<Uint8Array> {
  const url = downloadUrl(ref);
  const response = await mediaRequest(url, "GET", undefined, signal, WECHAT_MEDIA_CIPHER_MAXIMUM_BYTES, options);
  if (response.status < 200 || response.status >= 300) throw weChatHttp(response.status, "WeChat media download failed.", "none");
  const ciphertext = await readBoundedBytes(response, WECHAT_MEDIA_CIPHER_MAXIMUM_BYTES);
  return decryptWeChatMedia({
    ciphertext,
    ...(ref.aesKeyBase64 === undefined ? {} : { aesKeyBase64: ref.aesKeyBase64 }),
    ...(ref.aesKeyHex === undefined ? {} : { aesKeyHex: ref.aesKeyHex }),
    ...(ref.byteLength === undefined ? {} : { expectedPlainBytes: ref.byteLength }),
    ...(ref.encryptedByteLength === undefined ? {} : { expectedCipherBytes: ref.encryptedByteLength }),
    ...(ref.md5Hex === undefined ? {} : { md5Hex: ref.md5Hex })
  });
}

export async function uploadWeChatCiphertext(input: {
  readonly fullUrl?: string;
  readonly uploadParam?: string;
  readonly fileKey: string;
  readonly ciphertext: Uint8Array;
}, signal: AbortSignal, options: WeChatMediaTransferOptions = {}): Promise<string> {
  if (input.ciphertext.byteLength < 16 || input.ciphertext.byteLength > WECHAT_MEDIA_CIPHER_MAXIMUM_BYTES
    || input.ciphertext.byteLength % 16 !== 0) throw weChatInvalid("WeChat upload ciphertext size is invalid.");
  const url = uploadUrl(input);
  const response = await mediaRequest(url, "POST", input.ciphertext, signal, UPLOAD_REPLY_MAXIMUM_BYTES, options);
  if (response.status !== 200) throw weChatHttp(response.status, "WeChat media upload failed.", "unknown");
  await readBoundedBytes(response, UPLOAD_REPLY_MAXIMUM_BYTES);
  const parameter = response.headers.get("x-encrypted-param")?.trim();
  if (parameter === undefined || parameter.length < 1 || parameter.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(parameter)) {
    throw weChatMalformed("WeChat media upload omitted a valid download reference.", false);
  }
  return parameter;
}

function downloadUrl(ref: WeChatTransientMedia): URL {
  if (ref.downloadUrl !== undefined) return mediaUrl(ref.downloadUrl, "WeChat media URL");
  if (ref.encryptedQuery === undefined || ref.encryptedQuery.trim() === "" || ref.encryptedQuery.length > 8_192) {
    throw weChatInvalid("WeChat media download reference is missing.");
  }
  const url = new URL("/c2c/download", CDN_ORIGIN);
  url.searchParams.set("encrypted_query_param", ref.encryptedQuery);
  return url;
}

function uploadUrl(input: { readonly fullUrl?: string; readonly uploadParam?: string; readonly fileKey: string }): URL {
  if (input.fullUrl !== undefined && input.fullUrl.trim() !== "") return mediaUrl(input.fullUrl, "WeChat upload URL");
  if (input.uploadParam === undefined || input.uploadParam.trim() === "" || input.uploadParam.length > 8_192
    || !/^[a-f0-9]{32}$/iu.test(input.fileKey)) throw weChatInvalid("WeChat upload reference is invalid.");
  const url = new URL("/c2c/upload", CDN_ORIGIN);
  url.searchParams.set("encrypted_query_param", input.uploadParam);
  url.searchParams.set("filekey", input.fileKey);
  return url;
}

function mediaUrl(value: string, label: string): URL {
  if (value.length > 16_384) throw weChatInvalid(`${label} is too long.`);
  const url = validateWeChatHttpsUrl(value, label);
  if (url.hash !== "") throw weChatInvalid(`${label} contains a fragment.`);
  return url;
}

async function mediaRequest(
  url: URL,
  method: "GET" | "POST",
  body: Uint8Array | undefined,
  signal: AbortSignal,
  maximumResponseBytes: number,
  options: WeChatMediaTransferOptions
): Promise<Response> {
  const timeout = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw weChatInvalid("WeChat media timeout is invalid.");
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  timer.unref?.();
  try {
    if (options.fetch !== undefined) {
      return await options.fetch(url, {
        method,
        redirect: "manual",
        signal: controller.signal,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(body) })
      });
    }
    return await pinnedHttpsRequest(url, method, body, controller.signal, maximumResponseBytes, options.resolveAddresses);
  } catch (error) {
    if (signal.aborted) throw weChatCancelled();
    if (error instanceof MessagingTransportError) throw error;
    throw weChatNetwork(timedOut ? "WeChat media transfer timed out." : "WeChat media transfer failed.", method === "POST" ? "unknown" : "none");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function pinnedHttpsRequest(
  url: URL,
  method: "GET" | "POST",
  body: Uint8Array | undefined,
  signal: AbortSignal,
  maximumResponseBytes: number,
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>
): Promise<Response> {
  const answers = resolveAddresses === undefined
    ? (await lookup(url.hostname, { all: true })).map((answer) => answer.address)
    : await resolveAddresses(url.hostname);
  signal.throwIfAborted();
  if (answers.length === 0 || answers.some((answer) => !isPublicAddress(answer))) {
    throw weChatInvalid("WeChat media host did not resolve to a public address.");
  }
  const pinned = answers[0]!;
  return await new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { Host: url.hostname, Accept: "*/*" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(body.byteLength);
    }
    const request = httpsRequest({
      hostname: pinned,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method,
      servername: url.hostname,
      headers,
      rejectUnauthorized: true,
      signal
    }, async (incoming) => {
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of incoming) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += part.byteLength;
          if (total > maximumResponseBytes) throw weChatMalformed("WeChat media response exceeded the size limit.", false);
          chunks.push(part);
        }
        const headerEntries: [string, string][] = Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500, headers: headerEntries }));
      } catch (error) { request.destroy(); reject(error); }
    });
    request.once("error", reject);
    if (body === undefined) request.end(); else request.end(Buffer.from(body));
  });
}

export function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const parts = value.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === undefined || b === undefined || c === undefined) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && b >= 18 && b <= 19) return false;
    return true;
  }
  if (family === 6) {
    const normalized = value.toLowerCase();
    return (normalized.startsWith("2") || normalized.startsWith("3")) && !normalized.includes(".");
  }
  return false;
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  const declared = rawLength === null ? null : Number(rawLength);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes)) {
    throw weChatMalformed("WeChat media response exceeded the size limit.", false);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw weChatMalformed("WeChat media response exceeded the size limit.", false);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map((part) => Buffer.from(part)));
}
