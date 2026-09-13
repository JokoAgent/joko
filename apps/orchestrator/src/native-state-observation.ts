import { createHash } from "node:crypto";

import {
  redactSecrets,
  type NativeSessionState,
  type PiNativeStateMetadata,
  type UsageSnapshot
} from "@joko/core";

export const SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY = "runtime.native.state.observation";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_DISPLAY_LENGTH = 2_048;

/**
 * One successful, generation-fenced Backend inspection. The opaque native
 * reference is represented only by a digest so a service-node path never
 * leaks into snapshots, diagnostics, or another Backend's shared state.
 */
export interface MaterializedNativeStateObservation {
  readonly format: 1;
  readonly generation: number;
  readonly bindingFingerprint: string;
  readonly observedAt: number;
  /** A later observation attempt or state-changing effect failed/was uncertain. */
  readonly staleAt?: number;
  readonly state: MaterializedNativeState;
  /** Backend-namespaced typed detail. Absence means a Pi panel is partial. */
  readonly pi?: PiNativeStateMetadata;
}

export interface MaterializedNativeState {
  readonly nativeSessionId?: string;
  readonly name?: string;
  readonly streaming: boolean;
  readonly compacting: boolean;
  readonly pendingMessages: number;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: NativeSessionState["permissionMode"];
  readonly usage?: UsageSnapshot;
  readonly autoCompaction?: boolean;
  readonly autoRetry?: boolean;
}

export function nativeStateObservation(
  state: NativeSessionState,
  pi: PiNativeStateMetadata | undefined = state.pi,
  observedAt = Date.now()
): MaterializedNativeStateObservation {
  const generation = state.binding.generation;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Native state observation generation is invalid.");
  }
  if (!Number.isFinite(observedAt) || observedAt < 0) {
    throw new Error("Native state observation time is invalid.");
  }
  return {
    format: 1,
    generation,
    bindingFingerprint: nativeBindingFingerprint(state.binding.opaqueRef),
    observedAt,
    state: normalizeNativeState(state),
    ...(pi === undefined ? {} : { pi: normalizePiNativeState(pi) })
  };
}

export function materializedNativeStateObservation(
  value: unknown
): MaterializedNativeStateObservation | undefined {
  if (!isRecord(value) || value["format"] !== 1) return undefined;
  const generation = nonnegativeInteger(value["generation"]);
  const observedAt = finiteNonnegative(value["observedAt"]);
  const staleAt = value["staleAt"] === undefined ? undefined : finiteNonnegative(value["staleAt"]);
  const bindingFingerprint = value["bindingFingerprint"];
  if (
    generation === undefined || observedAt === undefined ||
    (value["staleAt"] !== undefined && (staleAt === undefined || staleAt < observedAt)) ||
    typeof bindingFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(bindingFingerprint)
  ) return undefined;
  try {
    const state = normalizeMaterializedNativeState(value["state"]);
    const pi = value["pi"] === undefined ? undefined : normalizePiNativeState(value["pi"]);
    return {
      format: 1,
      generation,
      bindingFingerprint,
      observedAt,
      ...(staleAt === undefined ? {} : { staleAt }),
      state,
      ...(pi === undefined ? {} : { pi })
    };
  } catch {
    return undefined;
  }
}

export function nativeStateObservationIsCurrent(
  observation: MaterializedNativeStateObservation,
  generation: number,
  opaqueReference: string
): boolean {
  return observation.staleAt === undefined &&
    observation.generation === generation &&
    observation.bindingFingerprint === nativeBindingFingerprint(opaqueReference);
}

export function markNativeStateObservationStale(
  observation: MaterializedNativeStateObservation,
  staleAt = Date.now()
): MaterializedNativeStateObservation {
  if (!Number.isFinite(staleAt) || staleAt < observation.observedAt) {
    throw new Error("Native state stale time is invalid.");
  }
  if (observation.staleAt !== undefined && observation.staleAt >= staleAt) return observation;
  return { ...observation, staleAt };
}

export function nativeBindingFingerprint(opaqueReference: string): string {
  if (
    typeof opaqueReference !== "string" || opaqueReference.trim() === "" ||
    opaqueReference.length > 32_768 || opaqueReference.includes("\0")
  ) {
    throw new Error("Native binding reference is invalid.");
  }
  return `sha256:${createHash("sha256").update(opaqueReference).digest("hex")}`;
}

function normalizeNativeState(state: NativeSessionState): MaterializedNativeState {
  return normalizeMaterializedNativeState({
    nativeSessionId: state.binding.nativeSessionId,
    name: state.name,
    streaming: state.streaming,
    compacting: state.compacting,
    pendingMessages: state.pendingMessages,
    providerId: state.providerId,
    modelId: state.modelId,
    effort: state.effort,
    fastMode: state.fastMode,
    permissionMode: state.permissionMode,
    usage: state.usage,
    autoCompaction: state.autoCompaction,
    autoRetry: state.autoRetry
  });
}

