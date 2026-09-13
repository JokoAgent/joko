import { createHash } from "node:crypto";
import {
  redactSecrets,
  type MessageBlock,
  type ProviderModel,
  type PublicError,
  type UsageSnapshot
} from "@joko/core";
import type { ClaudeSdkModelInfo } from "./sdk-runtime.js";

const MAX_DISPLAY_TEXT = 64 * 1024;
const MAX_TOOL_TEXT = 32 * 1024;
const MAX_IDENTIFIER = 512;
const MAX_NATIVE_CONTENT_BLOCKS = 256;
const MAX_PENDING_STREAM_BLOCKS = 256;
const TRUNCATION_MARKER = "\n[Truncated]";

export class ProjectionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionLimitError";
  }
}

export interface ProjectedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: string;
  readonly block: MessageBlock;
}

export interface ProjectedToolResult {
  readonly callId: string;
  readonly output: string;
  readonly isError: boolean;
  readonly block: MessageBlock;
}

export interface ProjectedAssistantContent {
  readonly blocks: readonly MessageBlock[];
  readonly toolCalls: readonly ProjectedToolCall[];
}

export interface ProjectedUserContent {
  readonly toolResults: readonly ProjectedToolResult[];
}

export interface ResultProjection {
  readonly outcome: "completed" | "aborted" | "failed";
  readonly error?: PublicError;
  readonly usage: UsageSnapshot;
  readonly messageUsage: UsageSnapshot;
  readonly totalCostUsd: number;
  readonly durationMs?: number;
  readonly fallbackText?: string;
}

export class SafeProjection {
  readonly #redactValues: readonly string[];
  readonly #dynamicRedactValues: (() => readonly string[]) | undefined;

  constructor(redactValues: readonly string[], dynamicRedactValues?: () => readonly string[]) {
    this.#redactValues = [...redactValues]
      .filter((value) => value.length > 0)
      .sort((left, right) => right.length - left.length);
    this.#dynamicRedactValues = dynamicRedactValues;
  }

