import { validInlineTextRanges, type BlobRef, type EventPayload, type InlineTextRange, type MessageBlock } from "@joko/core";
import type { PersistedEvent } from "@joko/store";

const PROJECTION_FORMAT = 1;
export const MAXIMUM_PORTABLE_SESSION_MESSAGES = 100_000;
const MAX_BLOCKS_PER_MESSAGE = 10_000;
const MAX_PROJECTION_BYTES = 128 * 1024 * 1024;
const MAX_STRING_BYTES = 16 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface PortableProjectedMessage {
  readonly emittedAt: number;
  readonly role: "user" | "assistant";
  readonly blocks: readonly MessageBlock[];
  readonly quotesEncoded?: boolean;
  readonly pastedTextRanges?: readonly InlineTextRange[];
  readonly usage?: Extract<EventPayload, { readonly type: "message_complete" }>["usage"];
  readonly generationDurationMs?: Extract<EventPayload, { readonly type: "message_complete" }>["generationDurationMs"];
  readonly generationReliable?: Extract<EventPayload, { readonly type: "message_complete" }>["generationReliable"];
  readonly automationOrigin?: Extract<EventPayload, { readonly type: "message_complete" }>["automationOrigin"];
  readonly inputDelivery?: Extract<EventPayload, { readonly type: "message_complete" }>["inputDelivery"];
}

export interface PortableSessionProjection {
  readonly format: 1;
  readonly messages: readonly PortableProjectedMessage[];
}

export class PortableSessionProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortableSessionProjectionError";
  }
}

/**
 * Retains only completed public messages. Native persistence remains the model
 * context authority; this projection is the durable, renderer-safe history.
 */
export function projectPortableSessionMessages(
  events: readonly Pick<PersistedEvent, "emittedAt" | "payload">[]
): PortableSessionProjection {
  const messages: PortableProjectedMessage[] = [];
  for (const event of events) {
    if (event.payload.type !== "message_complete" || event.payload.automaticContinuation !== undefined) continue;
    messages.push({
      emittedAt: event.emittedAt,
      role: event.payload.role,
      blocks: event.payload.blocks,
      ...(event.payload.quotesEncoded === undefined ? {} : { quotesEncoded: event.payload.quotesEncoded }),
      ...(event.payload.pastedTextRanges === undefined ? {} : { pastedTextRanges: event.payload.pastedTextRanges }),
      ...(event.payload.usage === undefined ? {} : { usage: event.payload.usage }),
      ...(event.payload.generationDurationMs === undefined
        ? {}
        : { generationDurationMs: event.payload.generationDurationMs }),
      ...(event.payload.generationReliable === undefined
        ? {}
        : { generationReliable: event.payload.generationReliable }),
      ...(event.payload.automationOrigin === undefined ? {} : { automationOrigin: event.payload.automationOrigin }),
      ...(event.payload.inputDelivery === undefined ? {} : { inputDelivery: event.payload.inputDelivery })
    });
  }
  const projection: PortableSessionProjection = { format: PROJECTION_FORMAT, messages };
  validatePortableSessionProjection(projection);
  return projection;
}

export function encodePortableSessionProjection(projection: PortableSessionProjection): Uint8Array {
  validatePortableSessionProjection(projection);
  const bytes = Buffer.from(JSON.stringify(projection), "utf8");
  if (bytes.byteLength > MAX_PROJECTION_BYTES) throw invalid("Portable Session message history is too large.");
  return bytes;
}

export function decodePortableSessionProjection(bytes: Uint8Array): PortableSessionProjection {
  if (bytes.byteLength > MAX_PROJECTION_BYTES) throw invalid("Portable Session message history is too large.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid("Portable Session message history is not valid UTF-8 JSON.");
  }
  validatePortableSessionProjection(value);
  return value;
}

