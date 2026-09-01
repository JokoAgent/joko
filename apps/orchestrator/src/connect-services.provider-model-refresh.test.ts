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
      providers: {},
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
});

async function submit(handler: unknown, operationId: string, providerId: string, automatic: boolean): Promise<void> {
  if (typeof handler !== "function") throw new Error("Operation handler is missing.");
  await (handler as (request: unknown, context: unknown) => Promise<unknown>)({
    operationId,
    connectionId: connection.id,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "refreshProviderModels",
        value: create(contract.RefreshProviderModelsMutationSchema, {
          backendId: "managed-backend",
          providerId,
          automatic
        })
      }
    })
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