  text(value: unknown, maximum = MAX_DISPLAY_TEXT): string {
    if (typeof value !== "string") return "";
    let projected = redactSecrets(value);
    const redactions = [
      ...this.#redactValues,
      ...(this.#dynamicRedactValues?.() ?? [])
    ].sort((left, right) => right.length - left.length);
    for (const secret of redactions) {
      if (secret.length > 0) projected = projected.split(secret).join("[REDACTED]");
    }
    return bound(projected, maximum);
  }

  identifier(value: unknown, fallback: string): string {
    const projected = this.text(value, MAX_IDENTIFIER).trim();
    return projected.length === 0 ? fallback : projected;
  }

  json(value: unknown): string {
    try {
      return this.text(JSON.stringify(boundedJsonValue(value)), MAX_TOOL_TEXT);
    } catch {
      return "[Input could not be displayed.]";
    }
  }

  assistant(message: unknown): ProjectedAssistantContent {
    const envelope = record(message);
    const nativeMessage = record(envelope?.["message"]);
    const content = Array.isArray(nativeMessage?.["content"]) ? nativeMessage["content"] : [];
    if (content.length > MAX_NATIVE_CONTENT_BLOCKS) {
      throw new ProjectionLimitError("The native assistant message exceeded the content-block limit.");
    }
    const blocks: MessageBlock[] = [];
    const toolCalls: ProjectedToolCall[] = [];

    for (const rawBlock of content) {
      const block = record(rawBlock);
      const type = stringValue(block?.["type"]);
      if (type === "text") {
        const text = this.text(block?.["text"]);
        if (text.length > 0) blocks.push({ kind: "text", text });
        continue;
      }
      if (type === "thinking") {
        const text = this.text(block?.["thinking"]);
        if (text.length > 0) blocks.push({ kind: "thinking", text, redacted: false });
        continue;
      }
      if (type === "redacted_thinking") {
        blocks.push({ kind: "thinking", text: "", redacted: true });
        continue;
      }
      if (type !== "tool_use") continue;
      const callId = this.identifier(block?.["id"], opaqueId("tool", rawBlock));
      const name = this.identifier(block?.["name"], "Tool");
      const input = this.json(block?.["input"] ?? {});
      const projectedBlock: MessageBlock = { kind: "tool_call", callId, name, input };
      blocks.push(projectedBlock);
      toolCalls.push({ callId, name, input, block: projectedBlock });
    }
    return { blocks, toolCalls };
  }

  user(message: unknown): ProjectedUserContent {
    const envelope = record(message);
    const nativeMessage = record(envelope?.["message"]);
    const content = Array.isArray(nativeMessage?.["content"]) ? nativeMessage["content"] : [];
    if (content.length > MAX_NATIVE_CONTENT_BLOCKS) {
      throw new ProjectionLimitError("The native user message exceeded the content-block limit.");
    }
    const toolResults: ProjectedToolResult[] = [];
    for (const rawBlock of content) {
      const block = record(rawBlock);
      if (stringValue(block?.["type"]) !== "tool_result") continue;
      const callId = this.identifier(block?.["tool_use_id"], opaqueId("tool-result", rawBlock));
      const output = this.toolResultContent(block?.["content"]);
      const isError = block?.["is_error"] === true;
      const projectedBlock: MessageBlock = { kind: "tool_result", callId, output, isError };
      toolResults.push({ callId, output, isError, block: projectedBlock });
    }
    return { toolResults };
  }

  result(message: unknown, previousTotalCostUsd: number, assistantError?: string): ResultProjection {
    const value = record(message) ?? {};
    const subtype = stringValue(value["subtype"]);
    const terminalReason = stringValue(value["terminal_reason"]);
    const isError = value["is_error"] === true;
    const totalCostUsd = nonNegative(value["total_cost_usd"]);
    const costDelta = totalCostUsd >= previousTotalCostUsd
      ? totalCostUsd - previousTotalCostUsd
      : totalCostUsd;
    const messageUsage = usageFromNative(value["usage"], costDelta);
    const usage = cumulativeUsage(value["modelUsage"], totalCostUsd, messageUsage);
    const duration = finite(value["duration_api_ms"]) ?? finite(value["duration_ms"]);
    const durationMs = duration === undefined ? undefined : Math.max(0, duration);
    const aborted = terminalReason === "aborted_streaming"
      || terminalReason === "aborted_tools"
      || terminalReason === "hook_stopped";
    const failed = assistantError !== undefined || isError || subtype !== "success";
    const fallbackText = !failed && subtype === "success" ? this.text(value["result"]) : undefined;
    if (aborted) return { outcome: "aborted", usage, messageUsage, totalCostUsd, durationMs };
    if (!failed) return { outcome: "completed", usage, messageUsage, totalCostUsd, durationMs, fallbackText };
    return {
      outcome: "failed",
      error: classifyFailure(subtype, terminalReason, assistantError),
      usage,
      messageUsage,
      totalCostUsd,
      durationMs
    };
  }

  toolResultContent(value: unknown): string {
    if (typeof value === "string") return this.text(value, MAX_TOOL_TEXT);
    if (!Array.isArray(value)) return this.json(value);
    const fragments: string[] = [];
    for (const rawPart of value.slice(0, MAX_NATIVE_CONTENT_BLOCKS)) {
      const part = record(rawPart);
      if (stringValue(part?.["type"]) === "text") {
        const text = this.text(part?.["text"], MAX_TOOL_TEXT);
        if (text.length > 0) fragments.push(text);
      }
    }
    if (value.length > MAX_NATIVE_CONTENT_BLOCKS) fragments.push("[Truncated]");
    return bound(fragments.join("\n"), MAX_TOOL_TEXT);
  }
}

interface PendingStreamBlock {
  readonly kind: "text" | "thinking";
  value: string;
  truncated: boolean;
}

export class PartialMessageBuffer {
  #epoch = 0;
  readonly #blocks = new Map<number, PendingStreamBlock>();

