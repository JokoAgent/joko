import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { DynamicInputSchema } from "@joko/core";

import { piError, redactManagedSecrets } from "./errors.js";
import { DEFAULT_PI_JSONL_RECORD_BYTES } from "./jsonl.js";
import { projectPiInputSchema } from "./tool-catalog.js";

export const PI_RUNTIME_TOOL_CATALOG_STATUS_KEY = "joko-runtime-tool-catalog/v1";
export const PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES = 1024 * 1024;
export const MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH
);

const MAXIMUM_STATUS_TEXT_BYTES = DEFAULT_PI_JSONL_RECORD_BYTES - 4_096;
const MAXIMUM_ENCODED_CHUNK_CHARACTERS = Math.ceil(PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES * 4 / 3) + 4;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface PiRuntimeToolSourceInfo {
  readonly path: string;
  readonly source: string;
  readonly scope: "user" | "project" | "temporary";
  readonly origin: "package" | "top-level";
  readonly baseDir?: string;
}

/**
 * A live, session-scoped Pi tool projection. Unlike BackendToolDescriptor it
 * does not invent fixed permission or streaming flags that Pi's getAllTools()
 * API does not expose.
 */
export interface PiRuntimeToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: DynamicInputSchema;
  readonly promptGuidelines: readonly string[];
  readonly active: boolean;
  readonly sourceInfo: PiRuntimeToolSourceInfo;
}

export interface PiRuntimeToolCatalog {
  readonly runtimeGeneration: number;
  readonly observedAt: number;
  readonly tools: readonly PiRuntimeToolDescriptor[];
}

export type PiRuntimeToolCatalogUnavailableReason = "capture_failed" | "catalog_too_large";

export type PiRuntimeToolCatalogStatus =
  | { readonly kind: "unrelated" }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable"; readonly reason: PiRuntimeToolCatalogUnavailableReason }
  | { readonly kind: "catalog"; readonly tools: readonly PiRuntimeToolDescriptor[] };

interface PendingCatalog {
  readonly catalogId: string;
  readonly count: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly chunks: Map<number, Buffer>;
  receivedBytes: number;
}

/**
 * Consumes the reserved status records in transport order. Catalog chunks are
 * never projected until every byte has been assembled and authenticated.
 */
export class PiRuntimeToolCatalogAssembler {
  #pending: PendingCatalog | undefined;

  consume(
    event: Readonly<Record<string, unknown>>,
    redactValues: readonly string[] = []
  ): PiRuntimeToolCatalogStatus {
    if (event["method"] !== "setStatus" || event["statusKey"] !== PI_RUNTIME_TOOL_CATALOG_STATUS_KEY) {
      return { kind: "unrelated" };
    }
    const envelope = parseStatusEnvelope(event);
    if (envelope["format"] !== 1) {
      this.#pending = undefined;
      throw catalogError("Pi emitted an unsupported runtime tool catalog format.");
    }
    if (envelope["complete"] === false) {
      this.#pending = undefined;
      return unavailableEnvelope(envelope);
    }
    return this.#acceptChunk(envelope, redactValues);
  }

  reset(): void {
    this.#pending = undefined;
  }

