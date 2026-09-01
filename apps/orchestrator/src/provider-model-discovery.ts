export interface DiscoveredProviderModel {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
}

export interface ProviderModelDiscoverySpec {
  readonly baseUrl: string;
  readonly api?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
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

export function deriveProviderModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.hash = "";
  let pathname = url.pathname;
  while (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  url.pathname = /\/v\d+$/iu.test(pathname)
    ? `${pathname}/models`
    : `${pathname === "/" ? "" : pathname}/v1/models`;
  return url.toString();
}

export function parseProviderModels(value: unknown): readonly DiscoveredProviderModel[] {
  if (!isRecord(value)) return [];
  const list = Array.isArray(value["data"])
    ? value["data"]
    : Array.isArray(value["models"])
      ? value["models"]
      : undefined;
  if (list === undefined) return [];
  const result: DiscoveredProviderModel[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const record = isRecord(item) ? item : undefined;
    const id = typeof item === "string"
      ? item
      : typeof record?.["id"] === "string"
        ? record["id"]
        : typeof record?.["slug"] === "string"
          ? record["slug"]
          : undefined;
    if (!validIdentity(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof record?.["display_name"] === "string" && validLabel(record["display_name"])
      ? record["display_name"]
      : typeof record?.["name"] === "string" && validLabel(record["name"])
        ? record["name"]
        : id;
    const rawWindow = record === undefined
      ? undefined
      : [
        record["context_length"],
        record["context_window"],
        record["max_context_length"],
        record["max_input_tokens"]
      ].find(validPositiveInteger);
    result.push({
      id,
      name,
      ...(typeof rawWindow === "number" ? { contextWindow: Math.floor(rawWindow) } : {})
    });
  }
  return result;
}

export async function fetchProviderModels(
  spec: ProviderModelDiscoverySpec,
  fetchImpl: typeof fetch = fetch
): Promise<readonly DiscoveredProviderModel[]> {
  const baseUrl = safeDiscoveryBaseUrl(spec.baseUrl);
  if (baseUrl === undefined) throw new ProviderModelDiscoveryError("unsafe_endpoint");
  const headers = discoveryHeaders(spec);
  if (!hasAuthentication(headers) && baseUrl.protocol !== "http:") {
    throw new ProviderModelDiscoveryError("unsafe_endpoint");
  }
  if (!hasAuthentication(headers) && !isLoopback(baseUrl.hostname)) {
    throw new ProviderModelDiscoveryError("unsafe_endpoint");
  }
  let response: Response;
  try {
    response = await fetchImpl(deriveProviderModelsUrl(baseUrl.toString()), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
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
    body = await response.text();
  } catch {
    throw new ProviderModelDiscoveryError("invalid_response");
  }
  if (Buffer.byteLength(body, "utf8") > MAXIMUM_RESPONSE_BYTES) {
    throw new ProviderModelDiscoveryError("invalid_response");
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new ProviderModelDiscoveryError("invalid_response");
  }
  const models = parseProviderModels(value);
  if (models.length === 0) throw new ProviderModelDiscoveryError("invalid_response");
  return models;
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

function hasAuthentication(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name === "authorization" || name === "x-api-key");
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
