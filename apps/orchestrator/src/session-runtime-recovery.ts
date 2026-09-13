import type { PublicError } from "@joko/core";

export const SESSION_RUNTIME_RECOVERY_MAX_CONSECUTIVE_ATTEMPTS = 5;
export const SESSION_RUNTIME_RECOVERY_MAX_EPISODE_ATTEMPTS = 10;

const NETWORK_FAILURE = /(?:\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bENETUNREACH\b|\bEHOSTUNREACH\b|socket hang up|fetch failed|request timed out|connection (?:closed|reset)|\b(?:502|503|504)\b)/iu;
const DETERMINISTIC_FAILURE = /auth(?:entication|orization)?|permission|forbidden|unauthorized|invalid (?:argument|parameter|request)|protocol|user (?:abort|cancel)/iu;

/** Closed allowlist for host-owned continuation after the Backend has exhausted native retries. */
export function isSafeSessionRuntimeRecoveryError(error: PublicError): boolean {
  if (error.code === "UPSTREAM_STREAM_INTERRUPTED" || error.code === "UPSTREAM_OVERLOAD") return true;
  if (error.code === "BACKEND_RUN_SILENCE_TIMEOUT") return true;
  if (DETERMINISTIC_FAILURE.test(`${error.code} ${error.message}`)) return false;
  return NETWORK_FAILURE.test(error.message);
}

export function sessionRuntimeRecoveryDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const base = Math.min(3_000 * (2 ** Math.max(0, attempt - 1)), 20_000);
  const factor = 1 + (random() * 2 - 1) * 0.25;
  return Math.min(Math.round(base * factor), 20_000);
}
