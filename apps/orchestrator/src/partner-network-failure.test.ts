import { expect, it } from "vitest";
import { PARTNER_NETWORK_FAILURE_CODES, isPartnerNetworkFailureCode, partnerNetworkFailureMessage } from "@joko/contracts";
import { partnerNetworkRuntimeFailureCode as classify } from "./partner-network-failure.js";

it.each([
  [{ code: "PI_IMAGE_INPUT_UNSUPPORTED" }, "IMAGE_INPUT_UNSUPPORTED"], [new Error("[PI_IMAGE_INPUT_UNSUPPORTED] private model"), "IMAGE_INPUT_UNSUPPORTED"],
  [{ code: "NO_MODEL" }, "MODEL_UNAVAILABLE"], [{ modelAccessDenied: true, errorStatus: 403 }, "MODEL_UNAVAILABLE"], [new Error("model-unavailable"), "MODEL_UNAVAILABLE"],
  [{ sdkError: "model_not_found" }, "MODEL_UNAVAILABLE"], [{ errorStatus: 401 }, "AUTH_REQUIRED"], [{ errorStatus: 403 }, "AUTH_REQUIRED"],
  [{ sdkError: "authentication_failed" }, "AUTH_REQUIRED"], [{ reason: "provider_auth_or_access" }, "AUTH_REQUIRED"], [{ code: "INVALID_TOKEN" }, "AUTH_REQUIRED"],
  [{ sdkError: "rate_limit", usageLimit: true, errorStatus: 429 }, "RATE_LIMITED"], [{ reason: "provider_rate_limit", usageLimit: true }, "RATE_LIMITED"],
  [{ errorStatus: 429 }, "RATE_LIMITED"], [{ message: "Too many requests", usageLimit: true }, "RATE_LIMITED"], [{ usageLimit: true, errorStatus: 429 }, "QUOTA_EXCEEDED"],
  [{ sdkError: "billing_error" }, "QUOTA_EXCEEDED"], [{ errorStatus: 402 }, "QUOTA_EXCEEDED"], [{ reason: "provider_quota_limit" }, "QUOTA_EXCEEDED"],
  [new Error("Request rejected (429): ExceededBudget private account"), "QUOTA_EXCEEDED"], [new Error("quota exhausted"), "QUOTA_EXCEEDED"],
  [{ sdkError: "rate_limit", message: "ExceededBudget", usageLimit: true, errorStatus: 429 }, "QUOTA_EXCEEDED"],
  [{ codexErrorInfo: "usageLimitExceeded", errorStatus: 401, sdkError: "rate_limit" }, "QUOTA_EXCEEDED"],
  [{ codexErrorInfo: "sessionBudgetExceeded" }, "QUOTA_EXCEEDED"], [{ codexErrorInfo: "unauthorized", sdkError: "billing_error" }, "AUTH_REQUIRED"],
  [{ codexErrorInfo: "httpConnectionFailed", errorStatus: 401 }, "AUTH_REQUIRED"], [{ codexErrorInfo: "serverOverloaded" }, "UPSTREAM_OVERLOADED"],
  [{ reason: "upstream-overload" }, "UPSTREAM_OVERLOADED"], [{ errorStatus: 529 }, "UPSTREAM_OVERLOADED"], [new Error("Selected model is at capacity."), "UPSTREAM_OVERLOADED"],
  [new Error("overloaded_error"), "UPSTREAM_OVERLOADED"], [new Error("The private queue is overloaded"), "RUNTIME_ERROR"],
  [{ codexErrorInfo: "httpConnectionFailed" }, "NETWORK_ERROR"], [{ codexErrorInfo: "responseStreamConnectionFailed" }, "NETWORK_ERROR"],
  [{ codexErrorInfo: "responseStreamDisconnected" }, "NETWORK_ERROR"], [new Error("ECONNRESET private endpoint"), "NETWORK_ERROR"],
  [{ reason: "turn_no_event_timeout" }, "RUNTIME_TIMEOUT"], [{ reason: "bridge_turn_no_event_timeout" }, "RUNTIME_TIMEOUT"],
  [{ reason: "upstream_response_idle_timeout" }, "RUNTIME_TIMEOUT"], [{ reason: "bridge_upstream_response_idle_timeout" }, "RUNTIME_TIMEOUT"],
  [{ reason: "pi-prompt-timeout" }, "RUNTIME_TIMEOUT"], [{ sdkError: "pi rpc timeout after 30000ms: prompt" }, "RUNTIME_TIMEOUT"],
  [{ code: "BACKEND_RUN_SILENCE_TIMEOUT" }, "RUNTIME_TIMEOUT"], [{ code: "PI_PROMPT_ACCEPTANCE_TIMEOUT" }, "RUNTIME_TIMEOUT"],
  [new Error("pi rpc timeout after 30000ms: set_model"), "RUNTIME_ERROR"], [new Error("Authorization: Bearer tok-401-x; upstream 500"), "RUNTIME_ERROR"],
  [new Error("PRIVATE_PROMPT D:\\private\\project access_token=secret"), "RUNTIME_ERROR"]
] as const)("classifies only the applicable public category for %j", (error, code) => { expect(classify(error)).toBe(code); });

it("preserves safe native codes and localizes every category with a recovery action without accepting arbitrary failure text", () => {
  for (const code of PARTNER_NETWORK_FAILURE_CODES) {
    expect(classify({ publicError: { code, message: "PRIVATE_PATH /home/private" } })).toBe(code);
    expect(isPartnerNetworkFailureCode(code)).toBe(true);
    expect(partnerNetworkFailureMessage(code, "zh-CN")).toContain("请"); expect(partnerNetworkFailureMessage(code, "en")).not.toBe("");
  }
  expect(isPartnerNetworkFailureCode("PRIVATE_PROMPT")).toBe(false); expect(partnerNetworkFailureMessage("PRIVATE_PROMPT", "en")).toBe(partnerNetworkFailureMessage("RUNTIME_ERROR", "en"));
});