export function collectPortableProjectionBlobRefs(
  projection: PortableSessionProjection
): ReadonlyMap<string, BlobRef> {
  validatePortableSessionProjection(projection);
  const refs = new Map<string, BlobRef>();
  for (const message of projection.messages) {
    for (const block of message.blocks) {
      if (block.kind !== "image" && block.kind !== "artifact") continue;
      const previous = refs.get(block.blob.id);
      if (previous !== undefined && !sameBlob(previous, block.blob)) {
        throw invalid("Portable Session message history reuses a Blob ID for different content.");
      }
      refs.set(block.blob.id, block.blob);
    }
  }
  return refs;
}

/** Rebinds package-local Blob identities to the receiving Artifact Store. */
export function rebindPortableProjectionBlobs(
  projection: PortableSessionProjection,
  replacements: ReadonlyMap<string, BlobRef>
): PortableSessionProjection {
  validatePortableSessionProjection(projection);
  const messages = projection.messages.map((message): PortableProjectedMessage => ({
    ...message,
    blocks: message.blocks.map((block): MessageBlock => {
      if (block.kind !== "image" && block.kind !== "artifact") return block;
      const replacement = replacements.get(block.blob.id);
      if (replacement === undefined || replacement.sha256 !== block.blob.sha256
        || replacement.byteLength !== block.blob.byteLength) {
        throw invalid("Portable Session media is missing or does not match its message reference.");
      }
      return { ...block, blob: replacement };
    })
  }));
  const rebound: PortableSessionProjection = { format: PROJECTION_FORMAT, messages };
  validatePortableSessionProjection(rebound);
  return rebound;
}

/**
 * An export may deliberately exclude media or observe a stale Artifact. Keep
 * the surrounding message while replacing only the unavailable block.
 */
export function omitUnavailablePortableProjectionBlobs(
  projection: PortableSessionProjection,
  availableSourceIds: ReadonlySet<string>
): PortableSessionProjection {
  validatePortableSessionProjection(projection);
  const messages = projection.messages.map((message): PortableProjectedMessage => ({
    ...message,
    blocks: message.blocks.map((block): MessageBlock => {
      if (block.kind !== "image" && block.kind !== "artifact" || availableSourceIds.has(block.blob.id)) return block;
      const label = block.kind === "image" ? block.alt ?? block.blob.fileName ?? "image" : block.label;
      return { kind: "text", text: `[Unavailable attachment: ${label}]` };
    })
  }));
  const filtered: PortableSessionProjection = { format: PROJECTION_FORMAT, messages };
  validatePortableSessionProjection(filtered);
  return filtered;
}

export function portableProjectionEventPayloads(
  projection: PortableSessionProjection
): readonly { readonly emittedAt: number; readonly payload: EventPayload }[] {
  validatePortableSessionProjection(projection);
  return projection.messages.map((message) => ({
    emittedAt: message.emittedAt,
    payload: {
      type: "message_complete",
      role: message.role,
      blocks: message.blocks,
      ...(message.quotesEncoded === undefined ? {} : { quotesEncoded: message.quotesEncoded }),
      ...(message.pastedTextRanges === undefined ? {} : { pastedTextRanges: message.pastedTextRanges }),
      ...(message.usage === undefined ? {} : { usage: message.usage }),
      ...(message.generationDurationMs === undefined
        ? {}
        : { generationDurationMs: message.generationDurationMs }),
      ...(message.generationReliable === undefined
        ? {}
        : { generationReliable: message.generationReliable }),
      ...(message.automationOrigin === undefined ? {} : { automationOrigin: message.automationOrigin }),
      ...(message.inputDelivery === undefined ? {} : { inputDelivery: message.inputDelivery })
    }
  }));
}

export function validatePortableSessionProjection(value: unknown): asserts value is PortableSessionProjection {
  if (!isRecord(value) || value["format"] !== PROJECTION_FORMAT || !Array.isArray(value["messages"])) {
    throw invalid("Portable Session message history has an unsupported shape.");
  }
  if (value["messages"].length > MAXIMUM_PORTABLE_SESSION_MESSAGES) {
    throw invalid("Portable Session message history has too many messages.");
  }
  for (const rawMessage of value["messages"]) validateMessage(rawMessage);
}

