import { join } from "node:path";
import { atomicWriteFile } from "./config.js";
import { managedRuntimeFactorySource } from "./managed-runtime-factory-source.js";
import { isUnsupportedCacheOptionError } from "./request-option-compatibility.js";

export async function provisionManagedRequestOptionRecovery(agentHome: string): Promise<string> {
  const root = join(agentHome, "managed");
  await atomicWriteFile(join(root, "joko-managed-cache-option-error.mjs"),
    managedRuntimeFactorySource("isUnsupportedCacheOptionError", isUnsupportedCacheOptionError));
  const path = join(root, "joko-managed-request-option-recovery.ts");
  await atomicWriteFile(path, MANAGED_REQUEST_OPTION_RECOVERY_SOURCE);
  return path;
}

/** Private control requests carry digests and leases, never URLs, bodies or credentials. */
export const MANAGED_REQUEST_OPTION_RECOVERY_SOURCE = String.raw`import { createHash, randomUUID } from "node:crypto";
import { isUnsupportedCacheOptionError } from "./joko-managed-cache-option-error.mjs";

type Model = { api?: string; provider?: string; id?: string; baseUrl?: string };
type Context = { model?: Model; hasUI: boolean; ui: { input(title: string, placeholder: string): Promise<string | undefined> } };
type RequestState = { model: Model; context: Context; epoch: number };
type InstalledState = { originalFetch: typeof globalThis.fetch; requests: Map<string, RequestState>; epoch: number };
const INSTALLED = Symbol.for("joko.request-option-recovery.fetch.v1");
const MARKER = "x-joko-cache-compatibility-request";
const PREFIX = "joko:cache-compatibility/v1/";
const MAX_ERROR_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function route(model: Model) {
  if (model.api !== "openai-completions" || !model.provider || !model.id || !model.baseUrl) return undefined;
  try {
    const url = new URL(model.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return undefined;
    url.hash = "";
    return { providerId: model.provider, wireModelId: model.id,
      routeKey: createHash("sha256").update(JSON.stringify(["pi-cache-v1", model.api, url.href])).digest("hex") };
  } catch { return undefined; }
}

function exactRequest(request: Request, model: Model): boolean {
  if (request.method !== "POST" || !model.baseUrl
    || !(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return false;
  try {
    const base = model.baseUrl;
    const expected = new URL(base + (base.endsWith("/") ? "chat/completions" : "/chat/completions"));
    const actual = new URL(request.url);
    expected.hash = actual.hash = "";
    // Match the installed SDK's URL construction, including query routing.
    expected.searchParams.sort(); actual.searchParams.sort();
    return expected.href === actual.href;
  } catch { return false; }
}

async function privateRequest(context: Context, value: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!context.hasUI) return {};
  try {
    const encoded = Buffer.from(JSON.stringify({ version: 1, ...value }), "utf8").toString("base64url");
    if (encoded.length > 4 * 1024) return {};
    const response = await context.ui.input(PREFIX + encoded, "");
    const result: unknown = JSON.parse(response ?? "{}");
    return isRecord(result) ? result : {};
  } catch { return {}; }
}

function withPayload(request: Request, payload: Record<string, unknown>): Request {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const next = { ...payload };
  delete next.prompt_cache_key;
  delete next.prompt_cache_retention;
  return new Request(request, { headers, body: JSON.stringify(next) });
}

async function errorText(response: Response, signal: AbortSignal): Promise<string | undefined> {
  if (Number(response.headers.get("content-length")) > MAX_ERROR_BYTES) return undefined;
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const decoder = new TextDecoder();
  let size = 0, result = "";
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) return result + decoder.decode();
      size += part.value.byteLength;
      if (size > MAX_ERROR_BYTES) { void reader.cancel().catch(() => undefined); return undefined; }
      result += decoder.decode(part.value, { stream: true });
    }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

export default function install(pi: { on(event: string, handler: (...args: any[]) => unknown): void }): void {
  const global = globalThis as typeof globalThis & { [INSTALLED]?: InstalledState };
  if (typeof globalThis.fetch !== "function"
    || process.env.JOKO_PI_REQUEST_OPTION_RECOVERY !== "1") return;
  const existing = global[INSTALLED];
  const installed = existing ?? { originalFetch: globalThis.fetch.bind(globalThis), requests: new Map<string, RequestState>(), epoch: 0 };
  global[INSTALLED] = installed;
  const { originalFetch, requests } = installed;
  // Native model/configuration reloads initialize a fresh extension runner.
  // Rebind its handlers while retaining the one installed transport wrapper.
  installed.epoch++;
  requests.clear();
  for (const event of ["model_select", "session_switch", "before_agent_start"]) {
    pi.on(event, () => { installed.epoch++; requests.clear(); });
  }
  pi.on("before_provider_headers", (event: { headers: Record<string, string | null> }, context: Context) => {
    if (!context.model || !route(context.model)) return;
    const token = randomUUID();
    requests.set(token, { model: { ...context.model }, context, epoch: installed.epoch });
    if (requests.size > 64) requests.delete(requests.keys().next().value!);
    event.headers[MARKER] = token;
  });
  if (existing) return;

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const suppliedHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const token = new Headers(suppliedHeaders).get(MARKER);
    if (!token) return originalFetch(input, init);
    let request: Request;
    try { request = new Request(input, init); } catch { return originalFetch(input, init); }
    const state = requests.get(token);
    const headers = new Headers(request.headers);
    headers.delete(MARKER);
    request = new Request(request, { headers });
    if (!state || state.epoch !== installed.epoch || !exactRequest(request, state.model)) return originalFetch(request);
    request.signal.throwIfAborted();
    let payload: unknown;
    try { payload = await request.clone().json(); } catch { return originalFetch(request); }
    if (!isRecord(payload) || payload.model !== state.model.id) return originalFetch(request);
    const receipt = route(state.model);
    if (!receipt) return originalFetch(request);
    const hasCacheOptions = Object.hasOwn(payload, "prompt_cache_key") || Object.hasOwn(payload, "prompt_cache_retention");
    const prepared = await privateRequest(state.context, { action: "prepare", route: receipt, hasCacheOptions });
    request.signal.throwIfAborted();
    if (state.epoch !== installed.epoch || prepared.current !== true) throw new DOMException("Provider request ownership changed", "AbortError");
    const first = await originalFetch(prepared.applied === true ? withPayload(request, payload) : request);
    // A rule already applied to this wire request never authorizes another replay.
    if (first.status !== 400 || prepared.applied === true || !hasCacheOptions || typeof prepared.lease !== "string") return first;
    request.signal.throwIfAborted();
    let text: string | undefined;
    try { text = await errorText(first, request.signal); } catch {
      request.signal.throwIfAborted(); return first;
    }
    if (text === undefined || !isUnsupportedCacheOptionError(text)) return first;
    const learned = await privateRequest(state.context, { action: "learn", lease: prepared.lease });
    request.signal.throwIfAborted();
    if (state.epoch !== installed.epoch || learned.replay !== true || learned.applied !== true) return first;
    void first.body?.cancel().catch(() => undefined);
    // Reuse the exact accepted HTTP body and signal. No second native user turn.
    return originalFetch(withPayload(request, payload));
  };
}
`;
