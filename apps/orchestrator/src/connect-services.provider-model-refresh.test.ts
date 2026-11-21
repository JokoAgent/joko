import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "connection-model-refresh",
  name: "Model refresh test",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

describe("Provider model refresh operation", () => {
  it("carries automatic and manual refresh intent through the durable operation boundary", async () => {
    const refreshModelCatalogs = vi.fn(async () => undefined);
    const reconcileAvailability = vi.fn();
    const store = {
      findOperation: () => undefined,
      getBackend: (backendId: string) => ({
        descriptor: {
          id: backendId,
          capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]])
        }
      })
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: immediateHost(store),
      providers: {
        nativeAuthenticationBackendId: "managed-backend",
        canDiscoverProviderModels: () => false,
        list: () => [{
          backendId: "managed-backend",
          provider: { id: "provider-one" }
        }]
      },
      providerAuth: { refreshModelCatalogs },
      messageSearch: { reconcileAvailability }
    }));

    await submit(services.operation.submitOperation, "operation-auto-model-refresh", "", true);
    await submit(services.operation.submitOperation, "operation-manual-model-refresh", "provider-one", false);

    expect(refreshModelCatalogs).toHaveBeenNthCalledWith(1, { automatic: true });
    expect(refreshModelCatalogs).toHaveBeenNthCalledWith(2, {
      providerId: "provider-one",
      automatic: false
    });
    expect(reconcileAvailability).toHaveBeenCalledTimes(2);
  });

  it("uses the original connection fence when a managed catalog refresh adopts its response", async () => {
    const refreshBackendDescriptor = vi.fn();
    const entries = [{ backendId: "managed-backend", provider: { id: "provider-one" } }];
    const store = { findOperation: () => undefined, getBackend: () => ({ descriptor: {
      id: "managed-backend", capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]])
    } }) };
    let current = true;
    const fence = vi.fn((owner: typeof connection) => {
      expect(owner).toMatchObject({ id: connection.id, authKeyDigest: connection.authKeyDigest, state: connection.state });
      if (!current) throw new Error("Original connection is no longer current.");
    });
    let markStarted!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const adopted = vi.fn();
    const discoverProviderModels = vi.fn(async (_backend: string, _provider: string, _fetch: unknown, assertCurrent: () => void) => {
      assertCurrent(); markStarted(); await held;
      assertCurrent(); adopted();
    });
    const services = createConnectServices(stubApplication({ store, sessionHost: immediateHost(store),
      connections: { authenticate: () => connection, fence }, refreshBackendDescriptor,
      providers: { nativeAuthenticationBackendId: "pi", list: () => entries, listManaged: () => entries,
        canDiscoverProviderModels: () => true, discoverProviderModels }
    }));
    const refresh = submit(services.operation.submitOperation, "operation-retired-model-refresh", "provider-one", false);
    await Promise.race([started, refresh.then(() => { throw new Error("Refresh ended before reaching its original provider."); })]);
    current = false;
    finish();
    await expect(refresh).rejects.toThrow("Original connection is no longer current.");
    expect(discoverProviderModels).toHaveBeenCalledTimes(1);
    expect(adopted).not.toHaveBeenCalled();
    expect(refreshBackendDescriptor).not.toHaveBeenCalled();
  });

  it("returns a connection-bound review receipt and adopts only a separate explicit selection", async () => {
    const store = { findOperation: () => undefined, getBackend: () => ({ descriptor: {
      id: "managed-backend", capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]])
    } }) };
    const review = { reviewId: "review-one", backendId: "managed-backend", providerId: "provider-one", providerName: "Provider One",
      suspicious: true, models: [{ modelId: "old-a", displayName: "Old A" }] };
    const discoverProviderModels = vi.fn(async () => ({ addedModelIds: [], updatedModelIds: [], withdrawalReview: review }));
    const confirmModelWithdrawals = vi.fn(async () => undefined);
    const refreshBackendDescriptor = vi.fn(async () => undefined);
    const services = createConnectServices(stubApplication({ store, sessionHost: immediateHost(store),
      connections: { authenticate: () => connection, fence: vi.fn() }, refreshBackendDescriptor,
      providers: { nativeAuthenticationBackendId: "pi", list: () => [{ provider: { id: "provider-one" } }],
        canDiscoverProviderModels: () => true, discoverProviderModels, confirmModelWithdrawals }
    }));
    const receipt = await submit(services.operation.submitOperation, "operation-withdrawal-review", "provider-one", false);
    expect(receipt).toMatchObject({ operation: { result: { payload: { case: "providerModelWithdrawalReview", value: review } } } });
    expect(discoverProviderModels).toHaveBeenCalledWith(review.backendId, review.providerId, undefined, expect.any(Function), connection.id);
    expect(confirmModelWithdrawals).not.toHaveBeenCalled();

    await invokeMutation(services.operation.submitOperation, "operation-confirm-withdrawal", {
      case: "confirmProviderModelWithdrawals",
      value: create(contract.ConfirmProviderModelWithdrawalsMutationSchema, {
        backendId: review.backendId, providerId: review.providerId, reviewId: review.reviewId, modelIds: ["old-a"]
      })
    });
    expect(confirmModelWithdrawals).toHaveBeenCalledWith({ backendId: review.backendId, providerId: review.providerId, reviewId: review.reviewId,
      modelIds: ["old-a"] }, connection.id, expect.any(Function));
    expect(refreshBackendDescriptor).toHaveBeenCalledExactlyOnceWith(review.backendId);
  });
});

function submit(handler: unknown, operationId: string, providerId: string, automatic: boolean): Promise<unknown> {
  return invokeMutation(handler, operationId, {
    case: "refreshProviderModels",
    value: create(contract.RefreshProviderModelsMutationSchema, { backendId: "managed-backend", providerId, automatic })
  });
}

function invokeMutation(handler: unknown, operationId: string, payload: contract.OperationMutation["payload"]): Promise<unknown> {
  if (typeof handler !== "function") throw new Error("Operation handler is missing.");
  return (handler as (request: unknown, context: unknown) => Promise<unknown>)({
    operationId,
    connectionId: connection.id,
    mutation: create(contract.OperationMutationSchema, { payload })
  }, {
    requestHeader: new Headers({ authorization: "Bearer model-refresh-test" }),
    signal: new AbortController().signal
  });
}

function stubApplication(overrides: Record<string, unknown>): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides
  } as unknown as OrchestratorApplication;
}

function immediateHost(store: object) {
  return {
    mutate: async (input: {
      readonly operationId: string;
      readonly kind: string;
      readonly body: unknown;
      readonly effect?: () => Promise<void>;
      readonly commit: (store: object) => unknown;
    }) => {
      await input.effect?.();
      const value = input.commit(store);
      const operation: OperationRecord<unknown> = {
        id: input.operationId,
        connectionId: connection.id,
        kind: input.kind,
        body: input.body,
        bodyHash: operationBodyHash(input.body),
        completionMode: "external_effect",
        status: "completed",
        response: value,
        createdAt: 1,
        updatedAt: 2,
        revision: 1n
      };
      return { replayed: false, value, operation };
    }
  };
}