  accept(eventEnvelope: unknown, projection: SafeProjection): {
    readonly kind: "text" | "thinking";
    readonly blockId: string;
    readonly contentIndex: number;
    readonly delta: string;
  } | undefined {
    const envelope = record(eventEnvelope);
    const event = record(envelope?.["event"]);
    const type = stringValue(event?.["type"]);
    if (type === "message_start") {
      this.#epoch += 1;
      this.#blocks.clear();
      return undefined;
    }
    const index = integer(event?.["index"]);
    if (index === undefined || index < 0) return undefined;
    if (type === "content_block_start") {
      const contentBlock = record(event?.["content_block"]);
      const blockType = stringValue(contentBlock?.["type"]);
      if (blockType === "text") {
        this.#setBlock(index, "text", stringValue(contentBlock?.["text"]) ?? "");
      } else if (blockType === "thinking") {
        this.#setBlock(index, "thinking", stringValue(contentBlock?.["thinking"]) ?? "");
      }
      return undefined;
    }
    if (type === "content_block_delta") {
      const delta = record(event?.["delta"]);
      const deltaType = stringValue(delta?.["type"]);
      const fragment = deltaType === "text_delta"
        ? stringValue(delta?.["text"])
        : deltaType === "thinking_delta"
          ? stringValue(delta?.["thinking"])
          : undefined;
      if (fragment === undefined) return undefined;
      const kind = deltaType === "text_delta" ? "text" : "thinking";
      const pending = this.#blocks.get(index);
      if (pending === undefined || pending.kind !== kind) {
        this.#setBlock(index, kind, fragment);
      } else {
        appendStreamFragment(pending, fragment);
      }
      return undefined;
    }
    if (type !== "content_block_stop") return undefined;
    const pending = this.#blocks.get(index);
    this.#blocks.delete(index);
    if (pending === undefined) return undefined;
    const delta = projection.text(pending.truncated ? `${pending.value}${TRUNCATION_MARKER}` : pending.value);
    if (delta.length === 0) return undefined;
    return {
      kind: pending.kind,
      blockId: `claude-block-${this.#epoch}-${index}`,
      contentIndex: index,
      delta
    };
  }

  reset(): void {
    this.#blocks.clear();
    this.#epoch += 1;
  }

  #setBlock(index: number, kind: PendingStreamBlock["kind"], initialValue: string): void {
    if (!this.#blocks.has(index) && this.#blocks.size >= MAX_PENDING_STREAM_BLOCKS) {
      throw new ProjectionLimitError("The native stream exceeded the pending content-block limit.");
    }
    const maximum = MAX_DISPLAY_TEXT - TRUNCATION_MARKER.length;
    this.#blocks.set(index, {
      kind,
      value: initialValue.slice(0, maximum),
      truncated: initialValue.length > maximum
    });
  }
}

