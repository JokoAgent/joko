import { containsRecognizedCredential } from "@joko/core";

export interface PublicSearchRequest {
  readonly url: string;
  readonly limit: number;
}

export function readPublicSearchInput(input: Readonly<Record<string, unknown>>, defaultLimit: number, maximumLimit: number) {
  if (Object.keys(input).some(key => key !== "query" && key !== "limit")) throw new Error("Unknown public search input.");
  const query = typeof input["query"] === "string" ? input["query"].trim() : "";
  if (!query || query.length > 4_096 || /[\u0000-\u001f]/u.test(query) || containsRecognizedCredential(query)) {
    throw new Error("Provide search keywords without credentials.");
  }
  const raw = input["limit"];
  const limit = raw === undefined || raw === null ? defaultLimit
    : typeof raw === "number" || typeof raw === "string" && /^[0-9]+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumLimit) {
    throw new Error(`Search limit must be an integer from 1 to ${maximumLimit}.`);
  }
  return { query, limit };
}

export async function readPublicSearchResponse(
  request: PublicSearchRequest, fetcher: typeof fetch, accept: string, signal?: AbortSignal
): Promise<string> {
  const deadline = AbortSignal.timeout(20_000);
  const response = await fetcher(request.url, { method: "GET", credentials: "omit", redirect: "error",
    referrerPolicy: "no-referrer", headers: { accept },
    signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]) });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`The public search API returned HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("The public search result exceeded its size limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  return text;
}
