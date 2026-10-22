import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicWriteJson } from "./config.js";

export interface PiCacheRoute {
  readonly providerId: string;
  readonly wireModelId: string;
  readonly routeKey: string;
}

/** Includes API, path and query routing. Only the digest leaves the Adapter. */
export function piCacheRouteKey(endpoint: string, api: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return undefined;
    url.hash = "";
    return createHash("sha256").update(JSON.stringify(["pi-cache-v1", api, url.href])).digest("hex");
  } catch {
    return undefined;
  }
}

/** Closure-free so the managed native extension uses the same closed parser. */
export function isUnsupportedCacheOptionError(message: string): boolean {
  if (typeof message !== "string" || message.length === 0 || message.length > 64 * 1024) return false;
  const status = /^\s*(\d{3})\s*:/.exec(message);
  if (status && status[1] !== "400") return false;
  let text = message;
  const jsonStart = message.indexOf("{");
  if (jsonStart >= 0) {
    try {
      let value: unknown = JSON.parse(message.slice(jsonStart));
      let foundMessage = false;
      for (let depth = 0; depth < 3; depth++) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const error = value as Record<string, unknown>;
        if (Object.hasOwn(error, "param") && !["prompt_cache_retention", "prompt_cache_key"].includes(String(error.param))) return false;
        if (error.type !== undefined && !["invalid_request_error", "unsupported_parameter"].includes(String(error.type))) return false;
        if (typeof error.message === "string") { text = error.message; foundMessage = true; break; }
        value = error.error;
      }
      if (!foundMessage) return false;
    } catch { return false; }
  }
  // Require the field and rejection to be related in the same short clause.
  return /\bprompt_cache_(?:retention|key)\b/i.test(text)
    && /(?:unsupported\s+(?:request\s+)?parameters?(?:\(s\))?\s*:\s*[\x60"'\\\s]*(prompt_cache_(?:retention|key))\b|\b(prompt_cache_(?:retention|key))\b[\x60"'\\\s]*(?:is\s+(?:not\s+supported|unsupported)|isn't\s+supported))/i.test(text);
}

export const PI_CACHE_COMPATIBILITY_REQUEST_PREFIX = "joko:cache-compatibility/v1/";
const MAXIMUM_OVERRIDE_BYTES = 256 * 1024;
const MAXIMUM_ENVELOPE_CHARACTERS = 4 * 1024;
const writeTails = new Map<string, Promise<unknown>>();
type OverrideFile = { version: 1; routes: Record<string, { supportsLongCacheRetention: false }> };

function identity(route: PiCacheRoute): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(route.routeKey)) return undefined;
  if (![route.providerId, route.wireModelId].every(value => typeof value === "string" && value.length > 0
    && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value))) return undefined;
  return JSON.stringify([route.providerId, route.wireModelId, route.routeKey]);
}

/** Private internal learning; unreadable files are preserved and never enable replay. */
export class PiCacheCompatibilityStore {
  constructor(readonly path: string) {}

  async snapshot(destination: string): Promise<void> {
    const current = await this.#read();
    await atomicWriteJson(destination, current ?? { version: 1, routes: {} });
  }

  async has(route: PiCacheRoute): Promise<boolean> {
    const key = identity(route);
    if (!key) return false;
    const value = await this.#read();
    return value?.routes[key]?.supportsLongCacheRetention === false;
  }

  async record(route: PiCacheRoute): Promise<boolean> {
    const key = identity(route);
    if (!key) return false;
    const pending = (writeTails.get(this.path) ?? Promise.resolve()).then(async () => {
      try {
        const current = await this.#read();
        if (!current) return false;
        if (current.routes[key]?.supportsLongCacheRetention === false) return true;
        const next: OverrideFile = { version: 1, routes: { ...current.routes, [key]: { supportsLongCacheRetention: false } } };
        if (Buffer.byteLength(JSON.stringify(next), "utf8") > MAXIMUM_OVERRIDE_BYTES) return false;
        await atomicWriteJson(this.path, next);
        return await this.has(route);
      } catch { return false; }
    });
    writeTails.set(this.path, pending);
    try { return await pending; }
    finally { if (writeTails.get(this.path) === pending) writeTails.delete(this.path); }
  }

