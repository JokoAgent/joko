import { join } from "node:path";
import { atomicWriteFile, atomicWriteJson } from "./config.js";

export const MANAGED_SILENT_ENCRYPTED_RETRY_FILE_NAME = "joko-managed-silent-encrypted-retry.ts";
export const SILENT_ENCRYPTED_RETRY_CONTROL_ENV = "JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE";
export const SILENT_ENCRYPTED_RETRY_DEFAULT_ENABLED = true;

const INVALID_ENCRYPTED_CONTENT_RE =
  /invalid_encrypted_content|invalid-argument[\s\S]{0,160}encrypted_content|could not decrypt(?: the provided)? encrypted_content|encrypted content could not be (?:decrypted|verified|parsed)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The closed 400/422 error family observed on Responses-compatible routes. */
export function isInvalidEncryptedContentError(value: string): boolean {
  return INVALID_ENCRYPTED_CONTENT_RE.test(value);
}

/**
 * Remove only top-level Responses reasoning replay items that carry an
 * encrypted_content value. Compaction/context_compaction blobs and nested
 * business payloads are deliberately untouched.
 */
export function stripResponsesReasoningEncryptedContent(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.input)) return undefined;
  let removed = 0;
  const input = parsed.input.filter((item) => {
    if (!isRecord(item) || item.type !== "reasoning" || typeof item.encrypted_content !== "string") return true;
    removed += 1;
    return false;
  });
  if (removed === 0) return undefined;
  return JSON.stringify({ ...parsed, input });
}

export async function writeSilentEncryptedRetryControl(
  path: string,
  generation: number,
  enabled: boolean
): Promise<void> {
  await atomicWriteJson(path, { format: 1, generation, enabled });
}

export async function provisionManagedSilentEncryptedRetry(agentHome: string): Promise<string> {
  const path = join(agentHome, "managed", MANAGED_SILENT_ENCRYPTED_RETRY_FILE_NAME);
  await atomicWriteFile(path, MANAGED_SILENT_ENCRYPTED_RETRY_SOURCE);
  return path;
}

/**
 * A service-owned Pi extension. It wraps the process-global fetch before Pi
 * creates a Responses client. The wrapper is intentionally silent: neither
 * request/error bodies nor encrypted values enter stdout, stderr, or events.
 */
