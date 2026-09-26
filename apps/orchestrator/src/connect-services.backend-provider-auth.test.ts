import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import type {
  BackendProviderAuthenticationEvidence,
  BackendProviderAuthenticationRetirement
} from "./session-host.js";

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
    const { services, reconcileBackendProviderAuthentication } = fixture({ beginLogin, refreshBackendDescriptor, consumeProviderLoginInput });

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
    expect(reconcileBackendProviderAuthentication).toHaveBeenCalledWith(
      "native-backend",
      "provider-one",
      expect.objectContaining({ backendId: "native-backend", providerId: "provider-one" })
    );
  });

  it("observes browser login completion and republishes the owning Backend descriptor", async () => {
    let authenticated = false;
    const beginLogin = vi.fn(async () => ({
      method: "oauth_browser" as const,
      loginId: "native-login",
      url: "https://provider.example.test/authorize"
    }));
    const refreshBackendDescriptor = vi.fn(async () => undefined);
    const { services, readAccount, reconcileBackendProviderAuthentication } = fixture({
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
    expect(reconcileBackendProviderAuthentication).toHaveBeenCalledWith(
      "native-backend",
      "provider-one",
      expect.objectContaining({ backendId: "native-backend", providerId: "provider-one" })
    );
  });

  it("refreshes an externally authenticated Provider through descriptor discovery without a login port", async () => {
    const refreshBackendDescriptor = vi.fn(async () => undefined);
    const { services, readAccount, reconcileBackendProviderAuthentication } = fixture({
      beginLogin: async () => ({ method: "api_key" as const }),
      refreshBackendDescriptor,
      descriptorRefreshOnly: true
    });

    await submitRefresh(services.operation.submitOperation);

    expect(readAccount).not.toHaveBeenCalled();
    expect(refreshBackendDescriptor).toHaveBeenCalledOnce();
    expect(refreshBackendDescriptor).toHaveBeenCalledWith("native-backend");
    expect(reconcileBackendProviderAuthentication).toHaveBeenCalledWith(
      "native-backend",
      "provider-one",
      expect.objectContaining({ backendId: "native-backend", providerId: "provider-one" })
    );
  });

  it("fences logout before native work and retains a signed-out projection when descriptor refresh fails", async () => {
    const order: string[] = [];
    const logout = vi.fn(async () => { order.push("logout"); });
    const refreshBackendDescriptor = vi.fn(async () => {
      order.push("refresh");
      throw new Error("private upstream detail");
    });
    const {
      services,
      fenceBackendProviderAuthentication,
      completeBackendProviderAuthenticationRetirement,
      reconcileBackendProviderAuthentication,
      projectBackendProviderAuthentication,
      diagnostics
    } = fixture({
      beginLogin: async () => ({ method: "api_key" as const }),
      refreshBackendDescriptor,
      logout,
      onFence: () => { order.push("fence"); },
      onProjection: (state) => { order.push(`project:${state}`); }
    });
    const operationId = crypto.randomUUID();

    await submitLogout(services.operation.submitOperation, operationId);
    await submitLogout(services.operation.submitOperation, operationId);

    expect(order).toEqual(["fence", "project:pending", "logout", "refresh", "project:signed_out"]);
    expect(fenceBackendProviderAuthentication).toHaveBeenCalledWith("native-backend", "provider-one");
    expect(projectBackendProviderAuthentication).toHaveBeenNthCalledWith(
      1,
      "native-backend",
      "provider-one",
      "pending"
    );
    expect(projectBackendProviderAuthentication).toHaveBeenNthCalledWith(
      2,
      "native-backend",
      "provider-one",
      "signed_out"
    );
    expect(logout).toHaveBeenCalledOnce();
    expect(completeBackendProviderAuthenticationRetirement).toHaveBeenCalledOnce();
    expect(reconcileBackendProviderAuthentication).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain("private upstream detail");
    expect(diagnostics).toEqual([expect.objectContaining({
      code: "PROVIDER_LOGOUT_PROJECTION_REFRESH_FAILED",
      details: { backendId: "native-backend", providerId: "provider-one" }
    })]);
  });

  it("releases the exact Adapter lease before native catalog refresh and does not refresh the Pi generation twice", async () => {
    const order: string[] = [];
    const refreshCredential = vi.fn(async () => { order.push("refresh-credential"); });
    const revokeProviderAuthentication = vi.fn(async () => { order.push("revoke-runtime"); });
    const logout = vi.fn(async () => { order.push("logout-credential"); });
    const refreshPiGeneration = vi.fn(async () => { order.push("explicit-generation-refresh"); });
    const {
      services,
      completeBackendProviderAuthenticationRetirement,
      reconcileBackendProviderAuthentication
    } = fixture({
      beginLogin: async () => ({ method: "api_key" as const }),
      refreshBackendDescriptor: async () => undefined,
      managedNative: { refreshCredential, revokeProviderAuthentication, logout },
      refreshPiGeneration,
      onFence: () => { order.push("fence"); }
    });

    await submitRefresh(services.operation.submitOperation);
    await submitLogout(services.operation.submitOperation, crypto.randomUUID());

    expect(order).toEqual(["refresh-credential", "fence", "revoke-runtime", "logout-credential"]);
    expect(refreshPiGeneration).not.toHaveBeenCalled();
    expect(completeBackendProviderAuthenticationRetirement).toHaveBeenCalledOnce();
    expect(reconcileBackendProviderAuthentication).toHaveBeenCalledExactlyOnceWith(
      "native-backend",
      "provider-one",
      expect.objectContaining({ backendId: "native-backend", providerId: "provider-one" })
    );
  });

  it("keeps an older completed login-flow observation fenced during logout and accepts only post-retirement refresh evidence", async () => {
    let releaseRuntimeRetirement!: () => void;
    let markRuntimeRetirementStarted!: () => void;
    const runtimeRetirementStarted = new Promise<void>((resolve) => {
      markRuntimeRetirementStarted = resolve;
    });
    const runtimeRetirementBlocked = new Promise<void>((resolve) => {
      releaseRuntimeRetirement = resolve;
    });
    const revokeProviderAuthentication = vi.fn(async () => {
      markRuntimeRetirementStarted();
      await runtimeRetirementBlocked;
    });
    const oldFlow = {
      providerId: "provider-one",
      method: "oauth_browser" as const,
      opaqueFlowId: "managed-old-flow",
      verificationUri: "https://provider.example.test/authorize",
      state: "completed" as const,
      startedAt: 1,
      updatedAt: 2
    };
    const {
      services,
      completeBackendProviderAuthenticationRetirement,
      reconcileBackendProviderAuthentication,
      acceptedReconciliations
    } = fixture({
      beginLogin: async () => ({ method: "api_key" as const }),
      refreshBackendDescriptor: async () => undefined,
      managedNative: {
        refreshCredential: vi.fn(async () => undefined),
        revokeProviderAuthentication,
        logout: vi.fn(async () => undefined),
        beginLogin: vi.fn(async () => oldFlow),
        getLoginFlow: () => oldFlow
      }
    });
    const begun = providerLoginResult(await submitLogin(
      services.operation.submitOperation,
      contract.ProviderLoginMethod.OAUTH_BROWSER
    ));
    expect(begun.loginFlowId).toBe(oldFlow.opaqueFlowId);

    const logout = submitLogout(services.operation.submitOperation, crypto.randomUUID());
    await runtimeRetirementStarted;
    expect(completeBackendProviderAuthenticationRetirement).not.toHaveBeenCalled();

    const observed = await invoke<any>(services.backend.getProviderLoginFlow, {
      loginFlowId: oldFlow.opaqueFlowId
    });
    expect(observed.loginFlow).toMatchObject({ state: contract.ProviderLoginFlowState.COMPLETED });
    expect(reconcileBackendProviderAuthentication).toHaveBeenCalledOnce();
    expect(acceptedReconciliations).toEqual([]);

    releaseRuntimeRetirement();
    await logout;
    expect(completeBackendProviderAuthenticationRetirement).toHaveBeenCalledOnce();

    await submitRefresh(services.operation.submitOperation);
    expect(reconcileBackendProviderAuthentication).toHaveBeenCalledTimes(2);
    expect(acceptedReconciliations).toHaveLength(1);
  });
});