function normalizeMaterializedNativeState(value: unknown): MaterializedNativeState {
  if (!isRecord(value)) throw new Error("Native state observation is invalid.");
  const streaming = value["streaming"];
  const compacting = value["compacting"];
  const pendingMessages = nonnegativeInteger(value["pendingMessages"]);
  const fastMode = value["fastMode"];
  const permissionMode = value["permissionMode"];
  if (
    typeof streaming !== "boolean" || typeof compacting !== "boolean" ||
    pendingMessages === undefined || typeof fastMode !== "boolean" ||
    (permissionMode !== "ask" && permissionMode !== "auto" && permissionMode !== "bypassPermissions")
  ) throw new Error("Native state observation fields are invalid.");
  const nativeSessionId = optionalNativeIdentifier(value["nativeSessionId"]);
  const name = optionalText(value["name"], MAX_DISPLAY_LENGTH);
  const providerId = optionalText(value["providerId"], MAX_IDENTIFIER_LENGTH);
  const modelId = optionalText(value["modelId"], MAX_IDENTIFIER_LENGTH);
  const effort = optionalText(value["effort"], MAX_IDENTIFIER_LENGTH);
  const usage = normalizeUsage(value["usage"]);
  const autoCompaction = optionalBoolean(value["autoCompaction"]);
  const autoRetry = optionalBoolean(value["autoRetry"]);
  return {
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(name === undefined ? {} : { name }),
    streaming,
    compacting,
    pendingMessages,
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
    fastMode,
    permissionMode,
    ...(usage === undefined ? {} : { usage }),
    ...(autoCompaction === undefined ? {} : { autoCompaction }),
    ...(autoRetry === undefined ? {} : { autoRetry })
  };
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Native state observation boolean is invalid.");
  return value;
}

function normalizePiNativeState(value: unknown): PiNativeStateMetadata {
  if (!isRecord(value)) throw new Error("Pi native state observation is invalid.");
  const streaming = requiredBoolean(value["streaming"]);
  const compacting = requiredBoolean(value["compacting"]);
  const autoCompaction = requiredBoolean(value["autoCompaction"]);
  const autoRetry = requiredBoolean(value["autoRetry"]);
  const messageCount = nonnegativeInteger(value["messageCount"]);
  const pendingMessageCount = nonnegativeInteger(value["pendingMessageCount"]);
  if (messageCount === undefined || pendingMessageCount === undefined) {
    throw new Error("Pi native state counters are invalid.");
  }
  const steeringMode = queueMode(value["steeringMode"]);
  const followUpMode = queueMode(value["followUpMode"]);
  const modelValue = value["model"];
  let model: PiNativeStateMetadata["model"];
  if (modelValue !== undefined) {
    if (!isRecord(modelValue)) throw new Error("Pi native model observation is invalid.");
    const providerId = requiredText(modelValue["providerId"], MAX_IDENTIFIER_LENGTH);
    const modelId = requiredText(modelValue["modelId"], MAX_IDENTIFIER_LENGTH);
    model = { providerId, modelId };
  }
  return {
    nativeSessionId: safeNativeIdentifierDisplay(value["nativeSessionId"]),
    nativeSessionName: requiredText(value["nativeSessionName"], MAX_DISPLAY_LENGTH, true),
    // This is a display value only. Never materialize an opaque absolute path.
    nativeSessionFileDisplay: safeFileDisplay(value["nativeSessionFileDisplay"]),
    ...(model === undefined ? {} : { model }),
    thinkingLevel: requiredText(value["thinkingLevel"], MAX_IDENTIFIER_LENGTH, true),
    streaming,
    compacting,
    steeringMode,
    followUpMode,
    autoCompaction,
    autoRetry,
    messageCount,
    pendingMessageCount,
    activeLeafId: requiredText(value["activeLeafId"], MAX_IDENTIFIER_LENGTH, true)
  };
}

function safeFileDisplay(value: unknown): string {
  const text = requiredText(value, MAX_DISPLAY_LENGTH, true);
  const parts = text.split(/[\\/]/u);
  return parts.at(-1) ?? "";
}

function safeNativeIdentifierDisplay(value: unknown): string {
  const text = requiredText(value, MAX_IDENTIFIER_LENGTH);
  // Native IDs are presentation-only in the durable observation. A Backend
  // that uses its session file as an ID must not turn that OS path into public
  // Snapshot state; control continues to use the separately hashed binding.
  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/u.test(text)) {
    const display = text.split(/[\\/]/u).filter(Boolean).at(-1);
    if (display === undefined || display === "") throw new Error("Native session identifier is invalid.");
    return display;
  }
  return text;
}

function optionalNativeIdentifier(value: unknown): string | undefined {
  return value === undefined ? undefined : safeNativeIdentifierDisplay(value);
}

function queueMode(value: unknown): PiNativeStateMetadata["steeringMode"] {
  if (value === "unknown" || value === "all" || value === "one_at_a_time") return value;
  throw new Error("Pi queue mode observation is invalid.");
}

function normalizeUsage(value: unknown): UsageSnapshot | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Native usage observation is invalid.");
  const inputTokens = nonnegativeInteger(value["inputTokens"]);
  const outputTokens = nonnegativeInteger(value["outputTokens"]);
  const cacheReadTokens = nonnegativeInteger(value["cacheReadTokens"]);
  const cacheWriteTokens = nonnegativeInteger(value["cacheWriteTokens"]);
  const totalTokens = nonnegativeInteger(value["totalTokens"]);
  const cost = finiteNonnegative(value["cost"]);
  if (
    inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined ||
    cacheWriteTokens === undefined || totalTokens === undefined || cost === undefined
  ) throw new Error("Native usage observation is invalid.");
  const contextTokens = optionalNonnegativeInteger(value["contextTokens"]);
  const contextWindow = optionalNonnegativeInteger(value["contextWindow"]);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    cost
  };
}

function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  const text = requiredText(value, maximum, true);
  return text === "" ? undefined : text;
}

function requiredText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new Error("Native state text is invalid.");
  const text = redactSecrets(value).slice(0, maximum).trim();
  if (!allowEmpty && text === "") throw new Error("Native state text is empty.");
  return text;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Native state boolean is invalid.");
  return value;
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : nonnegativeInteger(value);
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