  async #read(): Promise<OverrideFile | undefined> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAXIMUM_OVERRIDE_BYTES) return undefined;
      const file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw: unknown;
      try {
        const opened = await file.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size > MAXIMUM_OVERRIDE_BYTES) return undefined;
        const bytes = Buffer.alloc(MAXIMUM_OVERRIDE_BYTES + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAXIMUM_OVERRIDE_BYTES) return undefined;
        raw = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.routes)
        || Object.keys(raw).some(key => key !== "version" && key !== "routes")) return undefined;
      const routes: OverrideFile["routes"] = Object.create(null);
      for (const [key, value] of Object.entries(raw.routes)) {
        const parts: unknown = JSON.parse(key);
        if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(part => typeof part === "string")
          || identity({ providerId: parts[0]!, wireModelId: parts[1]!, routeKey: parts[2]! }) !== key
          || !isRecord(value) || value.supportsLongCacheRetention !== false
          || Object.keys(value).length !== 1) return undefined;
        routes[key] = { supportsLongCacheRetention: false };
      }
      return { version: 1, routes };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { version: 1, routes: Object.create(null) } : undefined;
    }
  }
}

export type PiCacheCompatibilityRequest =
  | { readonly action: "prepare"; readonly route: PiCacheRoute; readonly hasCacheOptions: boolean }
  | { readonly action: "learn"; readonly lease: string };

export function encodePiCacheCompatibilityRequest(request: PiCacheCompatibilityRequest): string {
  return PI_CACHE_COMPATIBILITY_REQUEST_PREFIX + Buffer.from(JSON.stringify({ version: 1, ...request }), "utf8").toString("base64url");
}

export async function handlePiCacheCompatibilityRequest(
  event: Readonly<Record<string, unknown>>,
  options: {
    readonly resolve: (request: PiCacheCompatibilityRequest) => Promise<Readonly<Record<string, unknown>>>;
    readonly transport: { readonly closed: boolean; notify(message: {
      readonly type: "extension_ui_response"; readonly id: string; readonly value: string;
    }): Promise<void> };
    readonly isCurrent: () => boolean;
  }
): Promise<boolean> {
  if (event.method !== "input" || typeof event.title !== "string"
    || !event.title.startsWith(PI_CACHE_COMPATIBILITY_REQUEST_PREFIX)) return false;
  const id = typeof event.id === "string" ? event.id : "";
  let result: Readonly<Record<string, unknown>> = {};
  try {
    const encoded = event.title.slice(PI_CACHE_COMPATIBILITY_REQUEST_PREFIX.length);
    if (encoded.length > MAXIMUM_ENVELOPE_CHARACTERS || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(raw) || raw.version !== 1) throw new Error();
    if (raw.action === "prepare" && isRecord(raw.route) && typeof raw.hasCacheOptions === "boolean"
      && Object.keys(raw).length === 4 && Object.keys(raw.route).length === 3
      && identity(raw.route as unknown as PiCacheRoute)) {
      result = await options.resolve({ action: "prepare", route: raw.route as unknown as PiCacheRoute, hasCacheOptions: raw.hasCacheOptions });
    } else if (raw.action === "learn" && typeof raw.lease === "string" && /^[a-f0-9-]{36}$/.test(raw.lease)
      && Object.keys(raw).length === 3) {
      result = await options.resolve({ action: "learn", lease: raw.lease });
    }
  } catch { /* A private request failure is never an interaction or diagnostic. */ }
  if (id && options.isCurrent() && !options.transport.closed) {
    await options.transport.notify({ type: "extension_ui_response", id, value: JSON.stringify(result) });
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
