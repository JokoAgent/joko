import { capabilityNames } from "@joko/contracts";
import type { ErrorView, ProviderRuntimeView, ScheduleDraft, SessionView } from "./model.js";
import { scheduleLocalDateTimeFromEpoch } from "./schedule-time.js";

export interface UsageLimitRecoveryHint {
  readonly resetAtMs: number | null;
}

export interface UsageLimitScheduleIntent {
  readonly requestId: string;
  readonly sessionId: string;
  readonly resetAtMs: number | null;
}

let pendingIntent: UsageLimitScheduleIntent | undefined;
let intentSequence = 0;

const EXCLUDED_FAILURE = /\b(?:insufficient_quota|billing[_ -]?error|credit(?:s| balance)?\s+(?:depleted|exhausted|too low)|at capacity|overloaded(?:_error)?|server overloaded)\b/iu;
const LIMIT_FAILURE = /\b(?:usage[_ -]?limit(?:[_ -]?(?:reached|exceeded))?|rate[_ -]?limit(?:[_ -]?(?:reached|exceeded))?|too many requests|quota\s+(?:exceeded|exhausted)|you(?:'|’)ve hit your (?:(?:session|weekly) )?limit|you have hit your .*?usage limit)\b/iu;
const USED_PERCENT_LIMIT_EPSILON = 1e-6;

export function providerAccountUsageResetAt(
  providers: readonly ProviderRuntimeView[],
  providerId: string | undefined,
  now = Date.now()
): number | undefined {
  if (providerId === undefined) return undefined;
  const provider = providers.find((candidate) => candidate.id === providerId
    && candidate.capabilities.has(capabilityNames.providerAccountUsage));
  const usage = provider?.accountUsage;
  if (usage === undefined) return undefined;
  const reached = [usage.primaryWindow, usage.secondaryWindow]
    .filter((window): window is NonNullable<typeof window> => window !== undefined
      && Number.isFinite(window.usedPercent)
      && window.usedPercent >= 100 - USED_PERCENT_LIMIT_EPSILON);
  if (reached.length === 0) return undefined;
  const resets: number[] = [];
  for (const window of reached) {
    const resetAt = window.resetAt;
    if (resetAt === undefined || !Number.isSafeInteger(resetAt) || resetAt <= now) return undefined;
    resets.push(resetAt);
  }
  return Math.max(...resets);
}

export function usageLimitRecoveryHint(
  error: ErrorView,
  now = Date.now(),
  authoritativeResetAt?: number
): UsageLimitRecoveryHint | null {
  const text = `${error.code}\n${error.message}`;
  if (EXCLUDED_FAILURE.test(text) || !LIMIT_FAILURE.test(text)) return null;
  const accountReset = authoritativeResetAt !== undefined
      && Number.isSafeInteger(authoritativeResetAt)
      && authoritativeResetAt > now
    ? authoritativeResetAt
    : undefined;
  return { resetAtMs: accountReset ?? resetAtFromText(text, now) ?? null };
}

export function stageUsageLimitScheduleIntent(
  sessionId: string,
  hint: UsageLimitRecoveryHint
): UsageLimitScheduleIntent {
  intentSequence += 1;
  pendingIntent = {
    requestId: `${sessionId}:${Date.now()}:${intentSequence}`,
    sessionId,
    resetAtMs: hint.resetAtMs
  };
  return pendingIntent;
}

export function consumeUsageLimitScheduleIntent(): UsageLimitScheduleIntent | undefined {
  const intent = pendingIntent;
  pendingIntent = undefined;
  return intent;
}

export function buildUsageLimitScheduleDraft(
  base: ScheduleDraft,
  intent: UsageLimitScheduleIntent,
  session: SessionView | undefined,
  labels: { readonly name: string; readonly prompt: string },
  now = Date.now()
): ScheduleDraft {
  const triggerAt = intent.resetAtMs === null ? undefined : intent.resetAtMs + 60_000;
  const scheduled = triggerAt !== undefined && Number.isFinite(triggerAt) && triggerAt > now;
  return {
    ...base,
    name: labels.name,
    backendId: session?.backendId ?? base.backendId,
    targetId: session?.targetId ?? base.targetId,
    sessionMode: session === undefined ? base.sessionMode : "bound",
    sessionId: session?.id ?? base.sessionId,
    kind: scheduled ? "once" : "manual",
    expression: scheduled ? scheduleLocalDateTimeFromEpoch(triggerAt, base.timezone) : "",
    inputText: labels.prompt,
    executionMode: "agent",
    providerId: session?.model?.providerId ?? base.providerId,
    modelId: session?.model?.modelId ?? base.modelId,
    effort: session?.effort ?? base.effort,
    fastMode: session?.fastMode ?? base.fastMode,
    permissionMode: session?.permissionMode ?? base.permissionMode,
    planMode: session?.planMode ?? base.planMode,
    useWorktree: false,
    worktreeSourceRef: undefined,
    refreshWorktreeRemote: false
  };
}

function resetAtFromText(text: string, now: number): number | undefined {
  const labeledEpoch = text.match(
    /(?:reset(?:s|[_ -]?at)?|retry[_ -]?after)\D{0,24}(\d{10,13})\b/iu
  )?.[1];
  if (labeledEpoch !== undefined) {
    const numeric = Number(labeledEpoch);
    const timestamp = numeric >= 100_000_000_000 ? numeric : numeric * 1_000;
    if (Number.isSafeInteger(timestamp) && timestamp > now) return timestamp;
  }
  for (const value of text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/gu) ?? []) {
    const timestamp = Date.parse(value);
    if (Number.isSafeInteger(timestamp) && timestamp > now) return timestamp;
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
  return delay > 0 && Number.isSafeInteger(now + delay) ? now + delay : undefined;
}
