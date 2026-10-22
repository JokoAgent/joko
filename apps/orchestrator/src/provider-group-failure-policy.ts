export interface ProviderGroupFailureSignals {
  readonly message?: string; readonly code?: string; readonly reason?: string; readonly sdkError?: string;
  readonly errorStatus?: number; readonly usageLimit?: boolean; readonly codexErrorInfo?: string;
  readonly toolLoop?: boolean; readonly usageResetAt?: number; readonly stateMayHaveChanged?: boolean;
  readonly modelScoped?: boolean;
}
export type ProviderGroupFailurePhase = "start" | "run" | "target";
export type ProviderGroupFailureCause = "usage-limit" | "auth" | "overload" | "unavailable" | "failed";
export type ProviderGroupFailureDecision = { readonly action: "stay"; readonly why: string }
  | { readonly action: "switch"; readonly cause: ProviderGroupFailureCause; readonly connection: "lost" | "check" | null; readonly cool: boolean };
export const PROVIDER_GROUP_SUPERSEDED_ERROR = "Provider group was superseded by user action.";
export class ProviderGroupUnavailableError extends Error {
  readonly code = "PROVIDER_GROUP_UNAVAILABLE";
  constructor() { super("No computer in this Provider group can run the task right now."); this.name = "ProviderGroupUnavailableError"; }
}
const TASK_STATE = new Set(["SESSION_RUNNING", "NOT_FOUND", "INVALID_PARAMS", "INVALID_ARGUMENT", "UNSUPPORTED_CAPABILITY", "PRECONDITION_FAILED",
  "FAILED_PRECONDITION", "SEND_CANCELLED_BEFORE_DISPATCH", "OWNER_CHANGED", "ACCOUNT_BOUNDARY", "WORKDIR_MISSING", "TARGET_CHANGED"]);
const LOST = new Set(["HOSTED_AGENT_DEVICE_UNREACHABLE", "HOSTED_AGENT_EXPIRED", "HOSTED_AGENT_NOT_FOUND", "HOSTED_SOURCE_DISCONNECTED"]);
const CHECK = new Set(["HOSTED_AGENT_UNAVAILABLE", "HOSTED_AGENT_SHARE_UNAVAILABLE", "HOSTED_AGENT_BUSY", "DEVICE_LINK_DEVICE_OFFLINE", "DEVICE_OFFLINE",
  "NOT_CONNECTED", "PEER_RESET", "LINK_CLOSED", "LINK_NOT_OPEN", "TIMEOUT", "INVOKE_TIMEOUT", "UNAVAILABLE"]);
const UNAVAILABLE = new Set(["HOSTED_AGENT_PROVIDER_NOT_ALLOWED", "HOSTED_AGENT_RESHARE_NOT_ALLOWED", "HOSTED_AGENT_MODEL_UNAVAILABLE", "HOSTED_AGENT_SHARE_PAUSED",
  "HOSTED_AGENT_SHARE_REMOVED", "HOSTED_AGENT_ACCOUNT_CHANGED", "HOSTED_AGENT_PEER_TOO_OLD", "HOSTED_AGENT_UNSUPPORTED", "ACCESS_REVOKED", "REMOTE_DISABLED", "CHANNEL_NOT_ALLOWED"]);
const STAY = new Map([
  ["context-overflow", "context"], ["context_overflow", "context"], ["codex_history_oversized", "context"], ["output-limit", "context"],
  ["tool_use_loop_detected", "tool-loop"], ["user-denied", "user"], ["user_rejected", "user"], ["user-revoked", "user"], ["cancelled-before-dispatch", "user"],
  ["turn_continuation_cancelled", "user"], ["permission-tighten-interrupt-failed", "local"], ["approved-skill-snapshot-failed", "local"],
  ["approved-repo-root-changed", "local"], ["approval-working-dir-mismatch", "local"], ["approval-resolver-unavailable", "local"], ["runtime-skills-missing", "local"]
]);
const CODEX_STAY = new Map([["contextWindowExceeded", "context"], ["badRequest", "invalid-request"], ["cyberPolicy", "policy"], ["sandboxError", "local"]]);
/** All group entry points use this policy after the native same-member retry.
 * Classification never publishes the raw error text, which can contain input. */