function fixture(options: {
  readonly beginLogin: (input: unknown) => Promise<unknown>;
  readonly refreshBackendDescriptor: (backendId: string) => Promise<void>;
  readonly consumeProviderLoginInput?: () => string;
  readonly account?: () => boolean;
  readonly descriptorRefreshOnly?: boolean;
  readonly logout?: () => Promise<void>;
  readonly onFence?: () => void;
  readonly onProjection?: (state: "pending" | "signed_out" | "error") => void;
  readonly managedNative?: {
    readonly refreshCredential: () => Promise<void>;
    readonly revokeProviderAuthentication: (providerId: string) => Promise<void>;
    readonly logout: (providerId: string) => Promise<void>;
    readonly beginLogin?: () => Promise<{
      readonly providerId: string;
      readonly method: "oauth_browser";
      readonly opaqueFlowId: string;
      readonly verificationUri: string;
    }>;
    readonly getLoginFlow?: () => unknown;
  };
  readonly refreshPiGeneration?: () => Promise<void>;
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
      ["provider.model_refresh", { key: "provider.model_refresh", supported: true }],
      ...(options.managedNative === undefined
        ? []
        : [["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }] as const])
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
  const operations = new Map<string, OperationRecord<unknown>>();
  const diagnostics: unknown[] = [];
  const store = {
    findOperation: (operationId: string) => operations.get(operationId),
    getBackend: (backendId: string) => {
      if (backendId !== descriptor.id) throw new Error("Backend not found.");
      return { descriptor, revision: 1n, updatedAt: 1 };
    },
    listBackends: () => [{ descriptor, revision: 1n, updatedAt: 1 }],
    deleteSetting: vi.fn(),
    appendDiagnostic: (diagnostic: unknown) => { diagnostics.push(diagnostic); }
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
        logout: options.logout ?? vi.fn(async () => undefined),
        ...(options.managedNative === undefined
          ? {}
          : { revokeProviderAuthentication: options.managedNative.revokeProviderAuthentication })
      };
  const credentials = {
    createProviderLoginInputTicket: vi.fn(() => ({
      credentialUploadTicketId: "input-ticket",
      expiresAt: 60_000,
      maximumBytes: 16_384
    })),
    consumeProviderLoginInput: options.consumeProviderLoginInput ?? (() => "unused")
  };
  let routeToken = Symbol("provider-auth-route");
  let retirementToken: symbol | undefined;
  let evidenceSequence = 0;
  let lastReconciledSequence = 0;
  const acceptedReconciliations: number[] = [];
  const beginBackendProviderAuthenticationEvidence = vi.fn((backendId: string, providerId: string) => ({
    backendId,
    providerId,
    routeToken,
    sequence: ++evidenceSequence
  }));
  const fenceBackendProviderAuthentication = vi.fn((backendId: string, providerId: string) => {
    routeToken = Symbol("provider-auth-route");
    retirementToken = Symbol("provider-auth-retirement");
    options.onFence?.();
    return { backendId, providerId, retirementToken };
  });
  const completeBackendProviderAuthenticationRetirement = vi.fn((
    retirement: BackendProviderAuthenticationRetirement
  ) => {
    if (retirement.retirementToken !== retirementToken) return;
    routeToken = Symbol("provider-auth-route");
    retirementToken = undefined;
  });
  const reconcileBackendProviderAuthentication = vi.fn((
    _backendId: string,
    _providerId: string,
    evidence: BackendProviderAuthenticationEvidence
  ) => {
    if (retirementToken !== undefined || evidence.routeToken !== routeToken
      || evidence.sequence <= lastReconciledSequence) return;
    lastReconciledSequence = evidence.sequence;
    acceptedReconciliations.push(evidence.sequence);
  });
  const projectBackendProviderAuthentication = vi.fn((
    _backendId: string,
    _providerId: string,
    state: "pending" | "signed_out" | "error"
  ) => { options.onProjection?.(state); });
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
    sessionHost: immediateHost(store, adapter, operations, {
      beginBackendProviderAuthenticationEvidence,
      fenceBackendProviderAuthentication,
      completeBackendProviderAuthenticationRetirement,
      reconcileBackendProviderAuthentication
    }),
    adapters: [adapter],
    refreshBackendDescriptor: options.refreshBackendDescriptor,
    projectBackendProviderAuthentication,
    ...(options.managedNative === undefined ? {} : {
      providers: {
        nativeAuthenticationBackendId: descriptor.id,
        hasManagedProvider: () => true,
        list: () => [{
          backendId: descriptor.id,
          provider: { id: "provider-one" },
          enabled: true,
          authenticationState: "authenticated"
        }],
        get: () => ({
          backendId: descriptor.id,
          provider: { id: "provider-one" },
          enabled: true,
          authenticationState: "authenticated"
        }),
        beginLogin: options.managedNative.beginLogin ?? (async () => ({
          providerId: "provider-one",
          method: "oauth_browser" as const,
          opaqueFlowId: "managed-native-flow",
          verificationUri: "https://provider.example.test/authorize"
        })),
        refreshCredential: options.managedNative.refreshCredential,
        logout: options.managedNative.logout
      },
      providerAuth: {
        canHandle: () => true,
        getFlow: options.managedNative.getLoginFlow ?? (() => undefined)
      },
      refreshPiGeneration: options.refreshPiGeneration
    }),
    credentials,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  return {
    services: createConnectServices(application),
    readAccount,
    fenceBackendProviderAuthentication,
    beginBackendProviderAuthenticationEvidence,
    completeBackendProviderAuthenticationRetirement,
    reconcileBackendProviderAuthentication,
    acceptedReconciliations,
    projectBackendProviderAuthentication,
    diagnostics
  };
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

async function submitLogout(handler: unknown, operationId: string): Promise<unknown> {
  return await invoke(handler, {
    operationId,
    connectionId: connection.id,
    mutation: create(contract.OperationMutationSchema, {
      payload: {
        case: "logoutProvider",
        value: create(contract.LogoutProviderMutationSchema, {
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

function immediateHost(
  store: object,
  adapter: { readonly id: string },
  operations: Map<string, OperationRecord<unknown>>,
  auth: {
    readonly beginBackendProviderAuthenticationEvidence: (
      backendId: string,
      providerId: string
    ) => BackendProviderAuthenticationEvidence;
    readonly fenceBackendProviderAuthentication: (
      backendId: string,
      providerId: string
    ) => BackendProviderAuthenticationRetirement;
    readonly completeBackendProviderAuthenticationRetirement: (
      retirement: BackendProviderAuthenticationRetirement
    ) => void;
    readonly reconcileBackendProviderAuthentication: (
      backendId: string,
      providerId: string,
      evidence: BackendProviderAuthenticationEvidence
    ) => void;
  }
) {
  return {
    ...auth,
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
      const existing = operations.get(input.operationId);
      if (existing !== undefined) {
        return { replayed: true, value: existing.response, operation: existing };
      }
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
      operations.set(input.operationId, operation);
      return { replayed: false, value, operation };
    }
  };
}
