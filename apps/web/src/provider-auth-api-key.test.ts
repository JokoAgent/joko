import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetSnapshotResponseSchema, OperationState, ProviderLoginMethod, SnapshotSchema, SubmitOperationResponseSchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  defaultProviderLoginMethod,
  providerLoginMethods
} from "./components/ProviderLoginDialog.js";
import { providerConfigurationEditable } from "./components/SettingsPage.js";
import { createOrchestratorGateway, protoProviderLoginMethod, providerLoginMethod } from "./gateway.js";
import type { ProviderConfigurationView, ProviderDraft } from "./model.js";

describe("Provider settings", () => {
  it("routes an API-key Provider through its native login flow", () => {
    expect(providerLoginMethods("apiKey")).toEqual(["apiKey"]);
    expect(defaultProviderLoginMethod("apiKey")).toBe("apiKey");
    expect(protoProviderLoginMethod("apiKey")).toBe(ProviderLoginMethod.API_KEY);
    expect(providerLoginMethod(ProviderLoginMethod.API_KEY)).toBe("apiKey");
  });

  it("does not offer the managed endpoint editor for a native catalog descriptor", () => {
    expect(providerConfigurationEditable({ runtimes: [{ models: [] }] } as unknown as ProviderConfigurationView)).toBe(false);
    expect(providerConfigurationEditable({ runtimes: [{ models: [{ modelId: "managed-model" }] }] } as unknown as ProviderConfigurationView)).toBe(true);
  });

  it.each([
    ["http://[::1]:11434/v1/", "http://[::1]:11434/v1"],
    ["http://[0:0:0:0:0:0:0:1]:11434/v1/#settings", "http://[::1]:11434/v1"],
    ["http://127.0.0.1:11434/v1/", "http://127.0.0.1:11434/v1"],
    ["https://provider.example/v1/", "https://provider.example/v1"],
    ["http://remote.example/v1", undefined],
    ["http://user:password@[::1]:11434/v1", undefined],
    ["http://[::1]:11434/v1?api_key=test-only", undefined]
  ] as const)("validates the configured endpoint before submitting %s", async (endpoint, expected) => {
    const payloads: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        let message;
        if (method.localName === "getSnapshot") {
          message = create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) });
        } else if (method.localName === "submitOperation") {
          payloads.push(input.mutation.payload);
          message = create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } });
        } else throw new Error(`Unexpected method: ${method.localName}`);
        return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
      }),
      stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: (async function* () { await new Promise<void>(() => undefined); })() }))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "provider-endpoint", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "test-auth", {}, () => transport
    );
    await gateway.connect();
    const draft: ProviderDraft = {
      id: "local-models", name: "Local models", kind: "localKeyless", enabled: true, revision: 0n,
      runtimes: [{ backendId: "local-backend", compatibility: "openaiCompletions", endpoint,
      credentialId: "", credentialOrigin: "", keyless: true, authHeader: false, environmentName: "", headers: [],
      models: [{ modelId: "model", name: "Model", reasoning: false, inputModalities: ["text"], contextWindowTokens: 4096, maximumOutputTokens: 512,
        inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, cacheReadCostMicrosPerMillion: 0, cacheWriteCostMicrosPerMillion: 0, thinkingLevels: [], supportsFastMode: false }] }]
    };
    try {
      if (expected === undefined) {
        await expect(gateway.saveProvider(draft)).rejects.toThrow(/provider endpoint/iu);
        expect(payloads).toHaveLength(0);
      } else {
        await gateway.saveProvider(draft);
        expect(payloads).toMatchObject([{ case: "upsertProvider", value: { provider: { runtimes: [{ backendId: "local-backend", endpoint: expected }] } } }]);
      }
    } finally { gateway.disconnect(); }
  });
});
