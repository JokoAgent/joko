import http from "node:http";

import { LocalRuntimeError, pullError } from "./errors.js";
import { isOllamaModelName, isSafeDigest } from "./security.js";
import type { OllamaModelDetails, OllamaPullEvent, OllamaTag } from "./types.js";
import { OLLAMA_LOOPBACK_ORIGIN } from "./types.js";

const PROBE_TIMEOUT_MS = 1_500;
const API_TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_PULL_LINE_BYTES = 64 * 1024;

export type RuntimeFetch = (
  input: string,
  init: RequestInit & { readonly redirect: "manual"; readonly signal: AbortSignal }
) => Promise<Response>;

function endpoint(path: "/api/version" | "/api/tags" | "/api/show" | "/api/pull" | "/api/delete"): string {
  return `${OLLAMA_LOOPBACK_ORIGIN}${path}`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime response is too large.");
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime response is too large.");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new LocalRuntimeError("PORT_CONFLICT", "The loopback port did not return a valid runtime response.");
  }
}

function assertResponse(response: Response): void {
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new LocalRuntimeError("PORT_CONFLICT", "The loopback port redirected away from the local runtime.");
  }
}

async function fetchWithTimeout(
  fetchImpl: RuntimeFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.");
    if (controller.signal.aborted) throw new LocalRuntimeError("RUNTIME_UNREACHABLE", "The local runtime did not respond in time.");
    const text = error instanceof Error ? error.message : String(error);
    if (/refused|fetch failed|econnreset/u.test(text.toLowerCase())) {
      throw new LocalRuntimeError("RUNTIME_UNREACHABLE", "The local runtime is not reachable.");
    }
    throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime request failed.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class OllamaLoopbackClient {
  constructor(
    private readonly fetchImpl: RuntimeFetch = fetch as RuntimeFetch,
    private readonly pullTransport: typeof streamOllamaPull = streamOllamaPull
  ) {}

  async version(signal?: AbortSignal): Promise<string> {
    const response = await fetchWithTimeout(this.fetchImpl, endpoint("/api/version"), { method: "GET" }, PROBE_TIMEOUT_MS, signal);
    assertResponse(response);
    if (!response.ok) throw new LocalRuntimeError("PORT_CONFLICT", "The loopback port is not serving the expected runtime.");
    const body = await readBoundedJson(response);
    const version = body !== null && typeof body === "object" && typeof (body as { version?: unknown }).version === "string"
      ? (body as { version: string }).version.trim()
      : "";
    if (!/^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
      throw new LocalRuntimeError("PORT_CONFLICT", "The loopback port returned an invalid runtime version.");
    }
    return version;
  }

  async tags(signal?: AbortSignal): Promise<readonly OllamaTag[]> {
    const response = await fetchWithTimeout(this.fetchImpl, endpoint("/api/tags"), { method: "GET" }, API_TIMEOUT_MS, signal);
    assertResponse(response);
    if (!response.ok) throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime could not list models.");
    const body = await readBoundedJson(response);
    const models = body !== null && typeof body === "object" && Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : [];
    return models.flatMap((value) => {
      if (value === null || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      if (!isOllamaModelName(record["name"])) return [];
      const size = record["size"];
      const digest = record["digest"];
      return [{
        name: record["name"],
        ...(typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? { sizeBytes: size } : {}),
        ...(typeof digest === "string" && isSafeDigest(digest) ? { digest: digest.toLowerCase() } : {})
      }];
    });
  }

  async show(name: string, signal?: AbortSignal): Promise<OllamaModelDetails> {
    if (!isOllamaModelName(name)) throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
    const response = await fetchWithTimeout(this.fetchImpl, endpoint("/api/show"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name })
    }, API_TIMEOUT_MS, signal);
    assertResponse(response);
    if (response.status === 404) throw new LocalRuntimeError("MODEL_NOT_FOUND", "The selected model could not be found.");
    if (!response.ok) throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime could not inspect the model.");
    const body = await readBoundedJson(response);
    const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {};
    const details = record["details"];
    const directContext = details !== null && typeof details === "object" ? (details as Record<string, unknown>)["context_length"] : undefined;
    let contextLength = typeof directContext === "number" && Number.isSafeInteger(directContext) && directContext > 0 ? directContext : undefined;
    const modelInfo = record["model_info"];
    if (contextLength === undefined && modelInfo !== null && typeof modelInfo === "object") {
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.endsWith(".context_length") && typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
          contextLength = value;
          break;
        }
      }
    }
    const capabilities = Array.isArray(record["capabilities"])
      ? record["capabilities"].filter((value): value is string => typeof value === "string" && /^[a-z0-9._-]{1,64}$/iu.test(value)).slice(0, 64)
      : [];
    const requiredRuntimeVersion = typeof record["requires"] === "string" && /^\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/u.test(record["requires"])
      ? record["requires"]
      : undefined;
    return {
      ...(contextLength === undefined ? {} : { contextLength }),
      capabilities,
      ...(requiredRuntimeVersion === undefined ? {} : { requiredRuntimeVersion })
    };
  }

  async delete(name: string, signal?: AbortSignal): Promise<void> {
    if (!isOllamaModelName(name)) throw new LocalRuntimeError("MODEL_INVALID", "The model name is invalid.");
    const response = await fetchWithTimeout(this.fetchImpl, endpoint("/api/delete"), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, model: name })
    }, API_TIMEOUT_MS, signal);
    assertResponse(response);
    if (response.status === 404) return;
    if (!response.ok) throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime could not delete the model.");
  }

  pull(name: string, onEvent: (event: OllamaPullEvent) => void, signal?: AbortSignal): Promise<void> {
    if (!isOllamaModelName(name)) return Promise.reject(new LocalRuntimeError("MODEL_INVALID", "The model name is invalid."));
    return this.pullTransport(name, onEvent, signal);
  }
}

