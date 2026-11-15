import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "./protocol.js";
import { CodexEventTranslator, createTranslatorState } from "./translator.js";

const privateData = { message: "Authorization: Bearer sk-private-value C:\\private\\project /home/private/project 429 too many requests",
  additionalDetails: "private upstream response body", response: { token: "private-token", path: "/private/account" } };
const failures: readonly [string, JsonValue, string][] = [
  ["usage exhaustion", "usageLimitExceeded", "QUOTA_EXCEEDED"],
  ["session budget", "sessionBudgetExceeded", "SESSION_BUDGET_EXCEEDED"],
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
  ["billing connection", { responseStreamDisconnected: { httpStatusCode: 402 } }, "BILLING_ERROR"],
  ["temporary limit", { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, "RATE_LIMITED"],
  ["limited connection", { httpConnectionFailed: { httpStatusCode: 429 } }, "RATE_LIMITED"],
  ["overloaded stream", { responseStreamConnectionFailed: { httpStatusCode: 529 } }, "UPSTREAM_OVERLOADED"]
];

describe("native failure signals at the public event boundary", () => {
  it("ends only received items from the failed sample while the original native turn continues", () => {
    const translator = new CodexEventTranslator(), state = createTranslatorState("thread");
    state.activeTurnId = "turn";
    const options = { observeNativeReconnect: true };
    const delta = (itemId: string, text: string) => translator.translate("item/agentMessage/delta",
      { threadId: "thread", turnId: "turn", itemId, delta: text }, state, options);
    delta("native-item-A", "Received partial text.");
    const reconnect = { threadId: "thread", turnId: "turn", willRetry: true,
      error: { codexErrorInfo: { responseStreamDisconnected: {} }, message: "Reconnecting... 1/5 (private details)" } };
    expect(translator.translate("error", reconnect, state, options)).toMatchObject([
      { type: "status", key: "codex_sampling_interrupted:native-item-A" },
      { type: "retry", state: "waiting", attempt: 1, maxAttempts: 5 }
    ]);
    expect(state.activeTurnId).toBe("turn");
    expect(translator.translate("error", reconnect, state, options)).toEqual([]);
    expect(delta("native-item-B", "A separate reply.")).toMatchObject([
      { type: "retry", state: "succeeded" }, { type: "text_delta", blockId: "native-item-B" }
    ]);
    expect(translator.translate("item/completed", { threadId: "thread", turnId: "turn",
      item: { type: "agentMessage", id: "native-item-B", text: "A separate reply.", phase: null } }, state, options))
      .toMatchObject([{ type: "message_complete", nativeHistory: { identity: { entryId: "native-item-B" } } }]);
    const later = translator.translate("error", { threadId: "thread", turnId: "turn", willRetry: false,
      error: { codexErrorInfo: "responseTooManyFailedAttempts", message: "private details" } }, state, options);
    expect(later).toMatchObject([{ type: "error", terminal: false }]);
    expect(JSON.stringify(later)).not.toContain("private details");
    expect(state.samplingItems.size).toBe(0);
    expect(translator.translate("item/completed", { threadId: "thread", turnId: "turn",
      item: { type: "agentMessage", id: "native-item-A", text: "Authoritative full A.", phase: null } }, state, options))
      .toMatchObject([{ type: "message_complete", nativeHistory: { identity: { entryId: "native-item-A" } } }]);
  });

  it("requires structured sampling failure and the original accepted thread and turn", () => {
    const changes: readonly JsonObject[] = [{ threadId: "other" }, { turnId: "other" },
      { error: { codexErrorInfo: "other", message: "stream disconnected" } },
      { error: { codexErrorInfo: { responseStreamDisconnected: {}, other: {} }, message: "stream disconnected" } }];
    for (const change of changes) {
      const translator = new CodexEventTranslator(), state = createTranslatorState("thread");
      state.activeTurnId = "turn";
      translator.translate("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "A", delta: "Partial." },
        state, { observeNativeReconnect: true });
      const result = translator.translate("error", { threadId: "thread", turnId: "turn", willRetry: true,
        error: { codexErrorInfo: "responseStreamDisconnected", message: "private details" }, ...change }, state, { observeNativeReconnect: true });
      expect(result.some(event => event.type === "status")).toBe(false);
      expect(state.samplingItems.get("A")).toBe("turn");
    }
    const translator = new CodexEventTranslator(), state = createTranslatorState("thread");
    state.activeTurnId = "turn";
    translator.translate("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "A", delta: "Partial." }, state);
    expect(state.samplingItems.size).toBe(0);
    expect(translator.translate("error", { threadId: "thread", turnId: "turn",
      error: { codexErrorInfo: "responseStreamDisconnected" } }, state).some(event => event.type === "status")).toBe(false);
  });

  it("clears exact completed items and scopes a terminal sampling failure to its original turn", () => {
    const translator = new CodexEventTranslator(), state = createTranslatorState("thread"), options = { observeNativeReconnect: true };
    state.activeTurnId = "turn";
    for (const itemId of ["completed", "partial"]) translator.translate("item/agentMessage/delta",
      { threadId: "thread", turnId: "turn", itemId, delta: "Received." }, state, options);
    translator.translate("item/completed", { threadId: "other", turnId: "turn",
      item: { type: "agentMessage", id: "partial", text: "Unrelated.", phase: null } }, state, options);
    expect(state.samplingItems.get("partial")).toBe("turn");
    translator.translate("item/completed", { threadId: "thread", turnId: "turn",
      item: { type: "agentMessage", id: "completed", text: "Completed.", phase: null } }, state, options);
    const terminal = translator.translate("turn/completed", { threadId: "thread", turn: { id: "turn", status: "failed", items: [],
      error: { codexErrorInfo: { responseTooManyFailedAttempts: {} }, message: "private details" } } }, state, options);
    expect(terminal).toMatchObject([{ type: "status", key: "codex_sampling_interrupted:partial" },
      { type: "error", terminal: true }, { type: "done", outcome: "failed" }]);
    expect(state.samplingItems.size).toBe(0);
    const successful = createTranslatorState("thread"); successful.activeTurnId = "success";
    translator.translate("item/agentMessage/delta", { threadId: "thread", turnId: "success", itemId: "last", delta: "Received." }, successful, options);
    expect(translator.translate("turn/completed", { threadId: "thread", turn: { id: "success", status: "completed", items: [],
      error: { codexErrorInfo: "responseStreamDisconnected", message: "previous failure" } } }, successful, options))
      .toEqual([{ type: "done", outcome: "completed" }]);
    expect(successful.samplingItems.size).toBe(0);
  });

  it("reports bounded reconnect counts for the current turn without adding an error to the recovered output", () => {
    const translator = new CodexEventTranslator(), state = createTranslatorState("thread");
    state.activeTurnId = "turn";
    const reconnect = (attempt: number, turnId = "turn") => translator.translate("error", { threadId: "thread", turnId,
      willRetry: true, error: { codexErrorInfo: { responseStreamDisconnected: {} },
        message: `Reconnecting... ${attempt}/5 (private provider response)` } }, state, { observeNativeReconnect: true });
    expect(reconnect(1, "retired-turn")).toEqual([]);
    const notice = reconnect(1);
    expect(notice).toMatchObject([{ type: "retry", state: "waiting", attempt: 1, maxAttempts: 5,
      error: { code: "CODEX_NATIVE_RECONNECT" } }]);
    expect(JSON.stringify(notice)).not.toContain("private provider response");
    expect(reconnect(1)).toEqual([]);
    expect(reconnect(2)).toMatchObject([{ type: "retry", state: "waiting", attempt: 2, maxAttempts: 5 }]);
    expect(translator.translate("item/agentMessage/delta", { threadId: "thread", turnId: "turn", itemId: "reply", delta: "Recovered." }, state))
      .toMatchObject([{ type: "retry", state: "succeeded", attempt: 2, maxAttempts: 5 }, { type: "text_delta", delta: "Recovered." }]);
    expect(translator.translate("turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed", items: [] } }, state))
      .toEqual([{ type: "done", outcome: "completed" }]);
  });

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
