import { createWdaOwnerFingerprint } from "./wda-build-plan.js";

export type WdaClientErrorCode = "INVALID_CONFIGURATION" | "UNREACHABLE" | "TIMEOUT" | "CANCELLED" |
  "HTTP_ERROR" | "PROTOCOL_ERROR" | "RESPONSE_TOO_LARGE" | "OWNER_MISMATCH" | "NOT_READY" | "INVALID_SESSION";

export class WdaClientError extends Error {
  constructor(readonly code: WdaClientErrorCode, message: string, readonly statusCode?: number) { super(message); }
}

export interface WdaDriverHealth {
  readonly ready: boolean;
  readonly message: string | null;
  readonly osName: string | null;
  readonly osVersion: string | null;
  readonly sdkVersion: string | null;
  readonly deviceIp: string | null;
}

export interface WdaDriverSession {
  readonly id: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface WdaAccessibilitySnapshot {
  readonly capturedAt: string;
  readonly tree: unknown;
}

export interface WdaViewport {
  readonly width: number;
  readonly height: number;
  readonly orientation: "PORTRAIT" | "LANDSCAPE";
}

export interface WdaLoopbackClientOptions {
  readonly controlPort: number;
  readonly cacheRoot: string;
  readonly instanceId: string;
  readonly simulatorUdid: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shortString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value) ? value : null;
}

function sessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(value)) {
    throw new WdaClientError("INVALID_SESSION", "Driver session identity is invalid.");
  }
  return value;
}

function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WdaClientError("INVALID_CONFIGURATION", `${label} is invalid.`);
  }
  return value;
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/u.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new WdaClientError("RESPONSE_TOO_LARGE", "Driver response exceeded its size limit.", response.status);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new WdaClientError("RESPONSE_TOO_LARGE", "Driver response exceeded its size limit.", response.status);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

