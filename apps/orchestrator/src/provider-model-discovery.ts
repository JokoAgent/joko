import type { PiManagedModel } from "@joko/adapter-pi";

export interface DiscoveredProviderModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly metadata?: DiscoveredProviderModelMetadata;
  readonly cost?: NonNullable<PiManagedModel["cost"]>;
}

export interface DiscoveredProviderModelMetadata {
  readonly mode?: string;
  readonly name?: string;
  readonly contextWindowMax?: number;
  readonly maxOutputTokens?: number;
  readonly description?: string;
  readonly nativeApi?: "anthropic-messages" | "openai-responses" | "openai-completions" | "google-generative-ai";
  readonly inputModalities?: readonly string[];
  readonly outputModalities?: readonly string[];
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string | null;
  readonly supportsImages?: boolean;
  readonly supportsTools?: boolean;
  readonly supportsFastMode?: boolean;
}

export interface ProviderModelDiscoverySpec {
  readonly baseUrl: string;
  readonly modelsEndpoint?: string;
  readonly api?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Retain purpose facts for speech configuration and capability withdrawals. */
  readonly includeNonChat?: boolean;
}

export type ProviderModelDiscoveryErrorCode =
  | "unsafe_endpoint"
  | "unauthorized"
  | "unavailable"
  | "invalid_response";

export class ProviderModelDiscoveryError extends Error {
  constructor(readonly code: ProviderModelDiscoveryErrorCode) {
    super(discoveryErrorMessage(code));
    this.name = "ProviderModelDiscoveryError";
  }
}

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const MAXIMUM_DISCOVERY_PAGES = 100;
const MAXIMUM_DISCOVERED_MODELS = 10_000;

export function deriveProviderModelsUrl(baseUrl: string, api?: string): string {
  const url = new URL(baseUrl);
  url.hash = "";
  let pathname = url.pathname;
  while (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  const basePath = pathname === "/" ? "" : pathname;
  url.pathname = api === "google-generative-ai" || /\/v\d+$/iu.test(pathname)
    ? `${basePath}/models`
    : `${basePath}/v1/models`;
  return url.toString();
}

export function parseProviderModels(value: unknown, sourceUrl?: string, includeNonChat = false): readonly DiscoveredProviderModel[] {
  const list = modelList(value);
  if (list === undefined) return [];
  const result: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  const openRouter = officialModelsEndpoint(sourceUrl, "https://openrouter.ai/api/v1/models");
  for (const item of list) {
    const record = isRecord(item) ? item : undefined;
    const google = typeof record?.["name"] === "string" && record["name"].startsWith("models/")
      && Array.isArray(record["supportedGenerationMethods"]) && record["supportedGenerationMethods"].includes("generateContent") ? record : undefined;
    const id = modelIdentity(item, google !== undefined);
    if (!validIdentity(id) || seen.has(id)) continue;
    seen.add(id);
    const info = isRecord(record?.["model_info"]) ? record["model_info"] : {};
    const vercel = officialModelsEndpoint(sourceUrl, "https://ai-gateway.vercel.sh/v1/models");
    const architecture = isRecord(record?.["architecture"]) ? record["architecture"] : {};
    const elevenLabsMode = record?.["model_id"] === id && typeof record?.["can_do_text_to_speech"] === "boolean"
      ? record["can_do_text_to_speech"] ? "audio_speech" : "other" : undefined;
    const openRouterSpeech = openRouter
      && Array.isArray(architecture["output_modalities"]) && architecture["output_modalities"].includes("speech");
    const mode = record?.["mode"] ?? info["mode"] ?? elevenLabsMode ?? (openRouterSpeech ? "audio_speech" : undefined);
    // Importing a media/embedding model as a chat route would make it appear usable in the task picker.
    if (!includeNonChat && typeof mode === "string" && mode !== "chat"
      || vercel && record?.["type"] !== undefined && record["type"] !== "language") continue;
    const name = typeof google?.["displayName"] === "string" && validLabel(google["displayName"]) ? google["displayName"]
      : typeof record?.["display_name"] === "string" && validLabel(record["display_name"])
      ? record["display_name"]
      : google === undefined && typeof record?.["name"] === "string" && validLabel(record["name"])
        ? record["name"]
        : undefined;
    const rawWindow = record === undefined
      ? undefined
      : [
        record["context_length"],
        record["contextWindow"],
        record["context_window"],
        record["max_context_length"],
        record["max_input_tokens"],
        google?.["inputTokenLimit"],
        info["max_input_tokens"]
      ].find(validPositiveInteger);
    const speechModalities = openRouterSpeech ? stringList(architecture["output_modalities"]) : undefined;
    const metadata = {
      ...discoveredMetadata(record ?? {}, info, architecture, google, vercel, typeof rawWindow === "number" ? Math.floor(rawWindow) : undefined),
      ...(typeof mode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(mode) ? { mode } : {}),
      // OpenRouter's speech modality is its TTS catalog contract. Generic audio
      // output, custom endpoint paths and model names do not establish purpose.
      ...(speechModalities === undefined ? {} : { outputModalities: speechModalities.map(value => value === "speech" ? "audio" : value) }),
      ...(name === undefined ? {} : { name })
    };
    const cost = openRouter && !openRouterSpeech && (mode === undefined || mode === "chat") && metadata.outputModalities?.includes("text")
      ? parseOpenRouterTokenQuote(record?.["pricing"]) : undefined;
    result.push({
      id,
      name: name ?? id,
      ...(typeof rawWindow === "number" ? { contextWindow: Math.floor(rawWindow) } : {}),
      ...(cost === undefined ? {} : { cost }),
      ...(Object.keys(metadata).length ? { metadata } : {})
    });
  }
  return result;
}

function modelList(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value["data"])) return value["data"];
  return Array.isArray(value["models"]) ? value["models"] : undefined;
}

