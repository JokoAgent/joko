import type { PartnerLearningTurnHandle, PartnerLearningTurnSource } from "@joko/core";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { MANAGED_BRIDGE_SOURCE } from "./bridge.js";
import { capturePartnerLearningExtensionRequest, PARTNER_LEARNING_REQUEST_PREFIX, PARTNER_LEARNING_REPLY_STATUS_KEY } from "./partner-learning-bridge.js";

describe("private Pi tool turn bridge", () => {
  it("waits for the original-turn acknowledgement before executing the generated MCP fetch", async () => {
    let acknowledge!: (value: string) => void;
    const acknowledgement = new Promise<string>((resolve) => { acknowledge = resolve; });
    const input = vi.fn((_title: string, _placeholder: string) => acknowledgement), fetch = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
    const tools: Array<{ execute(id: string, args: unknown, signal: AbortSignal, update: unknown, ctx: unknown): Promise<unknown> }> = [];
    const hooks = new Map<string, (event: unknown, context: unknown) => void>();
    installGeneratedMcpBridge({ registerTool: (tool) => { tools.push(tool); }, on: (name, callback) => { hooks.set(name, callback); } }, fetch);
    const running = tools[0]!.execute("original-call", { value: "bounded" }, new AbortController().signal, undefined, { hasUI: true, ui: { input } });
    expect(fetch).not.toHaveBeenCalled();
    expect(input).toHaveBeenCalledWith(expect.stringMatching(/^joko:tool-turn\/v1\//u), "");
    const descriptor = JSON.parse(Buffer.from(input.mock.calls[0]![0].slice(PARTNER_LEARNING_REQUEST_PREFIX.length), "base64url").toString("utf8"));
    expect(descriptor).toEqual({ requestId: "original-call", serverId: "memory", toolName: "save" });
    acknowledge("p".repeat(43));
    await expect(running).resolves.toMatchObject({ content: [{ type: "text", text: "saved" }] });
    const body = JSON.parse((fetch.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ requestId: "original-call", partnerLearningProof: "p".repeat(43) });
    expect(body).not.toHaveProperty("source");
    const failed = tools[0]!.execute("cancelled-call", {}, new AbortController().signal, undefined,
      { hasUI: true, ui: { input: async () => undefined } });
    await expect(failed).rejects.toThrow("not acknowledged");
    expect(fetch).toHaveBeenCalledOnce();

    const originalMessage = { role: "assistant" }, sameBodyDifferentObject = { role: "assistant" };
    const status = vi.fn();
    hooks.get("turn_end")!({ message: originalMessage }, { mode: "rpc", sessionManager: { getBranch: () => [
      { type: "message", id: "original-entry", message: originalMessage },
      { type: "message", id: "newer-entry", message: sameBodyDifferentObject }
    ] }, ui: { setStatus: status } });
    expect(status).toHaveBeenCalledWith(PARTNER_LEARNING_REPLY_STATUS_KEY, JSON.stringify({ entryId: "original-entry" }));
  });

  it("requires an exact frozen native catalog request and rejects stale private capture", () => {
    const source: PartnerLearningTurnSource = { occurrenceId: "original", sessionId: "session", targetId: "target", backendId: "pi",
      backendInstanceGeneration: 1, bindingGeneration: 1, bindingFingerprint: "binding", sourceRunId: "run", sourceAttemptId: "attempt",
      sourceQueueItemId: "queue", nativeOccurrence: "native-original" };
    let current = true;
    const capture = vi.fn((request: { readonly requestId: string; readonly serverId: string; readonly toolName: string }) => {
      if (!current) throw new Error("retired");
      return { source, ...request, proof: "p".repeat(43), assertCurrent: () => undefined };
    });
    const turn: PartnerLearningTurnHandle = { source, emit: async () => undefined, observeNativeReply: () => undefined, captureToolRequest: capture };
    const request = (value: unknown) => ({ id: "ack", method: "input", title: PARTNER_LEARNING_REQUEST_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url") });
    const tools = [{ serverId: "memory", name: "save" }];
    const body = { requestId: "original-call", serverId: "memory", toolName: "save" };
    expect(capturePartnerLearningExtensionRequest(request(body), turn, tools)).toEqual({ id: "ack", value: "p".repeat(43) });
    expect(capturePartnerLearningExtensionRequest(request({ ...body, source }), turn, tools)).toEqual({ id: "ack", cancelled: true });
    expect(capturePartnerLearningExtensionRequest(request({ ...body, toolName: "foreign" }), turn, tools)).toEqual({ id: "ack", cancelled: true });
    expect(capture).toHaveBeenCalledOnce();
    current = false;
    expect(capturePartnerLearningExtensionRequest(request(body), turn, tools)).toEqual({ id: "ack", cancelled: true });
    expect(capturePartnerLearningExtensionRequest(request(body), undefined, tools)).toEqual({ id: "ack", value: "untracked" });
  });
});

function installGeneratedMcpBridge(
  pi: { registerTool(tool: { execute(id: string, args: unknown, signal: AbortSignal, update: unknown, ctx: unknown): Promise<unknown> }): void; on(name: string, callback: (event: unknown, context: unknown) => void): void },
  fetch: (...args: unknown[]) => Promise<unknown>
): void {
  const start = MANAGED_BRIDGE_SOURCE.indexOf("  if (mcp) {"), end = MANAGED_BRIDGE_SOURCE.indexOf("  // Pi exposes the authoritative tool registry", start);
  const code = ts.transpileModule(MANAGED_BRIDGE_SOURCE.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const install = new Function("pi", "mcp", "mcpToken", "runtimeGeneration", "fetch", "readBoundedJson", "PARTNER_LEARNING_REQUEST_PREFIX", "PARTNER_LEARNING_REPLY_STATUS_KEY", code);
  install(pi, { endpoint: "http://127.0.0.1:4318/internal/mcp", sessionId: "session", targetId: "target", tools: [{ serverId: "memory", name: "save", description: "Save", inputSchema: {} }] },
    "fixture-private-token", 1, fetch, async () => ({ content: [{ type: "text", text: "saved" }] }), PARTNER_LEARNING_REQUEST_PREFIX, PARTNER_LEARNING_REPLY_STATUS_KEY);
}