export const MANAGED_SILENT_ENCRYPTED_RETRY_SOURCE = String.raw`import { readFileSync } from "node:fs";

type Control = { format: 1; generation: number; enabled: boolean };
type RouteState = { route: string; model: string };
type InstalledState = {
  originalFetch: typeof globalThis.fetch;
  current?: RouteState;
  active?: RouteState;
};

const CONTROL_ENV = "JOKO_PI_SILENT_ENCRYPTED_RETRY_CONTROL_FILE";
const PROVIDER_MARKER_HEADER = "x-joko-silent-encrypted-retry-provider";
const MAX_ERROR_BYTES = 64 * 1024;
const INSTALLED = Symbol.for("joko.silent-encrypted-retry.fetch.v1");
const INVALID_ENCRYPTED_CONTENT_RE =
  /invalid_encrypted_content|invalid-argument[\s\S]{0,160}encrypted_content|could not decrypt(?: the provided)? encrypted_content|encrypted content could not be (?:decrypted|verified|parsed)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnabled(controlPath: string, expectedGeneration: number): boolean {
  try {
    const value = JSON.parse(readFileSync(controlPath, "utf8")) as unknown;
    return isRecord(value) && value.format === 1 && value.generation === expectedGeneration && value.enabled === true;
  } catch {
    return false;
  }
}

function isResponsesRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  let url: URL;
  try { url = new URL(request.url); } catch { return false; }
  const path = url.pathname.replace(/\/+$/u, "");
  if (!/(?:^|\/)responses$/u.test(path)) return false;
  return (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function stripReasoning(body: string): { body: string; model: string } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { return undefined; }
  if (!isRecord(parsed) || !Array.isArray(parsed.input) || typeof parsed.model !== "string" || parsed.model.length === 0) {
    return undefined;
  }
  let removed = 0;
  const input = parsed.input.filter((item) => {
    if (!isRecord(item) || item.type !== "reasoning" || typeof item.encrypted_content !== "string") return true;
    removed += 1;
    return false;
  });
  if (removed === 0) return undefined;
  return { body: JSON.stringify({ ...parsed, input }), model: parsed.model };
}

function modelFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function routeFromRequest(request: Request): string | undefined {
  try {
    const url = new URL(request.url);
    return url.origin + url.pathname.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
}

function sameRoute(left: RouteState | undefined, right: RouteState | undefined): boolean {
  return left !== undefined && right !== undefined && left.route === right.route && left.model === right.model;
}

function requestWithBody(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, { body, headers });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  throwIfAborted(signal);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const pending = reader.read();
  try {
    return await Promise.race([pending, aborted]);
  } catch (error) {
    if (!signal.aborted) throw error;
    void reader.cancel().catch(() => undefined);
    await pending.catch(() => undefined);
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function boundedErrorText(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ERROR_BYTES) return undefined;
  const body = response.clone().body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal);
      if (chunk.done) return text + decoder.decode();
      total += chunk.value.byteLength;
      if (total > MAX_ERROR_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

type PiExtensionApi = {
  on(event: "model_select", handler: () => void): void;
  on(
    event: "before_provider_headers",
    handler: (
      event: { headers: Record<string, string | null> },
      context: { model?: { api?: string } }
    ) => void
  ): void;
};

export default function installSilentEncryptedRetry(pi?: PiExtensionApi): void {
  const processGlobal = globalThis as typeof globalThis & { [INSTALLED]?: InstalledState };
  if (processGlobal[INSTALLED] !== undefined || typeof globalThis.fetch !== "function" || pi === undefined) return;
  const controlPath = process.env[CONTROL_ENV];
  const generation = Number(process.env.JOKO_PI_GENERATION);
  if (typeof controlPath !== "string" || !Number.isSafeInteger(generation) || generation < 0) return;

  const originalFetch = globalThis.fetch.bind(globalThis);
  const installed: InstalledState = { originalFetch };
  processGlobal[INSTALLED] = installed;
  pi.on("model_select", () => {
    installed.current = undefined;
    installed.active = undefined;
  });
  pi.on("before_provider_headers", (event, context) => {
    if (context.model?.api === "openai-responses") event.headers[PROVIDER_MARKER_HEADER] = "1";
  });

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let request: Request;
    try { request = new Request(input, init); } catch { return originalFetch(input, init); }
    if (request.headers.get(PROVIDER_MARKER_HEADER) !== "1") return originalFetch(input, init);
    const providerHeaders = new Headers(request.headers);
    providerHeaders.delete(PROVIDER_MARKER_HEADER);
    request = new Request(request, { headers: providerHeaders });
    if (!isResponsesRequest(request) || !readEnabled(controlPath, generation)) return originalFetch(request);
    throwIfAborted(request.signal);

    let originalBody: string;
    try { originalBody = await request.clone().text(); } catch { return originalFetch(request); }
    const model = modelFromBody(originalBody);
    const route = routeFromRequest(request);
    const current = model === undefined || route === undefined ? undefined : { route, model };
    if (!sameRoute(installed.current, current)) {
      installed.current = current;
      installed.active = undefined;
    }
    const proactive = sameRoute(installed.active, current) ? stripReasoning(originalBody) : undefined;
    const firstRequest = proactive === undefined ? undefined : requestWithBody(request, proactive.body);
    const first = await (firstRequest === undefined ? originalFetch(request) : originalFetch(firstRequest));

    if ((first.status !== 400 && first.status !== 422) || !readEnabled(controlPath, generation)) return first;
    throwIfAborted(request.signal);
    let errorText: string | undefined;
    try { errorText = await boundedErrorText(first, request.signal); } catch (error) {
      throwIfAborted(request.signal);
      return first;
    }
    if (errorText === undefined || !INVALID_ENCRYPTED_CONTENT_RE.test(errorText)) return first;

    // An active route was already sent without reasoning ciphertext. Do not
    // turn a second failure into another retry for the same Pi operation.
    if (proactive !== undefined) return first;
    const stripped = stripReasoning(originalBody);
    if (stripped === undefined) return first;
    if (sameRoute(installed.current, current)) installed.active = current;
    throwIfAborted(request.signal);
    void first.body?.cancel().catch(() => undefined);
    return originalFetch(requestWithBody(request, stripped.body));
  };
}
`;
