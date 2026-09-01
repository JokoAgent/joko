import type { PublicError } from "@joko/core";
import type { OperationalStore } from "@joko/store";

export interface StoredProviderRateLimit {
  readonly limited: boolean;
  readonly resetsAt?: number;
  readonly observedAt: number;
}

const EXCLUDED_FAILURE = /\b(?:insufficient_quota|billing[_ -]?error|credit(?:s| balance)?\s+(?:depleted|exhausted|too low)|at capacity|overloaded(?:_error)?|server overloaded)\b/iu;
const LIMIT_FAILURE = /\b(?:usage[_ -]?limit(?:[_ -]?(?:reached|exceeded))?|rate[_ -]?limit(?:[_ -]?(?:reached|exceeded))?|too many requests|quota\s+(?:exceeded|exhausted)|you(?:'|’)ve hit your (?:(?:session|weekly) )?limit|you have hit your .*?usage limit)\b/iu;

export function providerRateLimitSettingKey(backendId: string, providerId: string): string {
  return `runtime.provider.rate_limit.${backendId.length}:${backendId}:${providerId.length}:${providerId}`;
}

/**
 * Converts a public, already-redacted Provider failure into bounded numeric
 * state. The original message is deliberately never returned or persisted.
 */
export function providerRateLimitFromError(
  error: PublicError,
  observedAt = Date.now()
): StoredProviderRateLimit | undefined {
  const text = `${error.code}\n${error.message}\n${error.recovery}`;
  if (EXCLUDED_FAILURE.test(text) || !LIMIT_FAILURE.test(text)) return undefined;
  const resetsAt = resetAtFromText(text, observedAt);
  return {
    limited: true,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    observedAt
  };
}

export function recordProviderRateLimit(
  store: OperationalStore,
  backendId: string | undefined,
  providerId: string | undefined,
  error: PublicError,
  observedAt = Date.now()
): StoredProviderRateLimit | undefined {
  if (backendId === undefined || backendId.trim() === ""
      || providerId === undefined || providerId.trim() === "") return undefined;
  const observation = providerRateLimitFromError(error, observedAt);
  if (observation === undefined) return undefined;
  store.setSetting(
    "service",
    "orchestrator",
    providerRateLimitSettingKey(backendId, providerId),
    observation,
    observedAt
  );
  return observation;
}

export function clearProviderRateLimit(
  store: OperationalStore,
  backendId: string | undefined,
  providerId: string | undefined
): void {
  if (backendId === undefined || backendId.trim() === ""
      || providerId === undefined || providerId.trim() === "") return;
  store.deleteSetting("service", "orchestrator", providerRateLimitSettingKey(backendId, providerId));
}

export function currentProviderRateLimit(value: unknown, now = Date.now()): StoredProviderRateLimit | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const limited = record["limited"];
  const observedAt = record["observedAt"];
  const resetCandidate = record["resetsAt"];
  if (typeof limited !== "boolean" || !safeMillis(observedAt)) return undefined;
  const resetsAt = safeMillis(resetCandidate) ? resetCandidate : undefined;
  if (limited && resetsAt !== undefined && resetsAt <= now) return undefined;
  return { limited, ...(resetsAt === undefined ? {} : { resetsAt }), observedAt };
}

function resetAtFromText(text: string, now: number): number | undefined {
  const labeledEpoch = text.match(
    /(?:reset(?:s|[_ -]?at)?|retry[_ -]?after)\D{0,24}(\d{10,13})\b/iu
  )?.[1];
  if (labeledEpoch !== undefined) {
    const numeric = Number(labeledEpoch);
    const timestamp = numeric >= 100_000_000_000 ? numeric : numeric * 1_000;
    if (safeMillis(timestamp) && timestamp > now) return timestamp;
  }

  const isoValues = text.match(
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/gu
  );
  for (const value of isoValues ?? []) {
    const parsed = Date.parse(value);
    if (safeMillis(parsed) && parsed > now) return parsed;
  }

  const relative = text.match(
    /(?:resets?|retry(?:\s+after)?|try\s+again)\s+(?:at\s+)?(?:in\s+)?~?((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\s*)+)/iu
  )?.[1];
  if (relative === undefined) return undefined;
  let delay = 0;
  for (const match of relative.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/giu)) {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase() ?? "";
    if (unit.startsWith("d")) delay += amount * 86_400_000;
    else if (unit.startsWith("h")) delay += amount * 3_600_000;
    else if (unit.startsWith("m")) delay += amount * 60_000;
    else delay += amount * 1_000;
  }
  const timestamp = now + delay;
  return delay > 0 && safeMillis(timestamp) ? timestamp : undefined;
}

function safeMillis(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