function modelIdentity(item: unknown, google: boolean): string | undefined {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return undefined;
  for (const field of ["id", "slug", "key", "model_name", "model_id"]) {
    const value = item[field];
    if (typeof value === "string") return value;
  }
  const name = item["name"];
  return google && typeof name === "string" && name.startsWith("models/") ? name.slice("models/".length) : undefined;
}

function parseOpenRouterTokenQuote(value: unknown): DiscoveredProviderModel["cost"] {
  if (!isRecord(value)) return undefined;
  const input = openRouterPerMillion(value["prompt"]);
  const output = openRouterPerMillion(value["completion"]);
  const cacheRead = openRouterPerMillion(value["input_cache_read"]);
  const cacheWrite = openRouterPerMillion(value["input_cache_write"]);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function openRouterPerMillion(value: unknown): number | undefined {
  const unitPrice = typeof value === "number" ? value : typeof value === "string" && value.length <= 64
    && /^[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/iu.test(value) ? Number(value) : NaN;
  const price = unitPrice * 1_000_000;
  if (price === 0 && typeof value === "string" && /[1-9]/u.test(value.split(/[eE]/u, 1)[0]!)) return undefined;
  return price >= 0 && Number.isSafeInteger(Math.round(price * 1_000_000)) ? price : undefined;
}

function discoveredMetadata(record: Readonly<Record<string, unknown>>, info: Readonly<Record<string, unknown>>,
  architecture: Readonly<Record<string, unknown>>, google: Readonly<Record<string, unknown>> | undefined, vercel: boolean, workingWindow: number | undefined): DiscoveredProviderModelMetadata {
  const result: Record<string, unknown> = {};
  const capabilities = isRecord(record["capabilities"]) ? record["capabilities"] : {};
  const reasoning = isRecord(record["reasoning"]) ? record["reasoning"] : {};
  const modalities = isRecord(record["modalities"]) ? record["modalities"] : {};
  const input = stringList(modalities["input"] ?? architecture["input_modalities"] ?? record["input_modalities"]);
  const output = stringList(modalities["output"] ?? architecture["output_modalities"]);
  if (input) result["inputModalities"] = input;
  if (output) result["outputModalities"] = output;
  const maximum = record["max_context_window"] ?? record["contextWindowMax"];
  if (validPositiveInteger(maximum) && (workingWindow === undefined || maximum >= workingWindow)) result["contextWindowMax"] = Math.floor(maximum);
  const top = isRecord(record["top_provider"]) ? record["top_provider"] : {};
  const limit = record["max_output_tokens"] ?? info["max_output_tokens"] ?? google?.["outputTokenLimit"]
    ?? record["maxOutputTokens"] ?? (vercel ? record["max_tokens"] : undefined) ?? top["max_completion_tokens"];
  if (validPositiveInteger(limit)) result["maxOutputTokens"] = Math.floor(limit);
  if (typeof record["description"] === "string" && validLabel(record["description"])) result["description"] = record["description"];
  const api = record["nativeApi"] ?? record["native_api"];
  if (typeof api === "string" && ["anthropic-messages", "openai-responses", "openai-completions", "google-generative-ai"].includes(api)) result["nativeApi"] = api;
  const declaredLevels = (value: unknown, key: string) => Array.isArray(value) ? value.map(row => isRecord(row) ? row[key] : row).filter(level => level !== "none") : undefined;
  const parameters = Array.isArray(record["supported_parameters"]) ? record["supported_parameters"] : undefined;
  const options = Array.isArray(record["reasoning_options"]) ? record["reasoning_options"] : [];
  const rawLevels = reasoning["supportedEfforts"] ?? declaredLevels(reasoning["supported_efforts"], "effort") ?? record["supported_efforts"]
    ?? declaredLevels(record["supported_reasoning_levels"], "effort")
    ?? (record["supportsReasoningEffort"] === false ? [] : declaredLevels(record["reasoningEfforts"], "value"))
    ?? (vercel ? options.find(row => isRecord(row) && row["type"] === "effort")?.["values"] : undefined)
    ?? (record["reasoning"] === false || info["supports_reasoning"] === false
      || parameters && !parameters.some(value => ["reasoning", "reasoning_effort", "reasoning_budget", "thinking"].includes(String(value))) ? [] : undefined);
  if (Array.isArray(rawLevels) && rawLevels.every(level => typeof level === "string" && EFFORTS.includes(level))) result["efforts"] = [...new Set(rawLevels)];
  const defaultEffort = [reasoning["defaultEffort"], reasoning["default_effort"], record["default_effort"], record["default_reasoning_level"], record["reasoningEffort"]]
    .find(value => value !== undefined);
  if (defaultEffort === null || defaultEffort === "none") result["defaultEffort"] = null;
  else if (typeof defaultEffort === "string" && EFFORTS.includes(defaultEffort)) result["defaultEffort"] = defaultEffort;
  const tiers = record["service_tiers"], additional = record["additional_speed_tiers"];
  const validTiers = Array.isArray(tiers) && tiers.every(row => isRecord(row) && typeof row["id"] === "string");
  const fast = record["supports_fast_mode"] ?? record["supportsServiceTier"]
    ?? (validTiers ? tiers.some(row => ["fast", "priority"].includes(String(row["id"]))) : Array.isArray(additional) ? additional.includes("fast") : undefined);
  const images = record["supports_image_input"] ?? info["supports_vision"] ?? capabilities["vision"] ?? (input ? input.includes("image") : undefined);
  const tools = parameters ? parameters.includes("tools") : info["supports_function_calling"] ?? capabilities["trained_for_tool_use"];
  for (const [key, value] of [["supportsImages", images], ["supportsTools", tools], ["supportsFastMode", fast]] as const) if (typeof value === "boolean") result[key] = value;
  return result as DiscoveredProviderModelMetadata;
}

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
function stringList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.length <= 16 && value.every(item => typeof item === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(item))
    && new Set(value).size === value.length ? [...value] : undefined;
}
function officialModelsEndpoint(value: string | undefined, endpoint: string): boolean {
  try { const url = new URL(value ?? ""), expected = new URL(endpoint); return url.origin === expected.origin && url.pathname.replace(/\/+$/u, "") === expected.pathname; } catch { return false; }
}

export async function fetchProviderModels(
  spec: ProviderModelDiscoverySpec,
  fetchImpl: typeof fetch = fetch
): Promise<readonly DiscoveredProviderModel[]> {
  const catalog = await fetchProviderModelCatalog(spec, fetchImpl);
  if (catalog.models.length === 0) throw new ProviderModelDiscoveryError("invalid_response");
  return catalog.models;
}

export async function fetchProviderModelCatalog(
  spec: ProviderModelDiscoverySpec,
  fetchImpl: typeof fetch = fetch
): Promise<{ readonly models: readonly DiscoveredProviderModel[]; readonly listedIds: ReadonlySet<string>; readonly complete: boolean }> {
  const baseUrl = safeDiscoveryBaseUrl(spec.baseUrl);
  if (baseUrl === undefined) throw new ProviderModelDiscoveryError("unsafe_endpoint");
  const headers = discoveryHeaders(spec);
  const authenticated = hasAuthentication(headers, spec.api);
  if (!authenticated && baseUrl.protocol !== "http:") {
    throw new ProviderModelDiscoveryError("unsafe_endpoint");
  }
  if (!authenticated && !isLoopback(baseUrl.hostname)) {
    throw new ProviderModelDiscoveryError("unsafe_endpoint");
  }
  let endpoint: URL;
  try {
    endpoint = spec.modelsEndpoint === undefined ? new URL(deriveProviderModelsUrl(baseUrl.toString(), spec.api)) : new URL(spec.modelsEndpoint);
    if (endpoint.origin !== baseUrl.origin || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "" || endpoint.search !== "") throw new Error("Model catalog authority differs.");
  } catch {
    throw new ProviderModelDiscoveryError("unavailable");
  }
  const sourceUrl = endpoint.toString();
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const { value: first, hasNextLink } = await fetchModelPage(sourceUrl, headers, signal, fetchImpl);
  const listedIds = new Set<string>();
  let validListing = true;
  const recordListing = (value: unknown): void => {
    const list = modelList(value);
    if (list === undefined) throw new ProviderModelDiscoveryError("invalid_response");
    for (const item of list) {
      const id = modelIdentity(item, spec.api === "google-generative-ai");
      if (!validIdentity(id)) validListing = false;
      else listedIds.add(id);
    }
    if (listedIds.size > MAXIMUM_DISCOVERED_MODELS) throw new ProviderModelDiscoveryError("invalid_response");
  };
  recordListing(first);
  let firstModels = parseProviderModels(first, sourceUrl, spec.includeNonChat);
  if (spec.includeNonChat && officialModelsEndpoint(sourceUrl, "https://openrouter.ai/api/v1/models")) {
    const speechEndpoint = new URL(endpoint);
    speechEndpoint.searchParams.set("output_modalities", "speech");
    try {
      const { value } = await fetchModelPage(speechEndpoint.toString(), headers, signal, fetchImpl);
      const speech = parseProviderModels(value, speechEndpoint.toString(), true);
      const combined = new Map(firstModels.map(model => [model.id, model]));
      for (const model of speech.filter(model => model.metadata?.mode === "audio_speech")) {
        const previous = combined.get(model.id);
        if (previous === undefined && combined.size >= MAXIMUM_DISCOVERED_MODELS) break;
        combined.set(model.id, { ...previous, ...model,
          name: model.metadata?.name ?? previous?.metadata?.name ?? model.name,
          metadata: { ...previous?.metadata, ...model.metadata } });
      }
      firstModels = [...combined.values()];
    } catch { /* The independent speech catalog must not discard a successful chat discovery. */ }
  }
  if (spec.api !== "anthropic-messages" || !isRecord(first) || first["has_more"] !== true) {
    return { models: firstModels, listedIds, complete: validListing && !hasNextLink && !catalogHasContinuation(first, listedIds.size) };
  }
  if (!Array.isArray(first["data"])) throw new ProviderModelDiscoveryError("invalid_response");

  const models = new Map(firstModels.map(model => [model.id, model]));
  const seenCursors = new Set<string>();
  let page = first;
  for (let count = 1; count < MAXIMUM_DISCOVERY_PAGES; count += 1) {
    const cursor = page["last_id"];
    if (!validIdentity(cursor) || seenCursors.has(cursor) || models.size > MAXIMUM_DISCOVERED_MODELS) {
      throw new ProviderModelDiscoveryError("invalid_response");
    }
    seenCursors.add(cursor);
    const next = new URL(endpoint);
    next.searchParams.set("after_id", cursor);
    const { value, hasNextLink } = await fetchModelPage(next.toString(), headers, signal, fetchImpl);
    if (!isRecord(value) || !Array.isArray(value["data"]) || typeof value["has_more"] !== "boolean") {
      throw new ProviderModelDiscoveryError("invalid_response");
    }
    recordListing(value);
    for (const model of parseProviderModels(value, sourceUrl, spec.includeNonChat)) if (!models.has(model.id)) models.set(model.id, model);
    if (!value["has_more"]) {
      return { models: [...models.values()], listedIds, complete: validListing && !hasNextLink && !catalogHasContinuation(value, listedIds.size) };
    }
    page = value;
  }
  throw new ProviderModelDiscoveryError("invalid_response");
}

function catalogHasContinuation(value: unknown, listedCount: number): boolean {
  if (!isRecord(value)) return false;
  const scopes = [value, value["pagination"]].filter(isRecord);
  return scopes.some(scope => scope["has_more"] === true || scope["hasMore"] === true
    || ["next", "next_cursor", "next_page", "next_page_token", "nextPageToken"].some(key => {
      const cursor = scope[key];
      return cursor !== undefined && cursor !== null && cursor !== "" && cursor !== false;
    }) || (typeof scope["total"] === "number" && scope["total"] > listedCount));
}

async function fetchModelPage(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal, fetchImpl: typeof fetch): Promise<{ value: unknown; hasNextLink: boolean }> {
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal
    });
  } catch {
    throw new ProviderModelDiscoveryError("unavailable");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProviderModelDiscoveryError("unauthorized");
  }
  if (!response.ok) throw new ProviderModelDiscoveryError("unavailable");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_RESPONSE_BYTES) {
    throw new ProviderModelDiscoveryError("invalid_response");
  }
  let body: string;
  try {
    body = await readBoundedResponse(response);
  } catch {
    throw new ProviderModelDiscoveryError("invalid_response");
  }
  try {
    return { value: JSON.parse(body) as unknown, hasNextLink: /;\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next\b)/iu.test(response.headers.get("link") ?? "") };
  } catch {
    throw new ProviderModelDiscoveryError("invalid_response");
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return Buffer.concat(chunks, byteLength).toString("utf8");
      }
      byteLength += value.byteLength;
      if (byteLength > MAXIMUM_RESPONSE_BYTES) {
        throw new ProviderModelDiscoveryError("invalid_response");
      }
      chunks.push(value);
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function discoveryHeaders(spec: ProviderModelDiscoverySpec): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    const lower = name.toLocaleLowerCase("en-US");
    if (spec.apiKey === undefined || (lower !== "authorization" && lower !== "x-api-key")) {
      result[lower] = value;
    }
  }
  if (spec.api === "anthropic-messages") {
    result["anthropic-version"] ??= "2023-06-01";
    if (spec.apiKey !== undefined) {
      result["x-api-key"] = spec.apiKey;
      result["authorization"] = `Bearer ${spec.apiKey}`;
    }
  } else if (spec.api === "google-generative-ai") {
    if (spec.apiKey !== undefined) result["x-goog-api-key"] = spec.apiKey;
  } else if (spec.apiKey !== undefined) {
    result["authorization"] = `Bearer ${spec.apiKey}`;
  }
  return result;
}

function safeDiscoveryBaseUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  for (const key of url.searchParams.keys()) {
    if (/(?:token|secret|key|password|auth|credential)/iu.test(key)) return undefined;
  }
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && isLoopback(url.hostname) ? url : undefined;
}

function hasAuthentication(headers: Readonly<Record<string, string>>, api: string | undefined): boolean {
  return Object.keys(headers).some((name) => name === "authorization" || name === "x-api-key"
    || api === "google-generative-ai" && name === "x-goog-api-key");
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLocaleLowerCase("en-US");
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]" || value === "::1";
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f\s]/u.test(value);
}

function validLabel(value: string): boolean {
  return value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(Math.floor(value)) && Math.floor(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function discoveryErrorMessage(code: ProviderModelDiscoveryErrorCode): string {
  if (code === "unauthorized") return "The Provider rejected model catalog access.";
  if (code === "unavailable") return "The Provider model catalog is temporarily unavailable.";
  if (code === "invalid_response") return "The Provider returned an invalid model catalog.";
  return "The Provider model catalog endpoint is not safe to access.";
}