export function parsePullLine(line: string): OllamaPullEvent | undefined {
  if (Buffer.byteLength(line, "utf8") > MAX_PULL_LINE_BYTES) {
    throw new LocalRuntimeError("RUNTIME_ERROR", "The local runtime returned an oversized progress record.");
  }
  const value = line.trim();
  if (value === "") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" ? parsed as OllamaPullEvent : undefined;
  } catch {
    return undefined;
  }
}

export function streamOllamaPull(
  name: string,
  onEvent: (event: OllamaPullEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!isOllamaModelName(name)) return Promise.reject(new LocalRuntimeError("MODEL_INVALID", "The model name is invalid."));
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawSuccess = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      error === undefined ? resolve() : reject(error);
    };
    const request = http.request({
      host: "127.0.0.1",
      port: 11434,
      path: "/api/pull",
      method: "POST",
      headers: { "content-type": "application/json" }
    }, (response) => {
      if ((response.statusCode ?? 0) >= 300) {
        response.resume();
        finish(new LocalRuntimeError(response.statusCode === 404 ? "MODEL_NOT_FOUND" : "RUNTIME_ERROR", "The local runtime rejected the model pull."));
        return;
      }
      response.setEncoding("utf8");
      let buffer = "";
      const consume = (line: string): boolean => {
        let event: OllamaPullEvent | undefined;
        try {
          event = parsePullLine(line);
        } catch (error) {
          request.destroy();
          finish(error instanceof Error ? error : new LocalRuntimeError("RUNTIME_ERROR", "The local runtime returned invalid progress."));
          return false;
        }
        if (event === undefined) return true;
        if (event.error !== undefined) {
          request.destroy();
          finish(pullError(event.error, name));
          return false;
        }
        if (event.status?.toLowerCase() === "success") sawSuccess = true;
        onEvent(event);
        return true;
      };
      response.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_PULL_LINE_BYTES * 2) {
          request.destroy();
          finish(new LocalRuntimeError("RUNTIME_ERROR", "The local runtime returned oversized progress."));
          return;
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (!consume(line)) return;
      });
      response.on("end", () => {
        if (buffer !== "" && !consume(buffer)) return;
        if (signal?.aborted) finish(new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled."));
        else if (!sawSuccess) finish(new LocalRuntimeError("RUNTIME_ERROR", "The model pull ended before completion."));
        else finish();
      });
      response.on("error", () => finish(new LocalRuntimeError("RUNTIME_UNREACHABLE", "The local runtime connection ended unexpectedly.")));
    });
    const abort = () => {
      request.destroy();
      finish(new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled."));
    };
    request.on("error", () => {
      finish(signal?.aborted
        ? new LocalRuntimeError("OPERATION_CANCELLED", "The operation was cancelled.")
        : new LocalRuntimeError("RUNTIME_UNREACHABLE", "The local runtime is not reachable."));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.write(JSON.stringify({ name, stream: true }));
    request.end();
  });
}
