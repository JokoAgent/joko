import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "./protocol.js";
import { CodexEventTranslator, createTranslatorState } from "./translator.js";

const privateData = { message: "Authorization: Bearer sk-private-value C:\\private\\project /home/private/project 429 too many requests",
  additionalDetails: "private upstream response body", response: { token: "private-token", path: "/private/account" } };
const failures: readonly [string, JsonValue, string][] = [
  ["usage exhaustion", "usageLimitExceeded", "QUOTA_EXCEEDED"],
  ["session budget", "sessionBudgetExceeded", "QUOTA_EXCEEDED"],
  ["authentication", "unauthorized", "AUTH_REQUIRED"],
  ["upstream overload", "serverOverloaded", "UPSTREAM_OVERLOADED"],
  ["invalid request", "badRequest", "INVALID_REQUEST"],
  ["context limit", "contextWindowExceeded", "CONTEXT_OVERFLOW"],
  ["content policy", "cyberPolicy", "CONTENT_POLICY"],
  ["sandbox failure", "sandboxError", "SANDBOX_ERROR"],
  ["HTTP invalid request", { httpConnectionFailed: { httpStatusCode: 400 } }, "INVALID_REQUEST"],
  ["HTTP connection", { httpConnectionFailed: { httpStatusCode: null } }, "NETWORK_ERROR"],
  ["stream connection", { responseStreamConnectionFailed: { httpStatusCode: 503 } }, "NETWORK_ERROR"],
  ["stream disconnected", { responseStreamDisconnected: {} }, "NETWORK_ERROR"],
  ["unauthorized connection", { httpConnectionFailed: { httpStatusCode: 401 } }, "AUTH_REQUIRED"],
  ["forbidden stream", { responseStreamConnectionFailed: { httpStatusCode: 403 } }, "AUTH_REQUIRED"],
  ["billing connection", { responseStreamDisconnected: { httpStatusCode: 402 } }, "QUOTA_EXCEEDED"],
  ["temporary limit", { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, "RATE_LIMITED"],
  ["limited connection", { httpConnectionFailed: { httpStatusCode: 429 } }, "RATE_LIMITED"],
  ["overloaded stream", { responseStreamConnectionFailed: { httpStatusCode: 529 } }, "UPSTREAM_OVERLOADED"]
];

describe("native failure signals at the public event boundary", () => {
  it.each(failures)("keeps %s distinct in terminal and nonterminal events without publishing the native error", (_name, codexErrorInfo, code) => {
    const translator = new CodexEventTranslator(), native: JsonObject = { ...privateData, codexErrorInfo };
    const state = createTranslatorState("thread"); state.activeTurnId = "turn";
    const notice = translator.translate("error", { threadId: "thread", turnId: "turn", error: native, willRetry: true }, state);
    expect(notice).toMatchObject([{ type: "error", terminal: false, error: { code, phase: "stream", stateMayHaveChanged: true } }]);
    expect(state.activeTurnId).toBe("turn");
    const terminal = { threadId: "thread", turn: { id: "turn", status: "failed", items: [], error: native } };
    const completed = translator.translate("turn/completed", terminal, state);
    expect(completed).toEqual([{ type: "error", terminal: true, error: notice[0]?.type === "error" ? notice[0].error : undefined }, { type: "done", outcome: "failed" }]);
    expect(translator.translate("turn/completed", terminal, state)).toEqual([]);
    expect(state.activeTurnId).toBeUndefined();
    const serialized = JSON.stringify([notice, completed]);
    for (const text of ["sk-private-value", "private upstream", "private-token", "private/account", "private/project", "codexErrorInfo", "httpStatusCode"])
      expect(serialized).not.toContain(text);
    if (code !== "RATE_LIMITED") expect(notice[0]?.type === "error" && notice[0].error.code).not.toBe("RATE_LIMITED");
  });

  it.each<JsonValue>(["private usage diagnostic", { unauthorized: {}, usageLimitExceeded: {} }, { privateDiagnostic: { httpStatusCode: 401 } },
    { httpConnectionFailed: { httpStatusCode: "429" } }, ["usageLimitExceeded"], null])("rejects unknown or malformed structured detail %j without parsing private message text", codexErrorInfo => {
    const result = new CodexEventTranslator().translate("error", { error: { ...privateData, codexErrorInfo } }, createTranslatorState());
    const code = result[0]?.type === "error" ? result[0].error.code : undefined;
    expect(code).toBe(typeof codexErrorInfo === "object" && codexErrorInfo !== null && !Array.isArray(codexErrorInfo) && "httpConnectionFailed" in codexErrorInfo ? "NETWORK_ERROR" : "CODEX_TURN_FAILED");
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
