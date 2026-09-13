import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "connection-backend-provider",
  name: "Backend Provider test",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

describe("Backend-native Provider account routing", () => {
  it("submits an API key only through the flow-bound credential channel", async () => {
    const beginLogin = vi.fn(async () => ({ method: "api_key" as const }));
    const refreshBackendDescriptor = vi.fn(async () => undefined);
    const consumeProviderLoginInput = vi.fn(() => "sk-test-value-must-not-persist");
    const { services } = fixture({ beginLogin, refreshBackendDescriptor, consumeProviderLoginInput });

    const operation = await submitLogin(services.operation.submitOperation, contract.ProviderLoginMethod.API_KEY);
    const flow = providerLoginResult(operation);
    expect(flow.pendingPrompt).toMatchObject({ kind: contract.ProviderLoginPromptKind.SECRET });

    const upload = await invoke<any>(services.credential.beginProviderLoginInputUpload, {
      loginFlowId: flow.loginFlowId,
      promptId: flow.pendingPrompt!.promptId
    });
    expect(upload.ticket).toMatchObject({ ticketId: "input-ticket" });

    const submitted = await invoke<any>(services.credential.submitProviderLoginInput, {
      loginFlowId: flow.loginFlowId,
      promptId: flow.pendingPrompt!.promptId,
      input: { case: "credentialInputTicketId", value: "input-ticket" }
    });

    expect(beginLogin).toHaveBeenCalledWith({ method: "api_key", apiKey: "sk-test-value-must-not-persist" });
    expect(submitted.loginFlow).toMatchObject({ state: contract.ProviderLoginFlowState.COMPLETED });
    expect(JSON.stringify(operation, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("sk-test-value-must-not-persist");
    expect(refreshBackendDescriptor).toHaveBeenCalledWith("native-backend");
  });

  it("observes browser login completion and republishes the owning Backend descriptor", async () => {
    let authenticated = false;
    const beginLogin = vi.fn(async () => ({
      method: "oauth_browser" as const,
      loginId: "native-login",
      url: "https://provider.example.test/authorize"
    }));
    const refreshBackendDescriptor = vi.fn(async () => undefined);
    const { services, readAccount } = fixture({
      beginLogin,
      refreshBackendDescriptor,
      account: () => authenticated
    });

    const operation = await submitLogin(services.operation.submitOperation, contract.ProviderLoginMethod.OAUTH_BROWSER);
    const flow = providerLoginResult(operation);
    expect(flow).toMatchObject({
      state: contract.ProviderLoginFlowState.PENDING,
      verificationUri: "https://provider.example.test/authorize"
    });

    authenticated = true;
    const observed = await invoke<any>(services.backend.getProviderLoginFlow, { loginFlowId: flow.loginFlowId });
    expect(readAccount).toHaveBeenCalledWith(false);
    expect(observed.loginFlow).toMatchObject({ state: contract.ProviderLoginFlowState.COMPLETED });
    expect(refreshBackendDescriptor).toHaveBeenCalledWith("native-backend");
  });

  it("refreshes an externally authenticated Provider through descriptor discovery without a login port", async () => {
    const refreshBackendDescriptor = vi.fn(async () => undefined);
    const { services, readAccount } = fixture({
      beginLogin: async () => ({ method: "api_key" as const }),
      refreshBackendDescriptor,
      descriptorRefreshOnly: true
    });

    await submitRefresh(services.operation.submitOperation);

    expect(readAccount).not.toHaveBeenCalled();
    expect(refreshBackendDescriptor).toHaveBeenCalledOnce();
    expect(refreshBackendDescriptor).toHaveBeenCalledWith("native-backend");
  });
});

function fixture(options: {
  readonly beginLogin: (input: unknown) => Promise<unknown>;
  readonly refreshBackendDescriptor: (backendId: string) => Promise<void>;
  readonly consumeProviderLoginInput?: () => string;
  readonly account?: () => boolean;
  readonly descriptorRefreshOnly?: boolean;
}) {
  const descriptor = {
    id: "native-backend",
    adapterKind: "native-test",
    instanceGeneration: 1,
    displayName: "Native Backend",
    version: "test",
    health: "healthy" as const,
    installationState: "installed" as const,
    authenticationState: "signed_out" as const,
    capabilities: new Map([
      ["provider.login", { key: "provider.login", supported: true, options: ["api_key", "oauth_browser"] }],
      ["provider.logout", { key: "provider.logout", supported: true }],
      ["provider.refresh", { key: "provider.refresh", supported: true }],
      ["provider.model_refresh", { key: "provider.model_refresh", supported: true }]
    ]),
    providers: [{
      providerId: "provider-one",
      displayName: "Provider One",
      api: "openai-responses",
      authenticationState: "signed_out" as const,
      loginMethods: ["api_key", "oauth_browser"] as const,
      supportsLogin: true,
      supportsLogout: true,
      supportsRefresh: true,
      supportsModelRefresh: true
    }],
    models: [],
    tools: [],
    diagnostics: []
  };
  const store = {
    findOperation: () => undefined,
    getBackend: (backendId: string) => {
      if (backendId !== descriptor.id) throw new Error("Backend not found.");
      return { descriptor, revision: 1n, updatedAt: 1 };
    },
    listBackends: () => [{ descriptor, revision: 1n, updatedAt: 1 }]
  };
  const readAccount = vi.fn(async () => {
    const authenticated = options.account?.() ?? false;
    return {
      authenticated,
      authenticationState: authenticated ? "authenticated" as const : "signed_out" as const
    };
  });
  const adapter = options.descriptorRefreshOnly
    ? { id: descriptor.id }
    : {
        id: descriptor.id,
        readAccount,
        listModels: vi.fn(async () => []),
        beginLogin: options.beginLogin,
        cancelLogin: vi.fn(async () => undefined),
        logout: vi.fn(async () => undefined)
      };
  const credentials = {
    createProviderLoginInputTicket: vi.fn(() => ({
      credentialUploadTicketId: "input-ticket",
      expiresAt: 60_000,
      maximumBytes: 16_384
    })),
    consumeProviderLoginInput: options.consumeProviderLoginInput ?? (() => "unused")
  };
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    sessionHost: immediateHost(store, adapter),
    adapters: [adapter],
    refreshBackendDescriptor: options.refreshBackendDescriptor,
    credentials,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  return { services: createConnectServices(application), readAccount };
}

async function submitLogin(handler: unknown, method: contract.ProviderLoginMethod): Promise<unknown> {
  return await invoke(handler, {
    operationId: crypto.randomUUID(),
    connectionId: connection.id,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "beginProviderLogin",
        value: create(contract.BeginProviderLoginMutationSchema, {
          backendId: "native-backend",
          providerId: "provider-one",
          method
        })
      }
    })
  });
}

async function submitRefresh(handler: unknown): Promise<unknown> {
  return await invoke(handler, {
    operationId: crypto.randomUUID(),
    connectionId: connection.id,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "refreshProviderCredential",
        value: create(contract.RefreshProviderCredentialMutationSchema, {
          backendId: "native-backend",
          providerId: "provider-one"
        })
      }
    })
  });
}

function providerLoginResult(response: any): contract.ProviderLoginFlow {
  const payload = response.operation?.result?.payload;
  if (payload?.case !== "providerLogin") throw new Error("Provider login result is missing.");
  return payload.value;
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T>)(request, {
    requestHeader: new Headers({ authorization: "Bearer backend-provider-test" }),
    signal: new AbortController().signal
  });
}

function immediateHost(store: object, adapter: { readonly id: string }) {
  return {
    invokeBackendAdapter: async <T>(
      backendId: string,
      effect: (current: typeof adapter, generation: number) => T | Promise<T>
    ): Promise<T> => {
      if (backendId !== adapter.id) throw new Error("Backend not found.");
      return await effect(adapter, 1);
    },
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
