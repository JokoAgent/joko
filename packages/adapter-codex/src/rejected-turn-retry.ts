import { createHash } from "node:crypto";
import { nativeTurnErrorTag, publicNativeTurnError } from "./errors.js";
import { isJsonObject, type JsonValue } from "./protocol.js";

export type CodexRejectedTurnKind = "capacity" | "rate-limit";

export function isRejectedTurnRetryClientId(value: unknown): boolean {
  return typeof value === "string" && /^joko-internal-retry:v1:[a-f0-9]{64}:[1-4]$/u.test(value);
}

export function rejectedTurnRetryClientId(operationId: string, attempt: number): string {
  return `joko-internal-retry:v1:${createHash("sha256").update(operationId).digest("hex")}:${attempt}`;
}

export function nextRejectedTurnRetryClientId(previous: unknown, next: unknown): boolean {
  if (typeof previous !== "string" || typeof next !== "string" || !isRejectedTurnRetryClientId(next)) return false;
  return isRejectedTurnRetryClientId(previous)
    ? next.slice(0, -1) === previous.slice(0, -1) && Number(next.at(-1)) === Number(previous.at(-1)) + 1
    : next === rejectedTurnRetryClientId(previous, 1);
}

/** Only exact native rejections qualify for an outer retry of the original input. */
export function codexRejectedTurnKind(error: JsonValue | undefined): CodexRejectedTurnKind | undefined {
  if (!isJsonObject(error)) return undefined;
  const tag = nativeTurnErrorTag(error);
  if (tag === "serverOverloaded") return "capacity";
  if (tag === "responseTooManyFailedAttempts" && publicNativeTurnError(error).code === "RATE_LIMITED"
    && !(typeof error["message"] === "string" && /\b(?:usage limit|session budget|quota exceeded|insufficient quota)\b/iu.test(error["message"]))) {
    return "rate-limit";
  }
  return undefined;
}

export function codexRejectedTurnBackoff(kind: CodexRejectedTurnKind, attempt: number) {
  const maxAttempts = kind === "capacity" ? 4 : 2;
  if (attempt > maxAttempts) return undefined;
  const base = Math.min(30_000, (kind === "capacity" ? 2_000 : 15_000) * 2 ** (attempt - 1));
  const delayMs = Math.min(30_000, Math.round(base * (0.75 + Math.random() * 0.5)));
  return { maxAttempts, delayMs };
}
