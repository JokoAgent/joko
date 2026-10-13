import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, ModelDescriptorSchema, SnapshotSchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import type { ModelWorkingContextTarget } from "./model.js";

const target: ModelWorkingContextTarget = { backendId: "runtime-a", providerId: "provider", modelId: "model-a", relatedTargets: [{ backendId: "runtime-b", providerId: "provider", modelId: "different-model-b" }] };
const context = { target, revision: { value: 3n }, sourceRevision: "catalog-source", customized: false, mixed: true, canConfigure: true, defaultContextWindowTokens: 100_123n, effectiveContextWindowTokens: 100_123n };

describe("working context Gateway boundary", () => {
  it("preserves declared defaults and false, empty and unknown metadata independently of admission", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, { models: [create(ModelDescriptorSchema, { backendId: "a", key: { providerId: "provider", modelId: "model" }, available: true, supportsFastMode: true, inputModalities: [1], effortLevels: [{ effortId: "low", order: 0, defaultLevel: false }, { effortId: "high", order: 1, defaultLevel: true }], defaultEffort: "high", displayThinkingLevels: ["ultra"], description: "Source description", declaredSupportsImages: false, declaredSupportsFastMode: false, declaredModalities: { input: { values: [] }, output: { values: ["text"] } }, referenceApi: "openai-responses", api: "anthropic-messages", protocolMode: "compatibility", contextWindowSource: "estimated", maxOutputTokensSource: "declared" }), create(ModelDescriptorSchema, { backendId: "b", key: { providerId: "provider", modelId: "unknown" }, effortLevels: [{ effortId: "low", order: 0 }] })] }));
    expect(snapshot.models[0]?.metadata).toMatchObject({ defaultEffort: "high", imageInput: false, fastMode: false, inputModalities: [], outputModalities: ["text"], displayEfforts: ["ultra"], description: "Source description", referenceProtocol: "openai-responses", outboundProtocol: "anthropic-messages", protocolMode: "compatibility", contextWindowSource: "estimated", maxOutputTokensSource: "declared" });
    expect(snapshot.models[0]?.supportsFast).toBe(true);
    expect(snapshot.models[1]?.metadata).not.toHaveProperty("defaultEffort");
    expect(snapshot.models[1]?.metadata).not.toHaveProperty("imageInput");
    expect(snapshot.models[1]?.metadata).not.toHaveProperty("inputModalities");
  });

  it("sends one grouped exact-route CAS with operation identity, optional clear and native facts", async () => {
    const calls: { method: string; input: any }[] = [];
    const gateway = gatewayWith(transportFor((method, input) => { calls.push({ method, input }); return { context: { ...context, ...(method === "setModelWorkingContext" && input.contextWindowTokens !== undefined ? { limitTokens: input.contextWindowTokens, effectiveContextWindowTokens: input.contextWindowTokens } : {}), nativeContext: { contextWindowTokens: 120_000n, autoCompactLimitTokens: 90_000n, source: "native_configuration", pendingApply: true } } }; }));
    await gateway.connect();
    try {
      const observed = await gateway.getModelWorkingContext(target);
      expect(observed).toMatchObject({ defaultContextWindowTokens: 100_123, effectiveContextWindowTokens: 100_123, revision: 3n, sourceRevision: "catalog-source", mixed: true, nativeContext: { contextWindowTokens: 120_000, autoCompactLimitTokens: 90_000, source: "native_configuration", pendingApply: true } });
      expect(await gateway.setModelWorkingContext(target, observed, 150_000)).toMatchObject({ limitTokens: 150_000 });
      await gateway.setModelWorkingContext(target, observed, undefined);
      await gateway.resetModelWorkingContext(target, observed);
      const writes = calls.filter(call => call.method !== "getModelWorkingContext");
      expect(writes).toHaveLength(3);
      expect(writes[0]?.input).toMatchObject({ target: { backendId: "runtime-a", providerId: "provider", modelId: "model-a" }, relatedTargets: target.relatedTargets, expectedRevision: { value: 3n }, expectedSourceRevision: "catalog-source", contextWindowTokens: 150_000n, operationId: expect.any(String) });
      expect(writes[0]?.input.target).not.toHaveProperty("relatedTargets");
      expect(writes[1]?.input.contextWindowTokens).toBeUndefined();
      expect(new Set(writes.map(call => call.input.operationId)).size).toBe(3);
      await expect(gateway.setModelWorkingContext(target, observed, 150.5)).rejects.toThrow("Invalid working context budget");
      expect(calls).toHaveLength(4);
    } finally { gateway.disconnect(); }
  });

  it("rejects mismatched ownership and unproved native source instead of adopting a response", async () => {
    let wrong = true;
    const gateway = gatewayWith(transportFor(() => ({ context: wrong ? { ...context, target: { ...target, modelId: "other-model" } } : { ...context, nativeContext: { contextWindowTokens: 120_000n, source: "guessed", pendingApply: false } } })));
    await gateway.connect();
    try { await expect(gateway.getModelWorkingContext(target)).rejects.toThrow("ownership changed"); wrong = false; await expect(gateway.getModelWorkingContext(target)).rejects.toThrow("Invalid working context metadata"); } finally { gateway.disconnect(); }
  });

  it.each(["read cancellation", "write disconnect"] as const)("retires a late result after %s", async kind => {
    let finish!: () => void; let requestSignal: AbortSignal | undefined;
    const gateway = gatewayWith(transportFor(async (_method, _input, signal) => { requestSignal = signal; await new Promise<void>(resolve => { finish = resolve; }); return { context }; }));
    await gateway.connect();
    try {
      const abort = new AbortController();
      const pending = kind === "read cancellation" ? gateway.getModelWorkingContext(target, abort.signal) : gateway.setModelWorkingContext(target, { revision: 3n, sourceRevision: "catalog-source" }, 150_000);
      const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      if (kind === "read cancellation") abort.abort(); else gateway.disconnect();
      expect(requestSignal?.aborted).toBe(true); finish(); await assertion;
    } finally { gateway.disconnect(); }
  });
});

function transportFor(handler: (method: string, input: any, signal?: AbortSignal) => unknown | Promise<unknown>): Transport { return { unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => { const value = method.localName === "getSnapshot" ? create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) }) : method.parent.typeName === "joko.v1.BackendService" && method.localName.includes("ModelWorkingContext") ? create(method.output, await handler(method.localName, input, signal) as any) : (() => { throw new Error("Optional service unavailable"); })(); return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: value }; }), stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: idleStream() })) } as unknown as Transport; }
function gatewayWith(transport: Transport) { return createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "server", name: "Node", origin: "https://node.invalid" }, "test-key", {}, () => transport); }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