export function decideProviderGroupFailure(signals: ProviderGroupFailureSignals | null | undefined, phase: ProviderGroupFailurePhase): ProviderGroupFailureDecision {
  if (!signals || !signals.message && !signals.code && !signals.reason && !signals.sdkError && signals.errorStatus === undefined && !signals.usageLimit && !signals.codexErrorInfo) return stay("no-signal");
  const message = signals.message ?? "", reason = signals.reason ?? "", code = errorCode(signals);
  if (message === PROVIDER_GROUP_SUPERSEDED_ERROR) return stay("user");
  // An uncertain native effect must be inspected; switching must never replay it.
  if (phase !== "run" && signals.stateMayHaveChanged || code === "DISPATCH_UNKNOWN" || code === "NATIVE_DISPATCH_UNKNOWN" || code === "RUNTIME_HANDOFF_UNKNOWN") return stay("unknown-effect");
  if (code === "PROVIDER_GROUP_UNAVAILABLE") return stay("group-unavailable");
  if (code === "SESSION_CLOSED_MID_TURN" || code === "HOSTED_AGENT_LOCAL_ADMISSION") return stay("local");
  if (phase !== "run" && code && TASK_STATE.has(code)) return stay("task-state");
  const known = STAY.get(reason) ?? CODEX_STAY.get(signals.codexErrorInfo ?? ""); if (known) return stay(known);
  if (signals.sdkError === "max_output_tokens" || code === "CONTEXT_OVERFLOW" || code === "OUTPUT_LIMIT"
    || /context.{0,20}(?:length|window|limit|overflow|too long)|maximum context|prompt is too long|history.{0,20}(?:too large|oversized)/iu.test(message)) return stay("context");
  if (signals.toolLoop) return stay("tool-loop");
  if (/\b(?:permission denied by (?:the )?user|user (?:denied|rejected|declined) (?:the )?(?:permission|request|tool))\b/iu.test(message)
    || ["USER_CANCELLED", "PERMISSION_DENIED_BY_USER", "CANCELED", "CANCELLED"].includes(code ?? "")) return stay("user");
  if (/\btool (?:execution|call) failed\b|\bworking directory is missing\b/iu.test(message)) return stay("local");
  if (signals.codexErrorInfo === "serverOverloaded" || signals.errorStatus === 529 || /\bat capacity\b|\boverloaded_error\b/iu.test(message)) return change("overload");
  if (signals.usageLimit || signals.sdkError === "rate_limit" || signals.sdkError === "billing_error" || signals.codexErrorInfo === "usageLimitExceeded"
    || signals.errorStatus === 429 || /rate.?limit|usage.?limit|quota|too\s*many\s*requests|insufficient[_ ](?:credit|balance)|billing.{0,20}(?:exhaust|deplet)/iu.test(message)) return change("usage-limit");
  if (signals.sdkError === "authentication_failed" || signals.codexErrorInfo === "unauthorized" || signals.errorStatus === 401
    || /\b(?:authentication[_ ](?:failed|error)|invalid[_ -]?(?:x-)?api[_ -]?key|unauthorized|not (?:logged in|authenticated)|login (?:has )?expired|oauth token (?:has )?expired|token (?:has been )?revoked)\b/iu.test(message)) return change("auth");
  if (signals.sdkError === "invalid_request" || [400, 413, 422].includes(signals.errorStatus ?? 0)) return stay("invalid-request");
  if (["CONTENT_POLICY", "CONTENT_FILTER", "POLICY_VIOLATION"].includes(code ?? "")) return stay("policy");
  if (code && LOST.has(code) || reason === "hosted_agent_lost") return change("unavailable", "lost");
  if (code && UNAVAILABLE.has(code)) return change("unavailable");
  if (code && CHECK.has(code) || reason === "hosted_agent_closed") return change("unavailable", "check");
  return change("failed");
}
export function providerGroupFailureSignals(error: unknown): ProviderGroupFailureSignals {
  if (typeof error === "string") return { message: error };
  if (!error || typeof error !== "object") return {};
  const value = error as Record<string, unknown>;
  if (value["publicError"] && typeof value["publicError"] === "object") return providerGroupFailureSignals(value["publicError"]);
  const result: Record<string, unknown> = {};
  for (const key of ["message", "code", "reason", "sdkError", "codexErrorInfo"]) if (typeof value[key] === "string") result[key] = value[key];
  for (const key of ["errorStatus", "usageResetAt"]) if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = value[key];
  for (const key of ["usageLimit", "toolLoop", "stateMayHaveChanged", "modelScoped"]) if (typeof value[key] === "boolean") result[key] = value[key];
  return result as ProviderGroupFailureSignals;
}
export function describeProviderGroupFailure(signals: ProviderGroupFailureSignals, decision: ProviderGroupFailureDecision): Readonly<Record<string, string | number | boolean | null>> {
  return { ...decision, ...(errorCode(signals) ? { code: errorCode(signals)! } : {}), ...(signals.errorStatus === undefined ? {} : { status: signals.errorStatus }) };
}
function errorCode(signals: ProviderGroupFailureSignals): string | undefined { return signals.code ?? /\[([A-Z][A-Z0-9_]+)\]/u.exec(signals.message ?? "")?.[1]; }
function stay(why: string): ProviderGroupFailureDecision { return { action: "stay", why }; }
function change(cause: ProviderGroupFailureCause, connection: "lost" | "check" | null = null): ProviderGroupFailureDecision {
  return { action: "switch", cause, connection, cool: cause === "usage-limit" || cause === "auth" || cause === "overload" };
}
