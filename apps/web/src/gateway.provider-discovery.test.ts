import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema, GitSafetyMode, ModelInputModality, OperationState, ProviderApiCompatibility,
  ProviderKind, ProviderModelInheritedField, SnapshotSchema, SubmitOperationRequestSchema, SubmitOperationResponseSchema, type SubmitOperationRequest
} from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import { updateProviderModelMetadata } from "./provider-runtime-draft.js";

it("round-trips inherited discovery fields through the real Gateway and submits only the edited override", async () => {
  const inheritedFields = [ProviderModelInheritedField.DISPLAY_NAME, ProviderModelInheritedField.CONTEXT_WINDOW,
    ProviderModelInheritedField.MAXIMUM_OUTPUT, ProviderModelInheritedField.INPUT_MODALITIES];
  const snapshot = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n },
    settings: { auxiliaryText: { revision: { value: 0n }, runtimeRevision: "fixture:0" }, agentResource: {}, collaboration: {},
      gitSafety: { mode: GitSafetyMode.EXISTING_GIT }, modelFavorites: { revision: { value: 0n } },
      providers: [{ providerId: "local", displayName: "Local", kind: ProviderKind.LOCAL_KEYLESS, enabled: true, version: { revision: { value: 5n } },
        runtimes: [{ backendId: "pi", endpoint: "http://127.0.0.1:11434/v1", apiCompatibility: ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS,
          keyless: true, models: [{ modelId: "same", displayName: "Discovered", contextWindowTokens: 128_000n, contextWindowMaxTokens: 1_000_000n,
            maximumOutputTokens: 8_000n, inputModalities: [ModelInputModality.TEXT], inheritedFields }] }] }] } });
  const view = mapSnapshot(fromBinary(SnapshotSchema, toBinary(SnapshotSchema, snapshot)));
  const provider = view.settings.providers[0]!;
  expect(provider.runtimes[0]!.models[0]).toMatchObject({ contextWindowTokens: 128_000, contextWindowMaxTokens: 1_000_000,
    inheritedFields: ["name", "contextWindowTokens", "maximumOutputTokens", "inputModalities"] });
  const writes: SubmitOperationRequest[] = [];
  const transport = {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      const message = method.localName === "getSnapshot" ? create(GetSnapshotResponseSchema, { snapshot })
        : method.localName === "submitOperation" ? (() => {
          writes.push(fromBinary(SubmitOperationRequestSchema, toBinary(SubmitOperationRequestSchema, create(SubmitOperationRequestSchema, input))));
          return create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED } });
        })() : (() => { throw new Error("Optional service unavailable"); })();
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
    }),
    stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: idleStream() }))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "connection", deviceId: "device", serverId: "server", name: "Node", origin: "https://node.invalid" }, "test-key", {}, () => transport);
  await gateway.connect();
  try {
    await gateway.saveProvider(provider);
    const updated = { ...provider, runtimes: provider.runtimes.map(runtime => ({ ...runtime,
      models: runtime.models.map(model => updateProviderModelMetadata(model, { name: "Owner label" })) })) };
    await gateway.saveProvider(updated);
    const model = (index: number) => {
      const payload = writes[index]!.mutation!.payload;
      if (payload.case !== "upsertProvider") throw new Error("Expected the original Provider mutation");
      return payload.value.provider!.runtimes[0]!.models[0]!;
    };
    expect(model(0).inheritedFields).toEqual(inheritedFields);
    expect(model(1)).toMatchObject({ displayName: "Owner label", contextWindowTokens: 128_000n,
      inheritedFields: inheritedFields.filter(field => field !== ProviderModelInheritedField.DISPLAY_NAME) });
    expect(model(1).contextWindowMaxTokens).toBeUndefined();
  } finally { gateway.disconnect(); }
});

async function* idleStream(): AsyncGenerator<never> { await new Promise<never>(() => undefined); }