  #acceptChunk(
    envelope: Readonly<Record<string, unknown>>,
    redactValues: readonly string[]
  ): PiRuntimeToolCatalogStatus {
    const catalogId = requiredCatalogId(envelope["catalogId"]);
    const index = requiredSafeInteger(envelope["index"], "chunk index", 0);
    const count = requiredSafeInteger(envelope["count"], "chunk count", 1);
    const byteLength = requiredSafeInteger(envelope["byteLength"], "catalog byte length", 1);
    const sha256 = requiredSha256(envelope["sha256"]);
    if (index >= count || count > byteLength) {
      this.#pending = undefined;
      throw catalogError("Pi emitted invalid runtime tool catalog chunk coordinates.");
    }
    if (byteLength > MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES) {
      this.#pending = undefined;
      return { kind: "unavailable", reason: "catalog_too_large" };
    }
    const chunk = decodeChunk(envelope["payload"]);
    const pending = this.#pending;
    if (
      pending !== undefined && (
        pending.catalogId !== catalogId ||
        pending.count !== count ||
        pending.byteLength !== byteLength ||
        pending.sha256 !== sha256
      )
    ) {
      this.#pending = undefined;
      throw catalogError("Pi interleaved incompatible runtime tool catalog snapshots.");
    }
    const current = pending ?? {
      catalogId,
      count,
      byteLength,
      sha256,
      chunks: new Map<number, Buffer>(),
      receivedBytes: 0
    };
    this.#pending = current;
    const existing = current.chunks.get(index);
    if (existing !== undefined) {
      if (!existing.equals(chunk)) {
        this.#pending = undefined;
        throw catalogError("Pi emitted conflicting duplicate runtime tool catalog chunks.");
      }
      return current.chunks.size === current.count
        ? this.#finish(current, redactValues)
        : { kind: "pending" };
    }
    if (current.receivedBytes + chunk.byteLength > current.byteLength) {
      this.#pending = undefined;
      throw catalogError("Pi emitted runtime tool catalog chunks larger than their declared snapshot.");
    }
    current.chunks.set(index, chunk);
    current.receivedBytes += chunk.byteLength;
    return current.chunks.size === current.count
      ? this.#finish(current, redactValues)
      : { kind: "pending" };
  }

  #finish(
    pending: PendingCatalog,
    redactValues: readonly string[]
  ): PiRuntimeToolCatalogStatus {
    this.#pending = undefined;
    if (pending.receivedBytes !== pending.byteLength) {
      throw catalogError("Pi emitted an incomplete runtime tool catalog byte sequence.");
    }
    const ordered: Buffer[] = [];
    for (let index = 0; index < pending.count; index += 1) {
      const chunk = pending.chunks.get(index);
      if (chunk === undefined) throw catalogError("Pi omitted a runtime tool catalog chunk.");
      ordered.push(chunk);
    }
    const bytes = Buffer.concat(ordered, pending.byteLength);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== pending.sha256) {
      throw catalogError("Pi emitted a runtime tool catalog with an invalid content hash.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw catalogError("Pi emitted non-UTF-8 runtime tool catalog content.", error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw catalogError("Pi emitted invalid JSON for the runtime tool catalog.", error);
    }
    return projectCatalogEnvelope(record(raw, "runtime tool catalog"), redactValues);
  }
}

function parseStatusEnvelope(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const text = event["statusText"];
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MAXIMUM_STATUS_TEXT_BYTES
  ) {
    throw catalogError("Pi emitted an invalid runtime tool catalog envelope.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw catalogError("Pi emitted invalid JSON for the runtime tool catalog.", error);
  }
  return record(raw, "runtime tool catalog");
}

function projectCatalogEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  redactValues: readonly string[]
): PiRuntimeToolCatalogStatus {
  if (envelope["format"] !== 1) throw catalogError("Pi emitted a mismatched runtime tool catalog document.");
  if (envelope["complete"] === false) return unavailableEnvelope(envelope);
  if (envelope["complete"] !== true || !Array.isArray(envelope["tools"]) || !Array.isArray(envelope["activeToolNames"])) {
    throw catalogError("Pi emitted an incomplete runtime tool catalog.");
  }

  const active = new Set<string>();
  for (const value of envelope["activeToolNames"]) {
    active.add(toolName(value, "activeToolNames"));
  }
  const seen = new Set<string>();
  const tools = envelope["tools"].map((value, index): PiRuntimeToolDescriptor => {
    const tool = record(value, `tools[${index}]`);
    const name = toolName(tool["name"], `tools[${index}].name`);
    if (redactManagedSecrets(name, redactValues) !== name) {
      throw catalogError("Pi emitted a secret-bearing runtime tool identity.");
    }
    if (seen.has(name)) throw catalogError(`Pi emitted duplicate runtime tool '${name}'.`);
    seen.add(name);
    const description = redactManagedSecrets(
      requiredText(tool["description"], `tools[${index}].description`, false),
      redactValues
    );
    const guidelines = promptGuidelines(tool["promptGuidelines"], `tools[${index}].promptGuidelines`)
      .map((guideline) => redactManagedSecrets(guideline, redactValues));
    return {
      name,
      description,
      inputSchema: redactInputSchema(projectPiInputSchema(tool["parameters"], name), redactValues),
      promptGuidelines: guidelines,
      active: active.has(name),
      sourceInfo: sourceInfo(tool["sourceInfo"], `tools[${index}].sourceInfo`, redactValues)
    };
  });
  if ([...active].some((name) => !seen.has(name))) {
    throw catalogError("Pi marked an unknown runtime tool active.");
  }
  return { kind: "catalog", tools };
}