function validateMessage(value: unknown): asserts value is PortableProjectedMessage {
  if (!isRecord(value) || !Number.isSafeInteger(value["emittedAt"]) || Number(value["emittedAt"]) < 0
    || (value["role"] !== "user" && value["role"] !== "assistant") || !Array.isArray(value["blocks"])) {
    throw invalid("Portable Session message history contains an invalid message.");
  }
  if (value["blocks"].length > MAX_BLOCKS_PER_MESSAGE) throw invalid("Portable Session message contains too many blocks.");
  for (const block of value["blocks"]) validateBlock(block);
  if (value["quotesEncoded"] !== undefined && typeof value["quotesEncoded"] !== "boolean") {
    throw invalid("Portable Session quote metadata is invalid.");
  }
  validatePastedTextRanges(value["pastedTextRanges"], value["blocks"]);
  if (value["usage"] !== undefined) validateMessageUsage(value["usage"]);
  validateMessageGenerationTiming(value);
  if (value["inputDelivery"] !== undefined
    && !["prompt", "steer", "follow_up", "scheduler"].includes(String(value["inputDelivery"]))) {
    throw invalid("Portable Session input delivery metadata is invalid.");
  }
  if (value["automationOrigin"] !== undefined) validateAutomationOrigin(value["automationOrigin"]);
  assertExactKeys(value, [
    "emittedAt",
    "role",
    "blocks",
    "quotesEncoded",
    "pastedTextRanges",
    "usage",
    "generationDurationMs",
    "generationReliable",
    "automationOrigin",
    "inputDelivery"
  ], "message");
}

function validateMessageGenerationTiming(value: Readonly<Record<string, unknown>>): void {
  const duration = value["generationDurationMs"];
  const reliable = value["generationReliable"];
  if (duration === undefined && reliable === undefined) return;
  if (value["role"] !== "assistant") {
    throw invalid("Portable Session user messages cannot contain model generation timing.");
  }
  if (reliable !== undefined && typeof reliable !== "boolean") {
    throw invalid("Portable Session message generation timing is invalid.");
  }
  if (duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) <= 0)) {
    throw invalid("Portable Session message generation timing is invalid.");
  }
  if (reliable === true && duration === undefined) {
    throw invalid("Portable Session reliable generation timing requires a duration.");
  }
  if (duration !== undefined && reliable !== true) {
    throw invalid("Portable Session generation duration must be explicitly reliable.");
  }
}

function validateMessageUsage(value: unknown): void {
  if (!isRecord(value)) throw invalid("Portable Session message usage is invalid.");
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) {
      throw invalid("Portable Session message usage is invalid.");
    }
  }
  for (const key of ["contextTokens", "contextWindow"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) {
      throw invalid("Portable Session message usage is invalid.");
    }
  }
  if (typeof value["cost"] !== "number" || !Number.isFinite(value["cost"]) || value["cost"] < 0) {
    throw invalid("Portable Session message usage is invalid.");
  }
  assertExactKeys(value, [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "contextTokens",
    "contextWindow",
    "cost"
  ], "message usage");
}