export function providerModel(model: ClaudeSdkModelInfo, projection: SafeProjection): ProviderModel {
  return {
    providerId: "claude-code",
    modelId: projection.identifier(model.value, "unknown-model"),
    displayName: projection.identifier(model.displayName, "Unknown model"),
    api: "anthropic-messages",
    contextWindow: 0,
    maxOutputTokens: 0,
    supportsImages: false,
    supportsFastMode: model.supportsFastMode ?? false,
    thinkingLevels: model.supportsEffort ? [...(model.supportedEffortLevels ?? ["low", "medium", "high"])] : [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function cumulativeUsage(value: unknown, cost: number, fallback: UsageSnapshot): UsageSnapshot {
  const models = record(value);
  if (models === undefined) return { ...fallback, cost };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let contextWindow: number | undefined;
  for (const rawUsage of Object.values(models)) {
    const usage = record(rawUsage);
    if (usage === undefined) continue;
    inputTokens += nonNegative(usage["inputTokens"]);
    outputTokens += nonNegative(usage["outputTokens"]);
    cacheReadTokens += nonNegative(usage["cacheReadInputTokens"]);
    cacheWriteTokens += nonNegative(usage["cacheCreationInputTokens"]);
    const nativeWindow = finite(usage["contextWindow"]);
    if (nativeWindow !== undefined && nativeWindow >= 0) {
      contextWindow = Math.max(contextWindow ?? 0, nativeWindow);
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    cost
  };
}

function usageFromNative(value: unknown, cost: number): UsageSnapshot {
  const usage = record(value) ?? {};
  const inputTokens = nonNegative(usage["input_tokens"]);
  const outputTokens = nonNegative(usage["output_tokens"]);
  const cacheReadTokens = nonNegative(usage["cache_read_input_tokens"]);
  const cacheWriteTokens = nonNegative(usage["cache_creation_input_tokens"]);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    cost
  };
}

function classifyFailure(subtype: string | undefined, terminalReason: string | undefined, assistantError: string | undefined): PublicError {
  const category = assistantError ?? terminalReason ?? subtype ?? "unknown";
  if (category === "authentication_failed" || category === "oauth_org_not_allowed") {
    return publicFailure("CLAUDE_CODE_AUTHENTICATION_FAILED", "Claude Code could not authenticate this request.", false, "Sign in or repair the configured credential source, then retry.");
  }
  if (category === "billing_error" || category === "account_on_hold") {
    return publicFailure("CLAUDE_CODE_BILLING_UNAVAILABLE", "The provider account cannot serve this request.", false, "Resolve the provider account status before retrying.");
  }
  if (category === "rate_limit" || category === "overloaded" || category === "server_error" || category === "api_error") {
    return publicFailure("CLAUDE_CODE_PROVIDER_UNAVAILABLE", "The provider is temporarily unavailable.", true, "Retry later or select another available model.");
  }
  if (category === "model_not_found") {
    return publicFailure("CLAUDE_CODE_MODEL_UNAVAILABLE", "The selected model is unavailable.", false, "Refresh the model catalog and select an available model.");
  }
  if (category === "prompt_too_long" || category === "max_output_tokens") {
    return publicFailure("CLAUDE_CODE_CONTEXT_LIMIT", "The request exceeded a model context or output limit.", false, "Reduce the input or start a fresh native session.");
  }
  if (category === "max_turns" || category === "error_max_turns") {
    return publicFailure("CLAUDE_CODE_TURN_LIMIT", "The native turn limit was reached.", false, "Start a new turn with a narrower request.");
  }
  if (category === "budget_exhausted" || category === "error_max_budget_usd") {
    return publicFailure("CLAUDE_CODE_BUDGET_LIMIT", "The native budget limit was reached.", false, "Adjust the approved budget before retrying.");
  }
  return publicFailure("CLAUDE_CODE_EXECUTION_FAILED", "Claude Code could not complete the turn.", true, "Inspect the native session before retrying.");
}

function publicFailure(code: string, message: string, retryable: boolean, recovery: string): PublicError {
  return { code, message, phase: "turn", retryable, stateMayHaveChanged: false, recovery };
}

function nonNegative(value: unknown): number {
  const projected = finite(value);
  return projected === undefined ? 0 : Math.max(0, projected);
}

function bound(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const contentMaximum = Math.max(0, maximum - TRUNCATION_MARKER.length);
  return `${value.slice(0, contentMaximum)}${TRUNCATION_MARKER}`;
}

function appendStreamFragment(pending: PendingStreamBlock, fragment: string): void {
  if (pending.truncated) return;
  const maximum = MAX_DISPLAY_TEXT - TRUNCATION_MARKER.length;
  const remaining = maximum - pending.value.length;
  if (fragment.length <= remaining) {
    pending.value += fragment;
    return;
  }
  if (remaining > 0) pending.value += fragment.slice(0, remaining);
  pending.truncated = true;
}

function opaqueId(namespace: string, value: unknown): string {
  const digest = createHash("sha256").update(namespace).update(stableString(value)).digest("hex").slice(0, 24);
  return `${namespace}-${digest}`;
}

function stableString(value: unknown): string {
  try {
    return JSON.stringify(boundedJsonValue(value)) ?? "undefined";
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function boundedJsonValue(
  value: unknown,
  budget: { nodes: number; characters: number } = { nodes: 0, characters: 0 },
  seen: WeakSet<object> = new WeakSet(),
  depth = 0
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 2_048 || budget.characters >= MAX_TOOL_TEXT || depth > 32) return "[Truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const remaining = Math.max(0, MAX_TOOL_TEXT - budget.characters);
    const projected = value.slice(0, remaining);
    budget.characters += projected.length;
    return projected.length === value.length ? projected : `${projected}${TRUNCATION_MARKER}`;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let index = 0; index < value.length && index < MAX_NATIVE_CONTENT_BLOCKS; index += 1) {
        output.push(boundedJsonValue(value[index], budget, seen, depth + 1));
        if (budget.nodes > 2_048 || budget.characters >= MAX_TOOL_TEXT) break;
      }
      if (output.length < value.length) output.push("[Truncated]");
      return output;
    }
    const output: Record<string, unknown> = {};
    let properties = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (properties >= MAX_NATIVE_CONTENT_BLOCKS
        || budget.nodes > 2_048 || budget.characters >= MAX_TOOL_TEXT) {
        output["[Truncated]"] = true;
        break;
      }
      properties += 1;
      const projectedKey = key.slice(0, MAX_IDENTIFIER);
      budget.characters += projectedKey.length;
      output[projectedKey] = boundedJsonValue(
        (value as Readonly<Record<string, unknown>>)[key],
        budget,
        seen,
        depth + 1
      );
    }
    return output;
  } finally {
    seen.delete(value);
  }
}
