import { createConnectionFetch } from "@joko/connection-transport";
import { allowMobileExtensionMainViewNavigation, type MobileExtensionMainViewResource, type MobileExtensionMainViewSurface, type MobileExtensionResourceKind } from "./mobile-extensions";
import type { PairedCredential } from "./network";

export const MOBILE_EXTENSION_RESOURCE_MAXIMUM_BYTES = 256 * 1024 * 1024;
export const MOBILE_EXTENSION_STYLE_MAXIMUM_BYTES = 16 * 1024 * 1024;

/** Public locators and one-use surface tokens remain inside the pinned channel. */
export async function readMobileExtensionMainViewResource(credential: PairedCredential,
  surface: MobileExtensionMainViewSurface, candidate: string, kind: MobileExtensionResourceKind, signal?: AbortSignal, text?: string
): Promise<MobileExtensionMainViewResource> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(surface.expiresAt) || surface.expiresAt <= Date.now() || new URL(surface.url).origin !== new URL(credential.origin).origin
    || !allowMobileExtensionMainViewNavigation(surface, candidate)) throw new Error("The Extension resource belongs to another surface.");
  if (kind === "style-text" ? typeof text !== "string" || new TextEncoder().encode(text).byteLength > MOBILE_EXTENSION_STYLE_MAXIMUM_BYTES : text !== undefined) {
    throw new Error("The Extension style source is invalid or exceeds its budget.");
  }
  const url = new URL(candidate); url.hash = "";
  const lifetime = new AbortController();
  const ownerAbort = (): void => lifetime.abort(signal?.reason);
  signal?.addEventListener("abort", ownerAbort, { once: true });
  if (signal?.aborted) ownerAbort();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expire = (): void => {
    const remaining = surface.expiresAt - Date.now();
    if (remaining <= 0) lifetime.abort(new DOMException("The Extension surface expired.", "TimeoutError"));
    else deadline = setTimeout(expire, Math.min(remaining, 2_147_483_647));
  };
  expire();
  const transfer = lifetime.signal;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = (): void => { void reader?.cancel().catch(() => undefined); };
  transfer.addEventListener("abort", abort, { once: true });
  try {
    transfer.throwIfAborted();
    response = await createConnectionFetch(credential)(url.href, {
      method: kind === "style-text" ? "POST" : "GET",
      headers: { authorization: `Bearer ${credential.authKey}`, ...(kind !== "media" ? { "x-joko-isolated-document": kind === "document" ? "1" : kind } : {}),
        ...(kind === "style-text" ? { "content-type": "text/css" } : {}) },
      ...(kind === "style-text" ? { body: text } : {}),
      signal: transfer, redirect: "error", cache: "no-store"
    });
    transfer.throwIfAborted();
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const length = response.headers.get("content-length")?.trim();
    const expectedMime = kind === "document" ? mimeType === "text/html" : kind === "media" ? mimeType !== undefined && /^(?:image|audio|video)\/[a-z0-9.+-]+$/u.test(mimeType)
      : kind === "style" || kind === "style-text" ? mimeType === "text/css" : mimeType === "text/javascript" || mimeType === "application/javascript";
    if (!response.ok || mimeType === undefined || !expectedMime
      || length === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(length) || BigInt(length) > BigInt(MOBILE_EXTENSION_RESOURCE_MAXIMUM_BYTES)) {
      throw new Error("The Extension resource response is invalid or exceeds its budget.");
    }
    reader = response.body?.getReader();
    const expected = Number(length), bytes = new Uint8Array(expected);
    if (reader === undefined && expected > 0) throw new Error("A streaming Extension resource is required.");
    let consumed = 0;
    while (reader !== undefined) {
      transfer.throwIfAborted();
      const next = await reader.read();
      transfer.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || consumed + next.value.byteLength > expected) throw new Error("The Extension resource exceeded its declared length.");
      bytes.set(next.value, consumed); consumed += next.value.byteLength;
    }
    if (consumed !== expected || surface.expiresAt <= Date.now()) throw new Error("The Extension resource changed or expired while reading.");
    transfer.throwIfAborted();
    return { bytes, mimeType };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", ownerAbort);
    transfer.removeEventListener("abort", abort);
    if (reader !== undefined) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else await response?.body?.cancel().catch(() => undefined);
  }
}