/** Local WDA protocol only. The caller must claim any session mutation before dispatch. */
export class WdaLoopbackClient {
  readonly #baseUrl: string;
  readonly #ownerFingerprint: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: WdaLoopbackClientOptions) {
    const controlPort = integer(options.controlPort, "controlPort", 1024, 65_535);
    this.#baseUrl = `http://127.0.0.1:${controlPort}`;
    try {
      this.#ownerFingerprint = createWdaOwnerFingerprint(options);
    } catch {
      throw new WdaClientError("INVALID_CONFIGURATION", "Driver owner identity is invalid.");
    }
    this.#timeoutMs = integer(options.timeoutMs ?? 15_000, "timeoutMs", 1, 60_000);
    this.#maxResponseBytes = integer(options.maxResponseBytes ?? 1024 * 1024, "maxResponseBytes", 1, 16 * 1024 * 1024);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new WdaClientError("INVALID_CONFIGURATION", "A driver HTTP transport is required.");
  }

  get ownerFingerprint(): string { return this.#ownerFingerprint; }

  async #request(path: string, method: "GET" | "POST" | "DELETE", body: string | undefined,
    parentSignal?: AbortSignal): Promise<{ readonly value: unknown; readonly sessionId?: unknown }> {
    if (parentSignal?.aborted) throw new WdaClientError("CANCELLED", "Driver request was cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = (): void => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    if (parentSignal?.aborted) abortFromParent();
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method, body, signal: controller.signal, redirect: "manual", credentials: "omit",
        referrerPolicy: "no-referrer", cache: "no-store",
        headers: body === undefined ? { accept: "application/json" } :
          { accept: "application/json", "content-type": "application/json" }
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new WdaClientError("PROTOCOL_ERROR", "Driver redirected a local request.", response.status);
      }
      const bytes = await boundedBody(response, this.#maxResponseBytes);
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch { throw new WdaClientError("PROTOCOL_ERROR", "Driver returned invalid JSON.", response.status); }
      if (!record(parsed) || !Object.hasOwn(parsed, "value")) {
        throw new WdaClientError("PROTOCOL_ERROR", "Driver returned an invalid response envelope.", response.status);
      }
      const value = parsed["value"];
      if (!response.ok) {
        if (response.status === 404 && record(value) && value["error"] === "invalid session id") {
          throw new WdaClientError("INVALID_SESSION", "Driver session no longer exists.", response.status);
        }
        throw new WdaClientError("HTTP_ERROR", "Driver request failed.", response.status);
      }
      if (record(value) && typeof value["error"] === "string") {
        throw new WdaClientError("PROTOCOL_ERROR", "Driver reported a protocol failure.", response.status);
      }
      return { value, sessionId: parsed["sessionId"] };
    } catch (error) {
      if (parentSignal?.aborted) throw new WdaClientError("CANCELLED", "Driver request was cancelled.");
      if (timedOut) throw new WdaClientError("TIMEOUT", "Driver request timed out.");
      if (error instanceof WdaClientError) throw error;
      throw new WdaClientError("UNREACHABLE", "Driver loopback service is unavailable.");
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  async probe(signal?: AbortSignal): Promise<WdaDriverHealth> {
    const envelope = await this.#request("/status", "GET", undefined, signal);
    const value = envelope.value;
    if (!record(value) || typeof value["ready"] !== "boolean") {
      throw new WdaClientError("PROTOCOL_ERROR", "Driver health response is invalid.");
    }
    const build = record(value["build"]) ? value["build"] : {};
    if (build["upgradedAt"] !== this.#ownerFingerprint) {
      throw new WdaClientError("OWNER_MISMATCH", "Driver process ownership could not be confirmed.");
    }
    const os = record(value["os"]) ? value["os"] : {};
    const ios = record(value["ios"]) ? value["ios"] : {};
    return { ready: value["ready"], message: shortString(value["message"]), osName: shortString(os["name"]),
      osVersion: shortString(os["version"]), sdkVersion: shortString(os["sdkVersion"]) ??
        shortString(build["sdkVersion"]), deviceIp: shortString(ios["ip"]) };
  }

  async createSession(signal?: AbortSignal): Promise<WdaDriverSession> {
    const health = await this.probe(signal);
    if (!health.ready) throw new WdaClientError("NOT_READY", "Driver is not ready for a session.");
    const envelope = await this.#request("/session", "POST", JSON.stringify({ capabilities: { alwaysMatch: {} } }), signal);
    const value = record(envelope.value) ? envelope.value : {};
    const id = sessionId(value["sessionId"] ?? envelope.sessionId);
    const capabilities = record(value["capabilities"]) ? value["capabilities"] : {};
    return { id, capabilities, createdAt: new Date().toISOString() };
  }

  async deleteSession(id: string, signal?: AbortSignal): Promise<void> {
    const exactId = sessionId(id);
    const health = await this.probe(signal);
    if (!health.ready) throw new WdaClientError("NOT_READY", "Driver is not ready for session cleanup.");
    await this.#request(`/session/${exactId}`, "DELETE", undefined, signal);
  }

  async getAccessibilityTree(id: string, signal?: AbortSignal): Promise<WdaAccessibilitySnapshot> {
    const exactId = sessionId(id);
    const health = await this.probe(signal);
    if (!health.ready) throw new WdaClientError("NOT_READY", "Driver is not ready for screen observation.");
    const envelope = await this.#request(`/session/${exactId}/source?format=json`, "GET", undefined, signal);
    if (!record(envelope.value) && !Array.isArray(envelope.value)) {
      throw new WdaClientError("PROTOCOL_ERROR", "Driver accessibility response is invalid.");
    }
    return { capturedAt: new Date().toISOString(), tree: envelope.value };
  }

  async getViewport(id: string, signal?: AbortSignal): Promise<WdaViewport> {
    const exactId = sessionId(id);
    const health = await this.probe(signal);
    if (!health.ready) throw new WdaClientError("NOT_READY", "Driver is not ready for viewport observation.");
    const [size, direction] = await Promise.all([
      this.#request(`/session/${exactId}/window/size`, "GET", undefined, signal),
      this.#request(`/session/${exactId}/orientation`, "GET", undefined, signal)
    ]);
    if (!record(size.value) || typeof size.value["width"] !== "number" ||
        !Number.isFinite(size.value["width"]) || size.value["width"] <= 0 ||
        typeof size.value["height"] !== "number" || !Number.isFinite(size.value["height"]) ||
        size.value["height"] <= 0 ||
        direction.value !== "PORTRAIT" && direction.value !== "LANDSCAPE") {
      throw new WdaClientError("PROTOCOL_ERROR", "Driver viewport response is invalid.");
    }
    return { width: size.value["width"], height: size.value["height"],
      orientation: direction.value };
  }
}
