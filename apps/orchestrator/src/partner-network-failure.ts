import { isPartnerNetworkFailureCode, type PartnerNetworkFailureCode } from "@joko/contracts";

/** Executor-local classification. Raw messages and provider diagnostics never
 * leave this function; only a fixed public category may enter room state. */
export function partnerNetworkRuntimeFailureCode(error: unknown): PartnerNetworkFailureCode {
  const outer = record(error), data = record(outer?.["publicError"]) ?? outer;
  const values = [data?.["code"], data?.["reason"], data?.["sdkError"], data?.["message"], error instanceof Error ? error.message : error];
  for (const value of values) {
    if (typeof value === "string" && (value === "PI_IMAGE_INPUT_UNSUPPORTED" || value.includes("[PI_IMAGE_INPUT_UNSUPPORTED]"))) return "IMAGE_INPUT_UNSUPPORTED";
    if (isPartnerNetworkFailureCode(value)) return value;
  }
  const tag = data?.["codexErrorInfo"];
  if (tag === "usageLimitExceeded" || tag === "sessionBudgetExceeded") return "QUOTA_EXCEEDED";
  if (tag === "unauthorized") return "AUTH_REQUIRED";
  const reason = data?.["reason"];
  if (reason === "pi-prompt-timeout" || ["BACKEND_RUN_SILENCE_TIMEOUT", "PI_PROMPT_ACCEPTANCE_TIMEOUT"].includes(String(data?.["code"]))
    || typeof reason === "string" && /^(?:bridge_)?(?:turn_no_event_timeout|upstream_response_idle_timeout)$/u.test(reason)
    || values.some(value => typeof value === "string" && /pi rpc timeout after \d+ms: prompt\b/iu.test(value))) return "RUNTIME_TIMEOUT";
  const text = values.filter((value): value is string => typeof value === "string").join("\n");
  const status = typeof data?.["errorStatus"] === "number" ? data["errorStatus"] : publicStatus(text);
  if (data?.["modelAccessDenied"] === true || values.includes("model-unavailable")
    || /\b(?:NO_MODEL|MODEL_NOT_FOUND|MODEL_UNAVAILABLE|NO_AVAILABLE_MODEL|BOT_MODEL_REQUIRED|MODEL_REQUIRED|user_model_access_denied)\b/iu.test(text)) return "MODEL_UNAVAILABLE";
  if (status === 401 || status === 403 || /\b(?:AUTH_REQUIRED|INVALID_TOKEN|TOKEN_EXPIRED|UNAUTHORIZED|invalid_api_key|authentication_error|authentication_failed|provider_auth_or_access)\b|(?:^|_)AUTH_REQUIRED\b/imu.test(text)) return "AUTH_REQUIRED";
  if (reason === "upstream-overload" || data?.["code"] === "UPSTREAM_OVERLOAD" || tag === "serverOverloaded" || status === 529
    || /\bat capacity\b|\boverloaded_error\b|\b529\b/iu.test(text)) return "UPSTREAM_OVERLOADED";
  if (status === 402 || exhaustion.some(pattern => pattern.test(text))
    || /\b(?:QUOTA_EXCEEDED|USAGE_LIMIT_EXCEEDED|INSUFFICIENT_BALANCE|insufficient_quota|billing_error|provider_quota_limit|usageLimitExceeded|sessionBudgetExceeded)\b/iu.test(text)) return "QUOTA_EXCEEDED";
  if (/\b(?:RATE_LIMITED|RATE_LIMIT_EXCEEDED|rate_limit_error|rate_limit|provider_rate_limit)\b|(?:^|_)RATE_LIMITED\b|rate limit(?:ed|ing)?|too many requests/imu.test(text)) return "RATE_LIMITED";
  if (data?.["usageLimit"] === true) return "QUOTA_EXCEEDED";
  if (status === 429) return "RATE_LIMITED";
  if (["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"].includes(String(tag))) return "NETWORK_ERROR";
  if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|REQUEST_TIMEOUT)\b|fetch failed|socket hang up/iu.test(text)) return "NETWORK_ERROR";
  return "RUNTIME_ERROR";
}
const exhaustion = [/\binsufficient[-_ ]?quota\b/iu, /\binsufficient.{0,12}\b(?:balance|credit|funds)\b/iu,
  /\bquota\b.{0,24}\b(?:exhausted|exceeded)\b/iu, /\b(?:exhausted|exceeded)\b.{0,24}\bquota\b/iu, /\busage\s+limit\b/iu,
  /\b(?:exceeded[-_]?budget|budget[-_]?exceeded)\b/iu, /\b(?:account|session|usage)\s+budget\b.{0,16}\b(?:exhausted|exceeded)\b/iu,
  /\b(?:exhausted|exceeded)\b.{0,16}\b(?:account|session|usage)\s+budget\b/iu, /\bspend(?:ing)?[-_ ]?cap\b/iu, /余额不足|欠费/u];
function publicStatus(text: string): number | undefined {
  const match = /(?:^|[\s,{;])["']?(?:status(?:[-_ ]?code)?|http(?:[-_ ]?status)?|code)["']?\s*(?:[:=]\s*)?["']?(401|429|529)["']?(?=$|[\s,;:}\]])/iu.exec(text)
    ?? /\brequest\s+rejected\s*\(\s*(401|429|529)\s*\)/iu.exec(text);
  return match ? Number(match[1]) : undefined;
}
function record(value: unknown): Readonly<Record<string, unknown>> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