function validatePastedTextRanges(value: unknown, blocks: readonly MessageBlock[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw invalid("Portable Session pasted-text metadata is invalid.");
  const ranges: InlineTextRange[] = [];
  for (const rawRange of value) {
    if (!isRecord(rawRange)
      || !Number.isSafeInteger(rawRange["start"])
      || !Number.isSafeInteger(rawRange["end"])) {
      throw invalid("Portable Session pasted-text range is invalid.");
    }
    boundedString(rawRange["display"], "pasted-text display", 2_000);
    assertExactKeys(rawRange, ["start", "end", "display"], "pasted-text range");
    ranges.push({
      start: Number(rawRange["start"]),
      end: Number(rawRange["end"]),
      display: rawRange["display"]
    });
  }
  const text = blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
  if (!validInlineTextRanges(text, ranges)) {
    throw invalid("Portable Session pasted-text ranges do not match the message text.");
  }
}

function validateBlock(value: unknown): asserts value is MessageBlock {
  if (!isRecord(value) || typeof value["kind"] !== "string") throw invalid("Portable Session message block is invalid.");
  switch (value["kind"]) {
    case "text":
      boundedString(value["text"], "text block");
      assertExactKeys(value, ["kind", "text"], "text block");
      return;
    case "thinking":
      boundedString(value["text"], "thinking block");
      if (typeof value["redacted"] !== "boolean") throw invalid("Portable Session thinking block is invalid.");
      assertExactKeys(value, ["kind", "text", "redacted"], "thinking block");
      return;
    case "image":
      validateBlob(value["blob"]);
      if (value["alt"] !== undefined) boundedString(value["alt"], "image alternative text");
      assertExactKeys(value, ["kind", "blob", "alt"], "image block");
      return;
    case "artifact":
      validateBlob(value["blob"]);
      boundedString(value["label"], "artifact label");
      assertExactKeys(value, ["kind", "blob", "label"], "artifact block");
      return;
    case "tool_call":
      boundedString(value["callId"], "tool call ID", 4_096);
      boundedString(value["name"], "tool name", 4_096);
      boundedString(value["input"], "tool input");
      assertExactKeys(value, ["kind", "callId", "name", "input"], "tool call block");
      return;
    case "tool_result":
      boundedString(value["callId"], "tool result call ID", 4_096);
      boundedString(value["output"], "tool output");
      if (typeof value["isError"] !== "boolean") throw invalid("Portable Session tool result block is invalid.");
      assertExactKeys(value, ["kind", "callId", "output", "isError"], "tool result block");
      return;
    default:
      throw invalid("Portable Session message block kind is unsupported.");
  }
}

function validateBlob(value: unknown): asserts value is BlobRef {
  if (!isRecord(value)) throw invalid("Portable Session Blob reference is invalid.");
  boundedString(value["id"], "Blob ID", 4_096);
  if (typeof value["sha256"] !== "string" || !SHA256_PATTERN.test(value["sha256"])) {
    throw invalid("Portable Session Blob digest is invalid.");
  }
  if (!Number.isSafeInteger(value["byteLength"]) || Number(value["byteLength"]) < 0) {
    throw invalid("Portable Session Blob length is invalid.");
  }
  boundedString(value["mimeType"], "Blob media type", 1_024);
  if (value["fileName"] !== undefined) boundedString(value["fileName"], "Blob file name", 4_096);
  assertExactKeys(value, ["id", "sha256", "byteLength", "mimeType", "fileName"], "Blob reference");
}

function validateAutomationOrigin(value: unknown): void {
  if (!isRecord(value) || value["kind"] !== "scheduler") throw invalid("Portable Session automation origin is invalid.");
  boundedString(value["scheduleId"], "Schedule ID", 4_096);
  if (value["scheduleName"] !== undefined) boundedString(value["scheduleName"], "Schedule name", 4_096);
  if (value["runId"] !== undefined) boundedString(value["runId"], "Run ID", 4_096);
  assertExactKeys(value, ["kind", "scheduleId", "scheduleName", "runId"], "automation origin");
}

function boundedString(value: unknown, label: string, maximumBytes = MAX_STRING_BYTES): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalid(`Portable Session ${label} is invalid.`);
  }
}

function assertExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const names = new Set(allowed);
  if (Object.keys(value).some((key) => !names.has(key))) throw invalid(`Portable Session ${label} has unsupported fields.`);
}

function sameBlob(left: BlobRef, right: BlobRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256 && left.byteLength === right.byteLength
    && left.mimeType === right.mimeType && left.fileName === right.fileName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): PortableSessionProjectionError {
  return new PortableSessionProjectionError(message);
}
