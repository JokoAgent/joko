import type { UsageSnapshot } from "@joko/core";

import { isRecord } from "./protocol.js";

export interface ProjectedMessageGenerationTiming {
  readonly generationDurationMs?: number;
  readonly generationReliable: boolean;
}

/** Project one native assistant-message accounting record without inventing partial values. */
export function projectMessageUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = tokenCount(value.input);
  const outputTokens = tokenCount(value.output);
  const cacheReadTokens = tokenCount(value.cacheRead);
  const cacheWriteTokens = tokenCount(value.cacheWrite);
  if (inputTokens === undefined
    || outputTokens === undefined
    || cacheReadTokens === undefined
    || cacheWriteTokens === undefined) return undefined;
  const derivedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (!Number.isSafeInteger(derivedTotal)) return undefined;
  const totalTokens = value.totalTokens === undefined ? derivedTotal : tokenCount(value.totalTokens);
  if (totalTokens === undefined) return undefined;
  const rawCost = isRecord(value.cost) ? value.cost.total : value.cost;
  const cost = rawCost === undefined ? 0 : finiteNonNegative(rawCost);
  if (cost === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    cost
  };
}

/**
 * Preserve only an explicit native generation duration. A message timestamp or
 * product Run wall clock includes unrelated waits and must never be used for TPS.
 */
export function projectMessageGenerationTiming(value: unknown): ProjectedMessageGenerationTiming {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { generationReliable: false };
  }
  const generationDurationMs = Math.round(value);
  if (!Number.isSafeInteger(generationDurationMs) || generationDurationMs <= 0) {
    return { generationReliable: false };
  }
  return { generationDurationMs, generationReliable: true };
}

function tokenCount(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
