import { createHash } from "node:crypto";

import { redactSecrets } from "@joko/core";

import { SensitiveDataError } from "./errors.js";

const SENSITIVE_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|authorization|password|passwd|secret|client[_-]?secret|private[_-]?key|cookie|credentials?)$/iu;
const SAFE_SECRET_REFERENCE_SUFFIX = /(?:[_-](?:digest|hash|id|ref)|\.(?:digest|hash|id|ref))$/iu;

type JsonScalar = null | boolean | number | string;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export function sanitizeForPersistence(value: unknown): JsonValue {
  return sanitize(value, new Set<object>(), undefined);
}

export function serializeJson(value: unknown): string {
  return JSON.stringify(sanitizeForPersistence(value));
}

export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function operationBodyHash(value: unknown): string {
  const canonical = canonicalize(value, new Set<object>(), "$operation");
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function assertSafeSettingKey(key: string): void {
  const compact = key.trim();
  if (compact === "") throw new SensitiveDataError("Setting keys must not be blank.");
  const segments = compact.split(/[./:]/u);
  const sensitive = segments.find((segment) => SENSITIVE_KEY.test(segment));
  if (sensitive !== undefined && !SAFE_SECRET_REFERENCE_SUFFIX.test(compact)) {
    throw new SensitiveDataError(`Secret-bearing setting key is not allowed in the operational store: ${key}`);
  }
}

function sanitize(value: unknown, seen: Set<object>, key: string | undefined): JsonValue {
  if (key !== undefined && SENSITIVE_KEY.test(key) && !SAFE_SECRET_REFERENCE_SUFFIX.test(key)) {
    return "[REDACTED]";
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `[binary:${value.byteLength}]`;
  if (value instanceof Error) {
    if (seen.has(value)) throw new TypeError("Cannot serialize a cyclic value.");
    seen.add(value);
    try {
      return sanitize({
        name: value.name,
        message: value.message,
        ...(value.stack === undefined ? {} : { stack: value.stack }),
        ...(value.cause === undefined ? {} : { cause: value.cause })
      }, seen, undefined);
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value !== "object") return redactSecrets(String(value));
  if (seen.has(value)) throw new TypeError("Cannot serialize a cyclic value.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, seen, undefined));
    if (value instanceof Map) {
      const result: Record<string, JsonValue> = {};
      for (const [mapKey, mapValue] of [...value.entries()].sort(([left], [right]) =>
        String(left).localeCompare(String(right), "en")
      )) {
        const normalizedKey = String(mapKey);
        result[normalizedKey] = sanitize(mapValue, seen, normalizedKey);
      }
      return result;
    }
    if (value instanceof Set) {
      return [...value].map((item) => sanitize(item, seen, undefined));
    }
    const result: Record<string, JsonValue> = {};
    for (const property of Object.keys(value).sort()) {
      result[property] = sanitize((value as Record<string, unknown>)[property], seen, property);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonicalize(value: unknown, seen: Set<object>, location: string): JsonValue {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${location}.`);
    return ["number", Object.is(value, -0) ? "-0" : value];
  }
  if (typeof value === "bigint") return ["bigint", value.toString(10)];
  if (value === undefined) return ["undefined"];
  if (value instanceof Date) return ["date", value.toISOString()];
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("base64")];
  if (typeof value !== "object") throw new TypeError(`Unsupported value at ${location}.`);
  if (seen.has(value)) throw new TypeError(`Cyclic value at ${location}.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return [
        "array",
        value.map((item, index) => canonicalize(item, seen, `${location}[${index}]`))
      ];
    }
    if (value instanceof Map) {
      return [
        "map",
        [...value.entries()]
          .map(([mapKey, mapValue]) => [
            canonicalize(mapKey, seen, `${location}.<key>`),
            canonicalize(mapValue, seen, `${location}.<value>`)
          ])
          .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0]), "en"))
      ];
    }
    if (value instanceof Set) {
      return [
        "set",
        [...value]
          .map((item) => canonicalize(item, seen, `${location}.<set>`))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"))
      ];
    }
    const result: JsonValue[] = [];
    for (const property of Object.keys(value).sort()) {
      result.push([
        property,
        canonicalize(
          (value as Record<string, unknown>)[property],
          seen,
          `${location}.${property}`
        )
      ]);
    }
    return ["object", result];
  } finally {
    seen.delete(value);
  }
}