function unavailableEnvelope(envelope: Readonly<Record<string, unknown>>): PiRuntimeToolCatalogStatus {
  const reason = envelope["reason"];
  if (reason !== "capture_failed" && reason !== "catalog_too_large") {
    throw catalogError("Pi emitted an invalid incomplete runtime tool catalog reason.");
  }
  return { kind: "unavailable", reason };
}

function sourceInfo(value: unknown, field: string, redactValues: readonly string[]): PiRuntimeToolSourceInfo {
  const source = record(value, field);
  const scope = source["scope"];
  const origin = source["origin"];
  if (scope !== "user" && scope !== "project" && scope !== "temporary") {
    throw catalogError(`Pi emitted an invalid ${field}.scope.`);
  }
  if (origin !== "package" && origin !== "top-level") {
    throw catalogError(`Pi emitted an invalid ${field}.origin.`);
  }
  const baseDir = source["baseDir"] === undefined
    ? undefined
    : redactManagedSecrets(requiredText(source["baseDir"], `${field}.baseDir`, true), redactValues);
  return {
    path: redactManagedSecrets(requiredText(source["path"], `${field}.path`, true), redactValues),
    source: redactManagedSecrets(requiredText(source["source"], `${field}.source`, true), redactValues),
    scope,
    origin,
    ...(baseDir === undefined ? {} : { baseDir })
  };
}

function redactInputSchema(schema: DynamicInputSchema, redactValues: readonly string[]): DynamicInputSchema {
  return {
    allowsAdditionalFields: schema.allowsAdditionalFields,
    fields: schema.fields.map((field) => ({
      ...field,
      fieldPath: redactManagedSecrets(field.fieldPath, redactValues),
      title: redactManagedSecrets(field.title, redactValues),
      description: redactManagedSecrets(field.description, redactValues),
      enumValues: field.enumValues.map((value) => redactManagedSecrets(value, redactValues)),
      ...(field.constraints === undefined
        ? {}
        : {
            constraints: {
              ...field.constraints,
              ...(field.constraints.pattern === undefined
                ? {}
                : { pattern: redactManagedSecrets(field.constraints.pattern, redactValues) }),
              ...(field.constraints.itemFieldPath === undefined
                ? {}
                : { itemFieldPath: redactManagedSecrets(field.constraints.itemFieldPath, redactValues) })
            }
          })
    }))
  };
}

function promptGuidelines(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw catalogError(`Pi emitted an invalid ${field}.`);
  return value.map((item, index) => requiredText(item, `${field}[${index}]`, false));
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw catalogError(`Pi emitted an invalid ${field} object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function toolName(value: unknown, field: string): string {
  if (typeof value !== "string" || !TOOL_NAME.test(value)) {
    throw catalogError(`Pi emitted an invalid ${field}.`);
  }
  return value;
}

function requiredText(value: unknown, field: string, allowEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim() === "") ||
    /[\u0000\u007f]/u.test(value)
  ) {
    throw catalogError(`Pi emitted invalid text for ${field}.`);
  }
  return value;
}

function requiredCatalogId(value: unknown): string {
  if (typeof value !== "string" || !CATALOG_ID.test(value)) {
    throw catalogError("Pi emitted an invalid runtime tool catalog id.");
  }
  return value;
}

function requiredSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw catalogError("Pi emitted an invalid runtime tool catalog hash.");
  }
  return value;
}

function requiredSafeInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw catalogError(`Pi emitted an invalid runtime tool catalog ${field}.`);
  }
  return value as number;
}

function decodeChunk(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_ENCODED_CHUNK_CHARACTERS ||
    !BASE64URL.test(value)
  ) {
    throw catalogError("Pi emitted an invalid runtime tool catalog chunk payload.");
  }
  const chunk = Buffer.from(value, "base64url");
  if (
    chunk.byteLength === 0 ||
    chunk.byteLength > PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES ||
    chunk.toString("base64url") !== value
  ) {
    throw catalogError("Pi emitted a non-canonical runtime tool catalog chunk payload.");
  }
  return chunk;
}

function catalogError(message: string, cause?: unknown): Error {
  return piError("PI_RUNTIME_TOOL_CATALOG_INVALID", message, "stream", {
    stateMayHaveChanged: false,
    recovery: "Restart the same runtime generation; do not infer custom tools from configured resource paths.",
    ...(cause === undefined ? {} : { cause })
  });
}
