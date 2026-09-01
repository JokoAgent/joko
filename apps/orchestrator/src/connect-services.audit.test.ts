import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { PiBackendAdapter } from "@joko/adapter-pi";
import type { CodeHostProvider } from "@joko/code-host";
import * as contract from "@joko/contracts";
import { NotFoundError, OperationConflictError, OperationPreviouslyFailedError, OperationalStore, StoreError, operationBodyHash, type PersistedEvent } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import {
  createConnectServices,
  providerRateLimitSettingKey,
  registerConnectServices
} from "./connect-services.js";
import { ConnectionAuthenticationError } from "./connection-manager.js";
import { nativeStateObservation, SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY } from "./native-state-observation.js";
import { toProtoEventCursor, toProtoTimestamp } from "./proto-mapper.js";
import { SESSION_RUNTIME_STATE_SETTING_KEY } from "./session-runtime-state.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function stubApplication(overrides: Record<string, unknown> = {}): OrchestratorApplication {
  const overriddenSessionHost = typeof overrides.sessionHost === "object" && overrides.sessionHost !== null
    ? overrides.sessionHost
    : {};
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {},
    connections: {},
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined,
    ...overrides,
    sessionHost: {
      getSessionRuntimeControl: () => ({
        generation: 0,
        fallbackHop: 0,
        visitedRoutes: []
      }),
      ...overriddenSessionHost
    }
  } as unknown as OrchestratorApplication;
}

function context(signal = new AbortController().signal): unknown {
  return { requestHeader: new Headers(), signal };
}

function revocableConnections() {
  const authenticated = {
    id: "connection-stream-fence",
    deviceId: "device-stream-fence",
    name: "Fence test",
    authKeyDigest: "digest-stream-fence",
    state: "active" as const,
    pairedAt: 1,
    revision: 1n
  };
  let active = true;
  let touches = 0;
  const listeners = new Set<() => void>();
  return {
    authenticated,
    authenticate: vi.fn(() => {
      touches += 1;
      if (!active) throw new ConnectionAuthenticationError("AUTH_REVOKED", "revoked");
      return authenticated;
    }),
    fence: vi.fn(() => {
      if (!active) throw new ConnectionAuthenticationError("AUTH_REVOKED", "revoked");
      return authenticated;
    }),
    onRevoked: vi.fn((_connectionId: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    revoke() {
      active = false;
      for (const listener of [...listeners]) listener();
    },
    touches: () => touches
  };
}

function persistedStatus(cursor = 1n): PersistedEvent {
  return {
    id: `event-${cursor}`,
    sequence: cursor,
    globalCursor: cursor,
    revision: cursor,
    emittedAt: Number(cursor),
    backendId: "backend-fence",
    targetId: "target-fence",
    sessionId: "session-fence",
    generation: 1,
    traceId: `trace-${cursor}`,
    payload: { type: "status", key: "fence", text: "safe" }
  };
}

async function invoke(handler: unknown, request: unknown, handlerContext: unknown): Promise<unknown> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  const result = (handler as (request: unknown, context: unknown) => unknown)(request, handlerContext);
  if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
    return (result as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
  }
  return await result;
}

describe("Connect security and protocol audit", () => {
  it("authenticates every RPC except the explicit credential-free bootstrap calls", async () => {
    const registrations: Array<{
      descriptor: { typeName: string; method: Record<string, unknown> };
      implementation: Record<string, unknown>;
    }> = [];
    const router = {
      service(descriptor: { typeName: string; method: Record<string, unknown> }, implementation: Record<string, unknown>) {
        registrations.push({ descriptor, implementation });
      }
    } as unknown as ConnectRouter;
    const authenticate = () => {
      throw new ConnectionAuthenticationError("AUTH_REQUIRED", "Authentication is required.");
    };
    registerConnectServices(router, stubApplication({ connections: { authenticate } }));
    const publicCalls = new Set([
      "joko.v1.ConnectionService/getServerInfo",
      "joko.v1.ConnectionService/listDiscoveredNodes",
      "joko.v1.ConnectionService/beginPairing",
      "joko.v1.ConnectionService/completePairing"
    ]);
    const registeredCalls = new Set(registrations.flatMap(({ descriptor }) =>
      Object.keys(descriptor.method).map((methodName) => `${descriptor.typeName}/${methodName}`)
    ));
    for (const publicCall of publicCalls) expect(registeredCalls.has(publicCall), publicCall).toBe(true);
    let protectedCount = 0;

    for (const { descriptor, implementation } of registrations) {
      for (const methodName of Object.keys(descriptor.method)) {
        if (publicCalls.has(`${descriptor.typeName}/${methodName}`)) continue;
        protectedCount += 1;
        let failure: unknown;
        try {
          await invoke(implementation[methodName], {}, context());
        } catch (error) {
          failure = error;
        }
        expect(failure, `${descriptor.typeName}/${methodName}`).toBeInstanceOf(ConnectError);
        expect((failure as ConnectError).code, `${descriptor.typeName}/${methodName}`).toBe(Code.Unauthenticated);
      }
    }

    expect(protectedCount).toBe(registeredCalls.size - publicCalls.size);
  });

  it("returns LAN bootstrap nodes without authentication or sensitive fields", async () => {
    const services = createConnectServices(stubApplication({
      serverId: "orchestrator-node-a",
      lanDiscovery: {
        list: () => [{
          serverId: "orchestrator-node-a",
          displayName: "Office Orchestrator",
          origin: "http://192.168.1.20:4318",
          version: "0.1.0",
          apiVersion: "joko.v1",
          pairingEnabled: true,
          lastSeen: 10_000
        }]
      },
      connections: {
        pairingEnabled: true,
        authenticate: () => { throw new Error("bootstrap must not authenticate"); }
      }
    }));

    const response = await invoke(services.connection.listDiscoveredNodes, {}, context()) as {
      nodes: readonly contract.DiscoveredNode[];
    };
    const serverResponse = await invoke(services.connection.getServerInfo, {}, context()) as { server?: contract.ServerInfo };
    const wire = fromBinary(
      contract.ListDiscoveredNodesResponseSchema,
      toBinary(contract.ListDiscoveredNodesResponseSchema, create(contract.ListDiscoveredNodesResponseSchema, {
        nodes: [...response.nodes]
      }))
    );

    expect(wire.nodes).toHaveLength(1);
    expect(serverResponse.server?.serverId).toBe("orchestrator-node-a");
    expect(wire.nodes[0]).toMatchObject({
      serverId: "orchestrator-node-a",
      displayName: "Office Orchestrator",
      origin: "http://192.168.1.20:4318",
      pairingEnabled: true
    });
    const wireKeys = Object.keys(wire.nodes[0] as object).map((key) => key.toLocaleLowerCase());
    expect(wireKeys.some((key) => key.includes("code") || key.includes("key") || key.includes("credential") || key.includes("token"))).toBe(false);
  });

  it("scopes Provider usage by Backend without relying on the literal Pi id", async () => {
    const sessions = [
      sessionUsageRecord("session-one", "renamed-pi", "shared-provider", 11),
      sessionUsageRecord("session-two", "other-backend", "shared-provider", 22)
    ];
    const services = createConnectServices(stubApplication({
      store: {
        getBackend: (backendId: string) => ({
          descriptor: {
            id: backendId,
            models: [{ providerId: "shared-provider" }]
          }
        }),
        findSetting: (_scopeType: string, _scopeId: string, key: string) => key === providerRateLimitSettingKey("renamed-pi", "shared-provider")
          ? { value: { limited: true, resetsAt: 4_100_000_000_000, observedAt: 1 } }
          : undefined,
        listUsageLedger: ({ backendId }: { readonly backendId?: string }) => sessions
          .filter((session) => backendId === undefined || session.descriptor.backendId === backendId)
          .map((session) => ({
            ownerId: "orchestrator",
            sessionId: session.descriptor.id,
            generation: 0,
            backendId: session.descriptor.backendId,
            providerId: "shared-provider",
            modelId: "model",
            day: "2026-08-25",
            inputTokens: session.runtimeState.usage.inputTokens,
            outputTokens: session.runtimeState.usage.outputTokens,
            cacheReadTokens: session.runtimeState.usage.cacheReadTokens,
            cacheWriteTokens: session.runtimeState.usage.cacheWriteTokens,
            totalTokens: session.runtimeState.usage.totalTokens,
            costMicros: Math.round(session.runtimeState.usage.cost * 1_000_000),
            currencyCode: "USD",
            costComplete: true,
            estimated: true,
            firstMeasuredAt: session.runtimeState.updatedAt,
            lastMeasuredAt: session.runtimeState.updatedAt,
            revision: 1n
          }))
      },
      connections: { authenticate: () => ({ id: "connection-usage", authKeyDigest: "digest", state: "active" }) }
    }));

    const response = await invoke(services.backend.getProviderUsage, {
      backendId: "renamed-pi",
      providerId: "shared-provider"
    }, context()) as { usage?: contract.ProviderUsageSummary; rateLimit?: contract.RateLimitState };

    expect(response.usage?.usage?.totalTokens).toBe(11n);
    expect(response.rateLimit).toMatchObject({ limited: true });
  });

  it("routes a managed Provider catalog through a fake non-specialized Backend capability", async () => {
    const list = vi.fn(() => [{
      provider: { id: "provider-capability", api: "anthropic-messages", models: [] },
      displayName: "Capability Provider",
      kind: "api_key",
      credentialReferenceIds: [],
      enabled: true,
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: false,
      authenticationState: "authenticated",
      version: 1n,
      updatedAt: 1
    }]);
    const services = createConnectServices(stubApplication({
      store: {
        getBackend: (backendId: string) => ({
          descriptor: {
            id: backendId,
            capabilities: new Map([["provider.managed_catalog", {
              key: "provider.managed_catalog",
              supported: true
            }]])
          }
        }),
        listUsageLedger: () => [],
        findSetting: () => undefined
      },
      providers: { list },
      connections: { authenticate: () => ({ id: "connection-provider-capability", authKeyDigest: "digest", state: "active" }) }
    }));

    const response = await invoke(services.backend.listProviders, {
      backendId: "backend-provider-capability"
    }, context()) as { providers: readonly contract.ProviderDescriptor[] };

    expect(list).toHaveBeenCalledOnce();
    expect(response.providers).toMatchObject([{
      backendId: "backend-provider-capability",
      providerId: "provider-capability",
      displayName: "Capability Provider"
    }]);
  });

  it("lists an explicit backend-native Provider while its model catalog is empty", async () => {
    const descriptor = {
      id: "backend-native-account",
      authenticationState: "signed_out" as const,
      capabilities: new Map(),
      providers: [{
        providerId: "native-account",
        displayName: "Native account",
        api: "openai-responses",
        authenticationState: "signed_out" as const,
        loginMethods: ["api_key" as const],
        supportsLogin: true,
        supportsLogout: false,
        supportsRefresh: true,
        supportsModelRefresh: true
      }],
      models: []
    };
    const services = createConnectServices(stubApplication({
      store: {
        getBackend: () => ({ descriptor, revision: 3n, updatedAt: 4_000 }),
        listUsageLedger: () => [],
        findSetting: () => undefined
      },
      connections: { authenticate: () => ({ id: "connection-native-provider", authKeyDigest: "digest", state: "active" }) }
    }));

    const response = await invoke(services.backend.listProviders, {
      backendId: descriptor.id
    }, context()) as { providers: readonly contract.ProviderDescriptor[] };

    expect(response.providers).toEqual([expect.objectContaining({
      backendId: descriptor.id,
      providerId: "native-account",
      displayName: "Native account",
      authenticationState: contract.AuthenticationState.SIGNED_OUT,
      loginMethods: [contract.ProviderLoginMethod.API_KEY]
    })]);
  });

  it("projects capability-owned account quota separately from token usage", async () => {
    const descriptor = {
      provider: { id: "subscription-capability", models: [] },
      displayName: "Subscription capability",
      kind: "subscription",
      credentialReferenceIds: [],
      enabled: true,
      supportsLogin: true,
      supportsLogout: true,
      supportsRefresh: true,
      authenticationState: "authenticated",
      capabilities: new Set(["provider.account_usage"]),
      version: 2n,
      updatedAt: 1
    };
    const getAccountUsage = vi.fn(async () => ({
      providerId: "subscription-capability",
      primaryWindow: { usedPercent: 42, windowMinutes: 300, resetAt: 4_100_000_000_000 },
      secondaryWindow: { usedPercent: 75, windowMinutes: 10_080, resetAt: 4_200_000_000_000 },
      limitReached: false,
      planType: "pro",
      credits: { hasCredits: true, unlimited: false, balance: "4.50", observedAt: 1_800_000_000_000 },
      observedAt: 1_800_000_000_000
    }));
    const services = createConnectServices(stubApplication({
      store: {
        getBackend: (backendId: string) => ({
          descriptor: {
            id: backendId,
            capabilities: new Map([["provider.managed_catalog", {
              key: "provider.managed_catalog",
              supported: true
            }]])
          }
        }),
        listUsageLedger: () => [],
        findSetting: () => undefined
      },
      providers: {
        list: () => [descriptor],
        get: () => descriptor
      },
      providerAccountUsage: { get: getAccountUsage },
      connections: { authenticate: () => ({ id: "connection-account-usage", authKeyDigest: "digest", state: "active" }) }
    }));

    const listed = await invoke(services.backend.listProviders, {
      backendId: "backend-provider-capability"
    }, context()) as { providers: readonly contract.ProviderDescriptor[] };
    const usage = await invoke(services.backend.getProviderUsage, {
      backendId: "backend-provider-capability",
      providerId: "subscription-capability"
    }, context()) as contract.GetProviderUsageResponse;

    expect(listed.providers[0]?.capabilities?.capabilities).toMatchObject([{
      name: "provider.account_usage",
      support: contract.CapabilitySupport.SUPPORTED
    }]);
    expect(listed.providers[0]?.accountUsage).toMatchObject({
      planType: "pro",
      primaryWindow: { usedPercent: 42, windowMinutes: 300 },
      secondaryWindow: { usedPercent: 75, windowMinutes: 10_080 },
      credits: { hasCredits: true, unlimited: false, balance: "4.50" }
    });
    expect(usage.accountUsage?.primaryWindow?.usedPercent).toBe(42);
    expect(usage.usage?.usage?.totalTokens).toBe(0n);
    expect(getAccountUsage).toHaveBeenCalledTimes(2);
  });

  it("returns an ordinary Snapshot without waiting for a cold Provider account refresh", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-account-usage-snapshot-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "managed-provider-backend",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Managed Provider Backend",
      version: "1",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      models: [],
      tools: [],
      diagnostics: []
    });
    const descriptor = {
      provider: { id: "subscription-snapshot", models: [] },
      displayName: "Subscription snapshot",
      kind: "subscription",
      credentialReferenceIds: [],
      enabled: true,
      supportsLogin: true,
      supportsLogout: true,
      supportsRefresh: true,
      authenticationState: "authenticated",
      capabilities: new Set(["provider.account_usage"]),
      version: 1n,
      updatedAt: 1
    };
    const get = vi.fn(async () => await new Promise<never>(() => undefined));
    const peek = vi.fn(() => undefined);
    const services = createConnectServices(stubApplication({
      store,
      providers: { list: () => [descriptor] },
      providerAccountUsage: { get, peek },
      connections: { authenticate: () => ({ id: "connection-account-snapshot", authKeyDigest: "digest", state: "active" }) }
    }));

    const outcome = await Promise.race([
      invoke(services.event.getSnapshot, {}, context()).then((value) => ({ kind: "snapshot" as const, value })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500))
    ]);

    expect(outcome.kind).toBe("snapshot");
    expect(peek).toHaveBeenCalledWith("subscription-snapshot");
    expect(get).toHaveBeenCalledWith("subscription-snapshot");
  });

  it("keeps the complete managed model catalog in the owner Snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-owner-model-catalog-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "managed-model-backend",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Managed model Backend",
      version: "1",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      models: [],
      tools: [],
      diagnostics: []
    });
    store.setSetting("service", "orchestrator", "settings.model_access.managed-model-backend", {
      disabledModels: [{ providerId: "managed-provider", modelId: "disabled-model" }]
    });
    const provider = {
      provider: {
        id: "managed-provider",
        api: "openai-responses",
        models: [{ id: "disabled-model", name: "Disabled model" }]
      },
      displayName: "Managed Provider",
      kind: "api_key",
      credentialReferenceIds: [],
      enabled: true,
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: false,
      authenticationState: "authenticated",
      version: 1n,
      updatedAt: 1
    };
    const services = createConnectServices(stubApplication({
      store,
      providers: { list: () => [provider] },
      connections: { authenticate: () => ({ id: "connection-owner-model-catalog", authKeyDigest: "digest", state: "active" }) }
    }));

    const response = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };

    expect(store.getBackend("managed-model-backend").descriptor.models).toEqual([]);
    expect(response.snapshot?.models).toContainEqual(expect.objectContaining({
      backendId: "managed-model-backend",
      key: expect.objectContaining({ providerId: "managed-provider", modelId: "disabled-model" })
    }));
  });

  it("serves bounded owner usage history and exact model price overrides from durable state", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 7, 25, 12));
    cleanups.push(() => clock.mockRestore());
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-usage-history-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "backend-usage",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Usage Backend",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [{
        providerId: "provider-usage",
        modelId: "model-usage",
        displayName: "Usage model",
        api: "openai-responses",
        contextWindow: 32_000,
        maxOutputTokens: 4_000,
        supportsImages: false,
        thinkingLevels: [],
        cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 }
      }],
      tools: [],
      diagnostics: []
    });
    store.upsertBackend({
      id: "backend-usage-secondary",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Secondary usage Backend",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [{
        providerId: "provider-usage",
        modelId: "model-usage",
        displayName: "Secondary usage model",
        api: "openai-responses",
        contextWindow: 32_000,
        maxOutputTokens: 4_000,
        supportsImages: false,
        thinkingLevels: [],
        cost: { input: 11, output: 19, cacheRead: 1, cacheWrite: 11 }
      }],
      tools: [],
      diagnostics: []
    });
    store.upsertTarget({
      id: "target-usage",
      backendId: "backend-usage",
      displayName: "Usage project",
      workspaceRoot: "D:/usage",
      managed: false,
      trusted: true
    });
    store.upsertTarget({
      id: "target-usage-secondary",
      backendId: "backend-usage-secondary",
      displayName: "Secondary usage project",
      workspaceRoot: "D:/usage-secondary",
      managed: false,
      trusted: true
    });
    store.createSession({
      id: "session-usage",
      backendId: "backend-usage",
      targetId: "target-usage",
      title: "Usage task",
      binding: { opaqueRef: "native/usage.jsonl", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      providerId: "provider-usage",
      modelId: "model-usage",
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    store.createSession({
      id: "session-usage-old",
      backendId: "backend-usage",
      targetId: "target-usage",
      title: "Older usage task",
      binding: { opaqueRef: "native/usage-old.jsonl", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      providerId: "provider-usage",
      modelId: "model-usage",
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    store.createSession({
      id: "session-usage-secondary",
      backendId: "backend-usage-secondary",
      targetId: "target-usage-secondary",
      title: "Secondary usage task",
      binding: { opaqueRef: "native/usage-secondary.jsonl", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      providerId: "provider-usage",
      modelId: "model-usage",
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    store.recordUsageObservation({
      ownerId: "orchestrator-usage-owner",
      sessionId: "session-usage-old",
      sourceId: "session-runtime",
      generation: 0,
      backendId: "backend-usage",
      providerId: "provider-usage",
      modelId: "model-usage",
      measuredAt: Date.UTC(2026, 6, 1, 12),
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 100,
      costRates: { inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 6_000_000 },
      currencyCode: "USD"
    });
    const observe = (inputTokens: number, outputTokens: number, measuredAt: number) => store.recordUsageObservation({
      ownerId: "orchestrator-usage-owner",
      sessionId: "session-usage",
      sourceId: "session-runtime",
      generation: 0,
      backendId: "backend-usage",
      providerId: "provider-usage",
      modelId: "model-usage",
      measuredAt,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens,
      costRates: {
        inputMicrosPerMillion: 2_000_000,
        outputMicrosPerMillion: 6_000_000,
        cacheReadMicrosPerMillion: 200_000,
        cacheWriteMicrosPerMillion: 2_000_000
      },
      currencyCode: "USD"
    });
    observe(20, 5, Date.UTC(2026, 7, 23, 12));
    observe(30, 8, Date.UTC(2026, 7, 24, 12));
    store.recordUsageObservation({
      ownerId: "orchestrator-usage-owner",
      sessionId: "session-usage-secondary",
      sourceId: "session-runtime",
      generation: 0,
      backendId: "backend-usage-secondary",
      providerId: "provider-usage",
      modelId: "model-usage",
      measuredAt: Date.UTC(2026, 7, 24, 12),
      inputTokens: 17,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 17,
      costRates: { inputMicrosPerMillion: 11_000_000, outputMicrosPerMillion: 19_000_000 },
      currencyCode: "USD"
    });
    const authenticate = vi.fn(() => ({ id: "connection-usage-history", authKeyDigest: "digest", state: "active" }));
    const services = createConnectServices(stubApplication({
      store,
      connections: { authenticate },
      serverId: "orchestrator-usage-owner"
    }));

    const response = await invoke(services.backend.getUsageHistory, {
      days: 60,
      backendId: "backend-usage",
      providerId: "provider-usage"
    }, context()) as { history?: contract.UsageHistory };
    expect(response.history?.days).toHaveLength(60);
    expect(response.history?.last30Days?.usage?.totalTokens).toBe(38n);
    expect(response.history?.models[0]?.backendId).toBe("backend-usage");
    expect(response.history?.models[0]?.model).toMatchObject({ providerId: "provider-usage", modelId: "model-usage" });
    expect(response.history?.models[0]?.usage?.totalTokens).toBe(38n);
    expect(response.history?.models[0]?.currencyTotals[0]?.usage?.costMicros).toBe(108n);
    expect(response.history?.currentStreakDays).toBe(2);
    expect(response.history?.longestStreakDays).toBe(2);
    const globalResponse = await invoke(services.backend.getUsageHistory, {
      days: 60,
      backendId: "",
      providerId: ""
    }, context()) as {
      history?: contract.UsageHistory;
    };
    expect(globalResponse.history?.models.map((summary) => ({
      backendId: summary.backendId,
      providerId: summary.model?.providerId,
      modelId: summary.model?.modelId,
      totalTokens: summary.usage?.totalTokens
    }))).toEqual([
      { backendId: "backend-usage", providerId: "provider-usage", modelId: "model-usage", totalTokens: 38n },
      { backendId: "backend-usage-secondary", providerId: "provider-usage", modelId: "model-usage", totalTokens: 17n }
    ]);
    await expect(invoke(services.backend.getUsageHistory, { days: 367 }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });

    const reference = await invoke(services.backend.getModelPriceOverride, {
      backendId: "backend-usage",
      providerId: "provider-usage",
      modelId: "model-usage"
    }, context()) as { price?: contract.ModelPriceOverrideView };
    expect(reference.price?.reference).toMatchObject({
      currency: contract.ModelPriceCurrency.USD,
      inputCostMicrosPerMillion: 2_000_000n,
      outputCostMicrosPerMillion: 6_000_000n
    });
    const changed = await invoke(services.backend.setModelPriceOverride, {
      backendId: "backend-usage",
      providerId: "provider-usage",
      modelId: "model-usage",
      desired: create(contract.ModelPriceQuoteSchema, {
        currency: contract.ModelPriceCurrency.CNY,
        inputCostMicrosPerMillion: 7_000_000n,
        outputCostMicrosPerMillion: 20_000_000n,
        cacheReadCostMicrosPerMillion: 700_000n
      })
    }, context()) as { price?: contract.ModelPriceOverrideView };
    expect(changed.price?.effective).toMatchObject({
      currency: contract.ModelPriceCurrency.CNY,
      inputCostMicrosPerMillion: 7_000_000n,
      cacheReadCostMicrosPerMillion: 700_000n
    });
    expect(changed.price?.override).toBeDefined();
    const isolated = await invoke(services.backend.getModelPriceOverride, {
      backendId: "backend-usage-secondary",
      providerId: "provider-usage",
      modelId: "model-usage"
    }, context()) as { price?: contract.ModelPriceOverrideView };
    expect(isolated.price).toMatchObject({ backendId: "backend-usage-secondary", override: undefined });
    expect(isolated.price?.effective).toMatchObject({
      currency: contract.ModelPriceCurrency.USD,
      inputCostMicrosPerMillion: 11_000_000n,
      outputCostMicrosPerMillion: 19_000_000n
    });
    const reset = await invoke(services.backend.resetModelPriceOverride, {
      backendId: "backend-usage",
      providerId: "provider-usage",
      modelId: "model-usage"
    }, context()) as { price?: contract.ModelPriceOverrideView };
    expect(reset.price?.override).toBeUndefined();
    expect(reset.price?.effective?.currency).toBe(contract.ModelPriceCurrency.USD);
    expect(authenticate).toHaveBeenCalled();
  });

  it("validates usage Provider ownership within the requested Backend instance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-usage-provider-scope-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const backend = (id: string, managedCatalog: boolean) => store.upsertBackend({
      id,
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: id,
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: managedCatalog
        ? new Map([["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]])
        : new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    backend("backend-native-unrelated", false);
    backend("backend-managed-owner", true);
    const providers = {
      list: () => [{ provider: { id: "shared-provider" }, kind: "api_key" }]
    };
    const services = createConnectServices(stubApplication({
      store,
      providers,
      connections: { authenticate: () => ({ id: "connection-usage-provider-scope", authKeyDigest: "digest", state: "active" }) }
    }));

    await expect(invoke(services.backend.getUsageHistory, {
      days: 30,
      backendId: "backend-native-unrelated",
      providerId: "shared-provider"
    }, context())).rejects.toMatchObject({
      name: "NotFoundError",
      resource: "Provider",
      id: "shared-provider"
    });
    await expect(invoke(services.backend.getUsageHistory, {
      days: 30,
      backendId: "backend-managed-owner",
      providerId: "shared-provider"
    }, context())).resolves.toMatchObject({ history: { models: [] } });
  });

  it("maps live Backend commands through SessionService without resource inference", async () => {
    const getCommands = vi.fn(async () => [
      { name: "review", description: "Review this change", source: "extension" as const, path: "extensions/review.ts", loaded: true },
      { name: "plan", description: "Open a plan", source: "prompt" as const, loaded: false }
    ]);
    const services = createConnectServices(stubApplication({
      connections: { authenticate: () => ({ id: "connection-runtime-commands", authKeyDigest: "digest", state: "active" }) },
      sessionHost: { getCommands }
    }));

    const response = await invoke(services.session.listRuntimeCommands, {
      sessionId: "session-runtime-commands"
    }, context()) as { commands: readonly contract.RuntimeCommand[] };

    expect(getCommands).toHaveBeenCalledExactlyOnceWith("session-runtime-commands");
    expect(response.commands).toHaveLength(2);
    expect(response.commands[0]).toMatchObject({
      sessionId: "session-runtime-commands",
      name: "review",
      description: "Review this change",
      source: contract.RuntimeCommandSource.EXTENSION,
      resourceId: "",
      loaded: true
    });
    expect(response.commands[0]?.commandId).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.commands[1]).toMatchObject({
      sessionId: "session-runtime-commands",
      name: "plan",
      source: contract.RuntimeCommandSource.PROMPT,
      loaded: false
    });
  });

  it("maps authenticated owner-wide visible message search without Backend branching", async () => {
    const authenticate = vi.fn(() => ({
      id: "connection-message-search",
      authKeyDigest: "digest",
      state: "active"
    }));
    const searchSessionMessages = vi.fn(() => ({
      matches: [{
        sessionId: "session-search",
        targetId: "target-search",
        eventId: "event-search",
        timelineItemId: "entry-search",
        role: "assistant" as const,
        kind: "text_message" as const,
        snippet: "可见的 release plan",
        createdAt: 1_234,
        score: 0.75
      }],
      nextPageToken: "next-message-page",
      totalSize: 3,
      revision: 9n
    }));
    const validateSessionMessageSearch = vi.fn(() => ({ query: "release plan", useSemantic: false }));
    const services = createConnectServices(stubApplication({
      connections: { authenticate },
      store: { searchSessionMessages, validateSessionMessageSearch }
    }));

    const response = await invoke(services.session.searchSessionMessages, {
      scope: { case: "owner", value: { $typeName: "joko.v1.OwnerSessionMessageSearchScope" } },
      query: "release plan",
      page: { pageSize: 1, pageToken: "" },
      filters: {
        targetIds: { values: ["target-search"] },
        sessionIds: { values: ["session-search"] },
        backendIds: { values: ["backend-search"] },
        sessionStatus: contract.SessionMessageSearchSessionStatus.ARCHIVED,
        sessionActivityFrom: { seconds: 12n, nanos: 345_000_000 },
        messageCreatedFrom: { seconds: 10n, nanos: 0 },
        messageCreatedBefore: { seconds: 20n, nanos: 0 }
      }
    }, context()) as contract.SearchSessionMessagesResponse;

    expect(authenticate).toHaveBeenCalledOnce();
    expect(searchSessionMessages).toHaveBeenCalledExactlyOnceWith({
      scope: { owner: true },
      query: "release plan",
      filters: {
        targetIds: ["target-search"],
        sessionIds: ["session-search"],
        backendIds: ["backend-search"],
        sessionStatus: "archived",
        sessionActivityFrom: 12_345,
        messageCreatedFrom: 10_000,
        messageCreatedBefore: 20_000
      },
      limit: 1,
      semanticSkipReason: "Semantic retrieval is unavailable on this Orchestrator node; keyword search was used."
    });
    expect(response.matches).toEqual([expect.objectContaining({
      sessionId: "session-search",
      eventId: "event-search",
      timelineItemId: "entry-search",
      role: contract.SessionMessageSearchRole.ASSISTANT,
      kind: contract.SessionMessageSearchKind.TEXT_MESSAGE,
      snippet: "可见的 release plan",
      score: 0.75
    })]);
    expect(response.page).toMatchObject({ nextPageToken: "next-message-page", totalSize: 3n });
    expect(response.revision?.value).toBe(9n);

    await expect(invoke(services.session.searchSessionMessages, {
      scope: { case: undefined },
      query: "release plan"
    }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });
  });

  it("validates and redacts message-search input before semantic Provider dispatch", async () => {
    const embedQuery = vi.fn(async (query: string) => {
      expect(query).toBe("find [REDACTED] now");
      return { skipReason: "keyword fallback" };
    });
    const validateSessionMessageSearch = vi.fn((input: { readonly query: string }) => {
      if (input.query.length > 256) throw new StoreError("Message search query exceeds 256 characters.");
      return { query: "find [REDACTED] now", useSemantic: true };
    });
    const searchSessionMessages = vi.fn(() => ({
      matches: [],
      totalSize: 0,
      revision: 1n,
      vectorUsed: false,
      poolCapped: false
    }));
    const services = createConnectServices(stubApplication({
      connections: { authenticate: () => ({ id: "connection-search-order", authKeyDigest: "digest", state: "active" }) },
      store: { validateSessionMessageSearch, searchSessionMessages },
      messageSearch: {
        status: () => ({
          enabled: true,
          vectorAvailable: true,
          providerId: "embedding-provider",
          providerGenerationId: "embedding-generation-1",
          modelId: "voyage/voyage-4",
          dimensions: 1024,
          pendingCount: 0,
          runningCount: 0,
          doneCount: 1,
          failedCount: 0
        }),
        embedQuery
      }
    }));

    await invoke(services.session.searchSessionMessages, {
      scope: { case: "owner", value: { $typeName: "joko.v1.OwnerSessionMessageSearchScope" } },
      query: "find sk-abcdefghijklmnop now",
      semanticMode: contract.SessionMessageSearchSemanticMode.HYBRID
    }, context());
    expect(embedQuery).toHaveBeenCalledOnce();
    expect(searchSessionMessages).toHaveBeenCalledWith(expect.objectContaining({
      query: "find [REDACTED] now",
      retrievalProviderId: "embedding-provider",
      retrievalProviderGenerationId: "embedding-generation-1",
      retrievalModelId: "voyage/voyage-4"
    }));

    await expect(invoke(services.session.searchSessionMessages, {
      scope: { case: "owner", value: { $typeName: "joko.v1.OwnerSessionMessageSearchScope" } },
      query: "x".repeat(257),
      semanticMode: contract.SessionMessageSearchSemanticMode.HYBRID
    }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });

    await expect(invoke(services.session.searchSessionMessages, {
      scope: { case: "owner", value: { $typeName: "joko.v1.OwnerSessionMessageSearchScope" } },
      query: "valid",
      semanticMode: 999 as contract.SessionMessageSearchSemanticMode
    }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });

    await expect(invoke(services.session.searchSessionMessages, {
      scope: { case: "owner", value: { $typeName: "joko.v1.OwnerSessionMessageSearchScope" } },
      query: "valid",
      semanticMode: contract.SessionMessageSearchSemanticMode.HYBRID,
      filters: { sessionStatus: 999 as contract.SessionMessageSearchSessionStatus }
    }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(invoke(services.session.searchSessionMessages, {
      scope: { case: "owner", value: { $typeName: "joko.v1.OwnerSessionMessageSearchScope" } },
      query: "valid",
      semanticMode: contract.SessionMessageSearchSemanticMode.HYBRID,
      filters: { sessionActivityFrom: { seconds: 1n, nanos: 1_000_000_000 } }
    }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(embedQuery).toHaveBeenCalledOnce();
  });

  it("loads a stable timeline window around a durable Event ID", async () => {
    const events = Array.from({ length: 7 }, (_, index) => persistedStatus(BigInt(index + 1)));
    const services = createConnectServices(stubApplication({
      connections: { authenticate: () => ({ id: "connection-around", authKeyDigest: "digest", state: "active" }) },
      store: {
        listEvents: (query: TestEventQuery) => syntheticEventPage(events.length, query),
        listEventsAround: (_sessionId: string, eventId: string, limit: number) => {
          const center = events.findIndex((event) => event.id === eventId);
          if (center < 0) throw new NotFoundError("Event", eventId);
          const before = Math.floor((limit - 1) / 2);
          let start = Math.max(0, center - before);
          const end = Math.min(events.length, start + limit);
          start = Math.max(0, end - limit);
          return events.slice(start, end);
        },
        health: () => ({ globalCursor: 7n }),
        getSession: () => { throw new NotFoundError("Session", "session-fence"); },
        getTarget: () => { throw new NotFoundError("Target", "target-fence"); }
      }
    }));

    const response = await invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: undefined,
      limit: 3,
      aroundEventId: "event-4"
    }, context()) as contract.ListSessionTimelineResponse;
    expect(response.events.map((event) => event.eventId)).toEqual(["event-3", "event-4", "event-5"]);
    expect(response.nextBeforeCursor).toBeUndefined();

    const latest = await invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: undefined,
      limit: 2,
      aroundEventId: ""
    }, context()) as contract.ListSessionTimelineResponse;
    expect(latest.events.map((event) => event.eventId)).toEqual(["event-6", "event-7"]);
    expect(latest.nextBeforeCursor).toBeDefined();
    const preceding = await invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: latest.nextBeforeCursor,
      limit: 2,
      aroundEventId: ""
    }, context()) as contract.ListSessionTimelineResponse;
    expect(preceding.events.map((event) => event.eventId)).toEqual(["event-4", "event-5"]);

    await expect(invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: {},
      limit: 3,
      aroundEventId: "event-4"
    }, context())).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: undefined,
      limit: 3,
      aroundEventId: "event-missing"
    }, context())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("keeps the newest timeline Event reachable across the exact Store page boundary", async () => {
    let total = 100_000;
    const queries: TestEventQuery[] = [];
    const services = createConnectServices(stubApplication({
      connections: { authenticate: () => ({ id: "connection-latest", authKeyDigest: "digest", state: "active" }) },
      store: {
        listEvents: (query: TestEventQuery) => {
          queries.push(query);
          return syntheticEventPage(total, query);
        },
        health: () => ({ globalCursor: BigInt(total) }),
        getSession: () => { throw new NotFoundError("Session", "session-fence"); },
        getTarget: () => { throw new NotFoundError("Target", "target-fence"); }
      }
    }));
    const latest = async () => invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: undefined,
      limit: 1,
      aroundEventId: ""
    }, context()) as Promise<contract.ListSessionTimelineResponse>;

    expect((await latest()).events.map((event) => event.eventId)).toEqual(["event-100000"]);
    total = 100_001;
    const newest = await latest();
    expect(newest.events.map((event) => event.eventId)).toEqual(["event-100001"]);
    const preceding = await invoke(services.session.listSessionTimeline, {
      sessionId: "session-fence",
      beforeCursor: newest.nextBeforeCursor,
      limit: 1,
      aroundEventId: ""
    }, context()) as contract.ListSessionTimelineResponse;
    expect(preceding.events.map((event) => event.eventId)).toEqual(["event-100000"]);
    expect(new Set([...newest.events, ...preceding.events].map((event) => event.eventId)).size).toBe(2);
    expect(queries.slice(-2)).toMatchObject([
      { order: "desc", limit: 2 },
      { order: "desc", limit: 2, beforeCursor: 100_001n }
    ]);
  });

  it("counts Session statistics across 100001 Events and more than 100000 Runs", async () => {
    const eventQueries: TestEventQuery[] = [];
    const durationQueries: Array<{ readonly sessionId?: string }> = [];
    const statisticEvent = (cursor: bigint): PersistedEvent => {
      const base = persistedStatus(cursor);
      const remainder = cursor % 3n;
      return {
        ...base,
        sessionId: "session-statistics-boundary",
        payload: remainder === 1n
          ? { type: "message_complete", role: "assistant", blocks: [] }
          : remainder === 2n
            ? { type: "done", outcome: "completed" }
            : { type: "compaction", compactionId: `compaction-${cursor}`, state: "completed", reason: "manual" }
      };
    };
    const services = createConnectServices(stubApplication({
      connections: { authenticate: () => ({ id: "connection-statistics", authKeyDigest: "digest", state: "active" }) },
      store: {
        getSession: () => ({ descriptor: { id: "session-statistics-boundary" } }),
        findSetting: () => undefined,
        listEvents: (query: TestEventQuery) => {
          eventQueries.push(query);
          return syntheticEventPage(100_001, query, statisticEvent);
        },
        sumRunActiveDuration: (query: { readonly sessionId?: string }) => {
          durationQueries.push(query);
          return 100_001;
        }
      },
      sessionHost: { getTree: async () => ({ roots: [] }) }
    }));

    const response = await invoke(services.session.getSessionStatistics, {
      sessionId: "session-statistics-boundary"
    }, context()) as contract.GetSessionStatisticsResponse;
    expect(response.statistics).toMatchObject({
      messageCount: 33_334n,
      turnCount: 33_334n,
      compactionCount: 33_333n,
      activeDuration: { seconds: 100n, nanos: 1_000_000 }
    });
    expect(eventQueries).toMatchObject([
      { order: "asc", limit: 100_000 },
      { order: "asc", limit: 100_000, afterCursor: 100_000n }
    ]);
    expect(durationQueries).toEqual([{ sessionId: "session-statistics-boundary" }]);
  });

  it("emits a snapshot resume cursor that EventService accepts without a generation reset", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-cursor-audit-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const authenticated = {
      id: "connection-audit",
      name: "Audit",
      authKeyDigest: "digest",
      state: "active" as const,
      pairedAt: 1,
      revision: 1n
    };
    const services = createConnectServices(stubApplication({
      store,
      connections: {
        authenticate: () => authenticated,
        fence: () => authenticated,
        onRevoked: () => () => undefined
      }
    }));
    const snapshotResponse = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    const resumeCursor = snapshotResponse.snapshot?.resumeCursor;
    expect(resumeCursor).toBeDefined();

    const controller = new AbortController();
    controller.abort();
    const streamResult = await invoke(
      services.event.streamEvents,
      { afterCursor: resumeCursor, scope: undefined },
      context(controller.signal)
    ) as IteratorResult<unknown>;

    expect(streamResult.done).toBe(true);
  });

  it("returns the durable Snapshot before a remote code-host refresh settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-code-host-background-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "backend-code-host",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Code host fixture",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    store.upsertTarget({
      id: "target-code-host",
      backendId: "backend-code-host",
      displayName: "Workspace",
      workspaceRoot: "D:/workspace",
      managed: false,
      trusted: true
    });
    store.createSession({
      id: "session-code-host",
      backendId: "backend-code-host",
      targetId: "target-code-host",
      title: "Review https://github.com/acme/widgets/pull/42",
      binding: { opaqueRef: "opaque:code-host", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    let release: (() => void) | undefined;
    const provider: CodeHostProvider = {
      capability: "code-host.pull-request",
      supports: (reference) => reference.host === "github.com",
      getPullRequest: vi.fn<CodeHostProvider["getPullRequest"]>(() => new Promise((resolve) => {
        release = () => resolve({
          state: "open",
          draft: false,
          title: "Background refresh",
          headBranch: "feature/background-refresh",
          unresolvedReviewThreadCount: 2
        });
      }))
    };
    const authenticated = {
      id: "connection-code-host",
      name: "Code host",
      authKeyDigest: "digest",
      state: "active" as const,
      pairedAt: 1,
      revision: 1n
    };
    const services = createConnectServices(stubApplication({
      store,
      codeHostProviders: [provider],
      connections: {
        authenticate: () => authenticated,
        fence: () => authenticated,
        onRevoked: () => () => undefined
      }
    }));

    const snapshot = invoke(services.event.getSnapshot, {}, context());
    const outcome = await Promise.race([
      snapshot.then((value) => ({ kind: "snapshot" as const, value })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500))
    ]);
    expect(outcome.kind).toBe("snapshot");
    await vi.waitFor(() => expect(provider.getPullRequest).toHaveBeenCalledOnce());
    release?.();
    await vi.waitFor(() => expect(store.findSetting(
      "session",
      "session-code-host",
      "codeHost.pullRequests.v1"
    )?.value).toMatchObject({
      references: [{ projection: { state: "open", unresolvedReviewThreadCount: 2 } }]
    }));
    await Promise.all(Array.from({ length: 20 }, () => invoke(services.event.getSnapshot, {}, context())));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(provider.getPullRequest).toHaveBeenCalledOnce();
  });

  it("applies injected context defaults to a capability-compatible non-specialized Backend", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-context-defaults-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "backend-context-policy",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Context Backend",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map([["context.automatic_policy", {
        key: "context.automatic_policy",
        supported: true
      }]]),
      models: [],
      tools: [],
      diagnostics: []
    });
    store.upsertTarget({
      id: "target-context-policy",
      backendId: "backend-context-policy",
      displayName: "Workspace",
      workspaceRoot: "D:/workspace",
      managed: false,
      trusted: true
    });
    store.createSession({
      id: "session-context-policy",
      backendId: "backend-context-policy",
      targetId: "target-context-policy",
      title: "Context policy",
      binding: { opaqueRef: "opaque:context-policy", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    const authenticated = {
      id: "connection-context-policy",
      name: "Context policy",
      authKeyDigest: "digest",
      state: "active" as const,
      pairedAt: 1,
      revision: 1n
    };
    const resolveSessionContextDefaults = vi.fn(() => ({
      autoCompaction: false,
      autoRetry: true
    }));
    const services = createConnectServices(stubApplication({
      store,
      resolveSessionContextDefaults,
      connections: {
        authenticate: () => authenticated,
        fence: () => authenticated,
        onRevoked: () => () => undefined
      }
    }));

    const response = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    const session = response.snapshot?.sessions.find((candidate) => candidate.sessionId === "session-context-policy");
    expect(session?.contextState).toMatchObject({ autoCompaction: false, autoRetry: true });
    expect(response.snapshot?.pi).toBeUndefined();
    expect(resolveSessionContextDefaults).toHaveBeenCalledWith({
      sessionId: "session-context-policy",
      backendId: "backend-context-policy",
      targetId: "target-context-policy"
    });
  });

  it("keeps session_changed projections authoritative across title updates and clears retired runtime state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-session-change-context-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "backend-session-change",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Session change Backend",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    store.upsertTarget({
      id: "target-session-change",
      backendId: "backend-session-change",
      displayName: "Workspace",
      workspaceRoot: "D:/workspace",
      managed: false,
      trusted: true
    });
    store.createSession({
      id: "session-change-context",
      backendId: "backend-session-change",
      targetId: "target-session-change",
      title: "Original",
      binding: { opaqueRef: "opaque:session-change", generation: 4 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    store.createRun({
      id: "run-session-change",
      sessionId: "session-change-context",
      source: "user",
      state: "running",
      createdAt: 10,
      startedAt: 10
    });
    store.setSetting("session", "session-change-context", SESSION_RUNTIME_STATE_SETTING_KEY, {
      usage: {
        inputTokens: 80,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        totalTokens: 127,
        contextTokens: 120,
        contextWindow: 1_000,
        cost: 0.01
      },
      activeNativeEntryId: "leaf-current",
      updatedAt: 20
    });
    store.setSetting(
      "session",
      "session-change-context",
      SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY,
      nativeStateObservation({
        binding: { opaqueRef: "opaque:session-change", generation: 4 },
        streaming: false,
        compacting: true,
        pendingMessages: 0,
        fastMode: false,
        permissionMode: "ask",
        autoCompaction: true
      }, undefined, 20)
    );
    let defaults: { readonly autoCompaction?: boolean; readonly autoRetry?: boolean } | undefined = {
      autoCompaction: false,
      autoRetry: true
    };
    const authenticated = {
      id: "connection-session-change",
      name: "Session change",
      authKeyDigest: "digest",
      state: "active" as const,
      pairedAt: 1,
      revision: 1n
    };
    const services = createConnectServices(stubApplication({
      store,
      resolveSessionContextDefaults: () => defaults,
      connections: {
        authenticate: () => authenticated,
        fence: () => authenticated,
        onRevoked: () => () => undefined
      }
    }));

    const initial = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    const initialSession = initial.snapshot?.sessions.find((candidate) => candidate.sessionId === "session-change-context");
    expect(initialSession).toMatchObject({
      displayName: "Original",
      state: contract.SessionState.RUNNING,
      nativeBinding: { runtimeAttached: true },
      activeNativeEntryId: "leaf-current",
      context: { usedTokens: 120n, contextWindowTokens: 1_000n },
      contextState: { compacting: true, autoCompaction: true, autoRetry: true }
    });

    store.updateSession("session-change-context", { title: "Renamed" }, undefined, 30);
    const retainedStream = (services.event.streamEvents as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<{ event?: contract.Event }>)({ afterCursor: initial.snapshot?.resumeCursor }, context());
    const retainedIterator = retainedStream[Symbol.asyncIterator]();
    const retained = await retainedIterator.next();
    await retainedIterator.return?.();
    expect(retained.value?.event?.payload?.kind).toMatchObject({
      case: "sessionChanged",
      value: { session: {
        displayName: "Renamed",
        state: contract.SessionState.RUNNING,
        nativeBinding: { runtimeAttached: true },
        activeNativeEntryId: "leaf-current",
        context: { usedTokens: 120n, contextWindowTokens: 1_000n },
        contextState: { compacting: true, autoCompaction: true, autoRetry: true }
      } }
    });

    store.setSetting("session", "session-change-context", SESSION_RUNTIME_STATE_SETTING_KEY, { updatedAt: 40 });
    store.setSetting(
      "session",
      "session-change-context",
      SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY,
      nativeStateObservation({
        binding: { opaqueRef: "opaque:session-change", generation: 4 },
        streaming: false,
        compacting: false,
        pendingMessages: 0,
        fastMode: false,
        permissionMode: "ask",
        autoCompaction: false,
        autoRetry: false
      }, undefined, 40)
    );
    defaults = { autoCompaction: false, autoRetry: false };
    store.updateRunState({
      runId: "run-session-change",
      state: "completed",
      endedAt: 40,
      traceId: "run-session-change:completed",
      suppressTerminalAttention: true
    });
    const beforeClearTitle = store.health().globalCursor;
    store.updateSession("session-change-context", { title: "Cleared" }, undefined, 50);
    const clearedStream = (services.event.streamEvents as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<{ event?: contract.Event }>)(
      {
        afterCursor: toProtoEventCursor(
          beforeClearTitle,
          initial.snapshot?.resumeCursor?.generation ?? 0n,
          50
        )
      },
      context()
    );
    const clearedIterator = clearedStream[Symbol.asyncIterator]();
    const cleared = await clearedIterator.next();
    await clearedIterator.return?.();
    const clearedSession = cleared.value?.event?.payload?.kind.case === "sessionChanged"
      ? cleared.value.event.payload.kind.value.session
      : undefined;
    expect(clearedSession).toMatchObject({
      displayName: "Cleared",
      state: contract.SessionState.IDLE,
      nativeBinding: { runtimeAttached: false },
      activeNativeEntryId: "",
      contextState: { compacting: false, autoCompaction: false, autoRetry: false }
    });
    expect(clearedSession?.context).toBeUndefined();
  });

  it("pages durable Pi history past 100000 Events and binds completeness to the current generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-pi-history-boundary-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "pi",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Pi",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    store.upsertTarget({
      id: "target-pi-history",
      backendId: "pi",
      displayName: "Workspace",
      workspaceRoot: "D:/workspace",
      managed: false,
      trusted: true
    });
    store.createSession({
      id: "session-pi-history",
      backendId: "pi",
      targetId: "target-pi-history",
      title: "History",
      binding: { opaqueRef: "opaque:pi-history", generation: 7 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    let markerGeneration = 7;
    const historyEvent = (cursor: bigint): PersistedEvent => {
      const base = {
        ...persistedStatus(cursor),
        backendId: "pi",
        targetId: "target-pi-history",
        sessionId: "session-pi-history",
        generation: 7
      };
      if (cursor === 1n) {
        return {
          ...base,
          generation: markerGeneration,
          payload: { type: "native_session_changed", opaqueRef: "opaque:pi-history", leafId: "native-entry-10000" }
        };
      }
      if (cursor === 89_999n || cursor === 90_000n) {
        const first = cursor === 89_999n;
        return {
          ...base,
          payload: { type: "status", key: "native-history-cycle", text: first ? "cycle a" : "cycle b" },
          pi: {
            rpcEventType: "message",
            entryId: first ? "cycle-a" : "cycle-b",
            parentEntryId: first ? "cycle-b" : "cycle-a",
            payload: { case: "diagnostic", value: {} }
          } as unknown as NonNullable<PersistedEvent["pi"]>,
          metadata: { namespace: "pi.native_history", fields: { nativeReference: "opaque:pi-history" } }
        };
      }
      if (cursor >= 90_001n) {
        const ordinal = Number(cursor - 90_001n);
        const entryId = `native-entry-${ordinal}`;
        return {
          ...base,
          payload: cursor === 100_001n
            ? { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "tail" }] }
            : { type: "status", key: "native-history", text: `entry ${ordinal}` },
          pi: {
            rpcEventType: "message",
            entryId,
            ...(ordinal === 0 ? {} : { parentEntryId: `native-entry-${ordinal - 1}` }),
            payload: { case: "diagnostic", value: {} }
          } as unknown as NonNullable<PersistedEvent["pi"]>,
          metadata: { namespace: "pi.native_history", fields: { nativeReference: "opaque:pi-history" } }
        };
      }
      return base;
    };
    const listEvents = vi.spyOn(store, "listEvents").mockImplementation((query = {}) =>
      syntheticEventPage(100_001, query, historyEvent)
    );
    const adapter = new PiBackendAdapter({
      agentHome: join(directory, "agent-home"),
      sessionRoot: join(directory, "sessions")
    });
    const authenticated = { id: "connection-pi-history", authKeyDigest: "digest", state: "active" as const };
    const services = createConnectServices(stubApplication({
      store,
      adapters: [adapter],
      connections: {
        authenticate: () => authenticated,
        fence: () => authenticated,
        onRevoked: () => () => undefined
      },
      sessionHost: { listNativeSessions: async () => [] }
    }));
    const snapshotSession = async () => {
      const response = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
      return response.snapshot?.pi?.sessions.find((session) => session.productSessionId === "session-pi-history");
    };

    try {
      const complete = await snapshotSession();
      expect(complete).toMatchObject({
        messages: [expect.objectContaining({ nativeEntryId: "native-entry-10000" })],
        messagesComplete: true,
        entriesComplete: true
      });
      expect(complete?.entries).toHaveLength(10_003);
      expect(complete?.entries.slice(0, 2).map((entry) => entry.entryId)).toEqual(["cycle-a", "cycle-b"]);
      const completeTreeRoots = contract.piSessionTreeRoots(complete!.sessionTree!);
      expect(piContractTreeDepth(completeTreeRoots[0])).toBe(10_001);
      expect(completeTreeRoots[1]).toMatchObject({
        entryId: "cycle-a",
        children: [expect.objectContaining({ entryId: "cycle-b", children: [] })]
      });
      expect(listEvents.mock.calls.map(([query]) => query).filter((query) => query?.order === "asc")).toEqual([
        { sessionId: "session-pi-history", order: "asc", limit: 100_000 },
        { sessionId: "session-pi-history", afterCursor: 100_000n, order: "asc", limit: 100_000 }
      ]);

      markerGeneration = 6;
      listEvents.mockClear();
      const staleMarker = await snapshotSession();
      expect(staleMarker).toMatchObject({
        messages: [expect.objectContaining({ nativeEntryId: "native-entry-10000" })],
        messagesComplete: false,
        entriesComplete: false
      });
    } finally {
      await adapter.dispose();
    }
  });

  it("returns an active background fence on fresh connect and resumes with its terminal edge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-background-snapshot-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.upsertBackend({
      id: "pi",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Pi",
      version: "test",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    store.upsertTarget({
      id: "target-background",
      backendId: "pi",
      displayName: "Workspace",
      workspaceRoot: "D:/workspace",
      managed: false,
      trusted: true
    });
    store.createSession({
      id: "session-background",
      backendId: "pi",
      targetId: "target-background",
      title: "Background Session",
      binding: { opaqueRef: "opaque:background", generation: 3 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    const running = store.appendEvent({
      backendId: "pi",
      targetId: "target-background",
      sessionId: "session-background",
      generation: 3,
      traceId: "background:running",
      payload: {
        type: "background_task",
        taskId: "subagent-a",
        parentTaskId: "batch-a",
        title: "private title",
        state: "running",
        detail: "private status",
        progressRatio: 0.25,
        startedAt: 1_000
      }
    });
    const authenticated = { id: "connection", authKeyDigest: "digest", state: "active" as const };
    const services = createConnectServices(stubApplication({
      store,
      connections: {
        authenticate: () => authenticated,
        fence: () => authenticated,
        onRevoked: () => () => undefined
      }
    }));

    const initial = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    expect(initial.snapshot?.resumeCursor?.sequence).toBe(running.globalCursor);
    expect(initial.snapshot?.backgroundTasks).toEqual([expect.objectContaining({
      backgroundTaskId: "subagent-a",
      parentTaskId: "batch-a",
      sessionId: "session-background",
      state: contract.BackgroundTaskState.RUNNING,
      progressRatio: 0.25,
      startedAt: toProtoTimestamp(1_000),
      displayName: "",
      statusText: ""
    })]);

    const completed = store.appendEvent({
      backendId: "pi",
      targetId: "target-background",
      sessionId: "session-background",
      generation: 3,
      traceId: "background:completed",
      payload: {
        type: "background_task",
        taskId: "subagent-a",
        parentTaskId: "batch-a",
        title: "Subagent",
        state: "completed",
        progressRatio: 1,
        startedAt: 1_000,
        endedAt: 2_000
      }
    });
    const stream = (services.event.streamEvents as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<{ event?: contract.Event }>)({ afterCursor: initial.snapshot?.resumeCursor }, context());
    const iterator = stream[Symbol.asyncIterator]();
    const terminal = await iterator.next();
    expect(terminal.value?.event).toMatchObject({
      cursor: { sequence: completed.globalCursor },
      payload: { kind: { case: "backgroundTaskChanged", value: {
        backgroundTask: {
          backgroundTaskId: "subagent-a",
          parentTaskId: "batch-a",
          state: contract.BackgroundTaskState.SUCCEEDED,
          progressRatio: 1,
          startedAt: toProtoTimestamp(1_000),
          endedAt: toProtoTimestamp(2_000)
        }
      } } }
    });
    await iterator.return?.();

    const reconnect = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    expect(reconnect.snapshot?.resumeCursor?.sequence).toBe(completed.globalCursor);
    expect(reconnect.snapshot?.backgroundTasks).toEqual([]);
  });

  it("re-samples content-free runtime activity around independent coordinator probes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-runtime-activity-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const authenticated = {
      id: "connection-runtime-activity",
      name: "Runtime activity",
      authKeyDigest: "digest",
      state: "active" as const,
      pairedAt: 1,
      revision: 1n
    };
    const inspectRuntimeActivity = vi.fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["user_shell"]);
    const markBlockingActivity = vi.fn();
    const services = createConnectServices(stubApplication({
      store,
      connections: { authenticate: () => authenticated },
      sessionHost: { inspectRuntimeActivity },
      runtimeActivity: {
        markBlockingActivity,
        lastBlockingActivityAt: () => 42_000,
        close: () => undefined
      },
      scheduler: { hasInFlightActivity: () => false },
      reviewCoordinator: { hasInFlightActivity: () => false },
      browserTransfers: { hasInFlightActivity: () => true }
    }));

    const response = await invoke(services.event.getRuntimeActivity, {}, context()) as {
      summary?: contract.RuntimeActivitySummary;
    };
    expect(inspectRuntimeActivity).toHaveBeenCalledTimes(2);
    expect(markBlockingActivity).toHaveBeenCalledOnce();
    expect(response.summary).toMatchObject({
      blocksShutdown: true,
      blockingKinds: [
        contract.RuntimeActivityKind.USER_SHELL,
        contract.RuntimeActivityKind.BROWSER_TRANSFER
      ]
    });
    expect(response.summary?.revision?.value).toBe(store.health().revision);
    expect(response.summary?.cursor?.sequence).toBe(store.health().globalCursor);
    expect(response.summary?.observedAt).toBeDefined();
    expect(response.summary?.lastBlockingActivityAt).toEqual(toProtoTimestamp(42_000));
  });

  it("serializes an owner snapshot with authoritative provisioning and Browser state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-owner-snapshot-audit-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    store.createConnection({
      id: "connection-owner",
      name: "Owner desktop",
      authKeyDigest: "digest",
      pairedAt: 1
    });
    store.upsertBackend({
      id: "pi",
      adapterKind: "fixture",
      instanceGeneration: 0,
      displayName: "Pi",
      version: "latest-installed",
      health: "healthy",
      installationState: "installed",
      authenticationState: "authenticated",
      capabilities: new Map(),
      models: [{
        providerId: "provider-signed-out",
        modelId: "model-a",
        displayName: "Model A",
        api: "openai-responses",
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        supportsImages: true,
        thinkingLevels: ["medium"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }],
      tools: [{
        toolId: "read",
        name: "read",
        displayName: "Read",
        description: "Read a file from the authorized workspace.",
        inputSchema: {
          fields: [{
            fieldPath: "path",
            title: "Path",
            description: "Workspace-relative path.",
            type: "string",
            required: true,
            secret: false,
            enumValues: [],
            constraints: { minimumLength: 1 }
          }],
          allowsAdditionalFields: false
        },
        requiresPermission: false,
        streamingUpdates: false,
        enabled: true
      }],
      diagnostics: []
    });
    const provider = {
      provider: {
        id: "provider-signed-out",
        api: "openai-responses",
        models: []
      },
      displayName: "Signed-out Provider",
      kind: "oauth",
      credentialReferenceIds: [],
      enabled: true,
      supportsLogin: true,
      supportsLogout: true,
      supportsRefresh: true,
      authenticationState: "signed_out",
      version: 2n,
      updatedAt: 2
    };
    store.setSetting("service", "orchestrator", providerRateLimitSettingKey("pi", "provider-signed-out"), {
      limited: true,
      resetsAt: 4_100_000_000_000,
      requestLimit: 100,
      requestsRemaining: 3,
      tokenLimit: "10000",
      tokensRemaining: "250"
    });
    const screenshot = {
      browserProviderId: "browser",
      pageId: "page-owner",
      generation: 7,
      artifactId: "artifact-owner",
      blob: {
        id: "artifact-owner",
        sha256: "b".repeat(64),
        byteLength: 12,
        mimeType: "image/png",
        fileName: "owner.png"
      },
      capturedAt: 3
    };
    const transfer = create(contract.BrowserTransferSchema, {
      browserTransferId: "transfer-owner",
      browserProviderId: "browser",
      pageId: "page-owner",
      direction: contract.TransferDirection.DOWNLOAD,
      state: contract.BrowserTransferState.COMPLETED
    });
    const browser = {
      id: "browser",
      running: true,
      generation: 7,
      listPages: async () => [{ id: "page-owner", title: "Owner page", url: "https://example.test/", state: "ready" }],
      currentHumanTakeover: () => undefined
    };
    const services = createConnectServices(stubApplication({
      store,
      connections: { authenticate: () => ({ id: "connection-owner", authKeyDigest: "digest", state: "active" }) },
      providers: { list: () => [provider] },
      credentials: { list: () => [] },
      mcpRouter: { list: () => [] },
      piResources: {
        list: () => [{
          id: "resource-owner",
          backendId: "pi",
          kind: "skill",
          scope: "managed",
          name: "Owner skill",
          sourceKind: "local",
          sourceIdentity: "skill:owner",
          sourceDisplay: "managed/owner-skill",
          canonicalPathFingerprint: "fingerprint",
          symbolicLinkDetected: false,
          specialFileDetected: false,
          discoveredRevision: "revision",
          resourceDetails: [{
            kind: "skill",
            name: "Owner skill",
            compatibility: "supported",
            compatibilityIssues: [],
            detectedApis: [],
            adaptedApis: [],
            unsupportedApis: []
          }],
          runtimeRequirements: [{
            packageName: "@earendil-works/pi-coding-agent",
            range: "^0.84.0",
            currentVersion: "0.84.2",
            compatible: true
          }],
          warnings: ["lifecycle-scripts-disabled"],
          disabledLifecycleScripts: ["postinstall"],
          canToggle: true,
          requiresExtensionApproval: false,
          postMutationNotice: true,
          state: "loaded",
          enabled: true,
          versionNumber: 1n,
          updatedAt: 4
        }]
      },
      browser,
      browserState: {
        findScreenshot: () => screenshot,
        findRecoverablePage: () => ({
          browserProviderId: "browser",
          pageId: "page-owner",
          generation: 7,
          sessionId: "session-owner",
          targetId: "target-owner",
          bindingGeneration: 1,
          url: "https://example.test/",
          title: "Owner page",
          state: "open" as const,
          updatedAt: 3
        })
      },
      browserTransfers: { list: () => [transfer] }
    }));

    const response = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    const wire = fromBinary(contract.SnapshotSchema, toBinary(contract.SnapshotSchema, response.snapshot!));

    expect(wire.devices.map((device) => device.deviceId)).toContain("connection-owner");
    expect(wire.providers[0]).toMatchObject({
      backendId: "pi",
      providerId: "provider-signed-out",
      authenticationState: contract.AuthenticationState.AUTHENTICATED
    });
    expect(wire.providers[0]?.rateLimit).toBeUndefined();
    expect(wire.providers[0]?.usage).toBeUndefined();
    expect(wire.models[0]).toMatchObject({ backendId: "pi", available: true });
    expect(wire.toolProviders.find((item) => item.toolProviderId === "backend:pi")?.tools[0]).toMatchObject({
      toolId: "backend:pi:read",
      name: "read",
      requiresPermission: false,
      enabled: true
    });
    expect(wire.toolProviders.find((item) => item.toolProviderId === "browser")?.tools.length).toBeGreaterThan(0);
    expect(wire.browsers[0]?.pages[0]?.latestScreenshot?.blob?.blobId).toBe("artifact-owner");
    expect(wire.resources[0]).toMatchObject({
      resourceId: "resource-owner",
      state: contract.ResourceState.LOADED,
      discoveredRevision: "revision",
      compatibilityDetails: [{ compatibility: contract.ResourceCompatibility.SUPPORTED }],
      runtimeRequirements: [{ status: contract.ResourceRuntimeRequirementStatus.COMPATIBLE }],
      warnings: [contract.ResourcePackageWarning.LIFECYCLE_SCRIPTS_DISABLED],
      disabledLifecycleScripts: ["postinstall"],
      canToggle: true,
      postMutationNotice: true
    });
    expect(wire.browserTransfers[0]?.browserTransferId).toBe("transfer-owner");
    expect(wire.settings?.providers[0]?.providerId).toBe("provider-signed-out");
  });

  it("pages to a durable high-water cursor and deduplicates overlapping subscription events", async () => {
    const events = Array.from({ length: 1_005 }, (_, index): PersistedEvent => {
      const sequence = BigInt(index + 1);
      return {
        id: `event-${sequence}`,
        globalCursor: sequence,
        sequence,
        revision: sequence,
        emittedAt: index + 1,
        backendId: "pi",
        targetId: "target-audit",
        sessionId: "session-audit",
        generation: 1,
        traceId: `trace-${sequence}`,
        payload: { type: "status", key: `status-${sequence}` }
      };
    });
    let subscriber: ((event: PersistedEvent) => void) | undefined;
    let publishedOverlap = false;
    const listAfter: bigint[] = [];
    const store = {
      subscribe(listener: (event: PersistedEvent) => void) {
        subscriber = listener;
        return () => { subscriber = undefined; };
      },
      health() {
        if (!publishedOverlap) {
          publishedOverlap = true;
          subscriber?.(events.at(-2)!);
          subscriber?.(events.at(-1)!);
        }
        return { schemaVersion: 1, journalMode: "wal", foreignKeys: true, revision: 1n, globalCursor: 1_005n };
      },
      listEvents(query: { afterCursor?: bigint; limit?: number }) {
        const after = query.afterCursor ?? 0n;
        listAfter.push(after);
        return events.filter((event) => event.globalCursor > after).slice(0, query.limit);
      },
      getSession() { throw new Error("Historical test event"); },
      getTarget() { throw new Error("Historical test event"); }
    };
    const services = createConnectServices(stubApplication({
      store,
      connections: {
        authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }),
        fence: (value: unknown) => value,
        onRevoked: () => () => undefined
      }
    }));
    const controller = new AbortController();
    const stream = (services.event.streamEvents as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<{ event?: contract.Event }>)({}, context(controller.signal));
    const iterator = stream[Symbol.asyncIterator]();
    const received: bigint[] = [];

    for (let index = 0; index < events.length; index += 1) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      received.push(next.value?.event?.cursor?.sequence ?? -1n);
    }
    const exhausted = iterator.next();
    controller.abort();

    expect((await exhausted).done).toBe(true);
    expect(received).toEqual(events.map((event) => event.globalCursor));
    expect(listAfter).toEqual([0n, 1_000n]);
  });

  it("rejects a cursor ahead of the durable high-water mark", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-future-cursor-audit-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const services = createConnectServices(stubApplication({
      store,
      connections: {
        authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }),
        fence: (value: unknown) => value,
        onRevoked: () => () => undefined
      }
    }));
    const snapshotResponse = await invoke(services.event.getSnapshot, {}, context()) as { snapshot?: contract.Snapshot };
    const resumeCursor = snapshotResponse.snapshot?.resumeCursor;
    expect(resumeCursor).toBeDefined();
    const futureCursor = toProtoEventCursor(1n, resumeCursor!.generation, Date.now());

    await expect(invoke(
      services.event.streamEvents,
      { afterCursor: futureCursor, scope: undefined },
      context()
    )).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });

  it("fences a StreamEvents page after revocation and never touches authorization at yield time", async () => {
    const connections = revocableConnections();
    const event = persistedStatus();
    const store = {
      subscribe: () => () => undefined,
      health: () => ({ globalCursor: 1n }),
      listEvents: () => {
        connections.revoke();
        return [event];
      }
    };
    const services = createConnectServices(stubApplication({ store, connections }));
    const stream = (services.event.streamEvents as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<unknown>)({}, context());

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "AUTH_REVOKED" });
    expect(connections.authenticate).toHaveBeenCalledOnce();
    expect(connections.fence).toHaveBeenCalledOnce();
    expect(connections.touches()).toBe(1);
  });

  it("closes waiting StreamEvents and WatchOperation iterators immediately when their Connection is revoked", async () => {
    const streamConnections = revocableConnections();
    let streamSubscriber: ((event: PersistedEvent) => void) | undefined;
    const streamServices = createConnectServices(stubApplication({
      connections: streamConnections,
      store: {
        subscribe: (listener: (event: PersistedEvent) => void) => {
          streamSubscriber = listener;
          return () => { streamSubscriber = undefined; };
        },
        health: () => ({ globalCursor: 0n }),
        listEvents: () => []
      }
    }));
    const stream = (streamServices.event.streamEvents as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<unknown>)({}, context());
    const streamNext = stream[Symbol.asyncIterator]().next();
    await Promise.resolve();
    streamConnections.revoke();
    expect(await streamNext).toMatchObject({ done: true });
    expect(streamSubscriber).toBeUndefined();

    const watchConnections = revocableConnections();
    const operationRecord = {
      id: "operation-watch-fence",
      connectionId: watchConnections.authenticated.id,
      kind: "historical",
      body: {},
      bodyHash: operationBodyHash({}),
      completionMode: "transactional" as const,
      status: "started" as const,
      createdAt: 1,
      updatedAt: 1,
      revision: 1n
    };
    let operationSubscriber: ((event: PersistedEvent) => void) | undefined;
    let operationChangeSubscriber: ((operationId: string) => void) | undefined;
    const watchServices = createConnectServices(stubApplication({
      connections: watchConnections,
      store: {
        getOperation: () => operationRecord,
        getSession: () => { throw new Error("unused"); },
        getTarget: () => { throw new Error("unused"); },
        subscribe: (listener: (event: PersistedEvent) => void) => {
          operationSubscriber = listener;
          return () => { operationSubscriber = undefined; };
        },
        subscribeOperationChanges: (listener: (operationId: string) => void) => {
          operationChangeSubscriber = listener;
          return () => { operationChangeSubscriber = undefined; };
        }
      }
    }));
    const watch = (watchServices.operation.watchOperation as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<unknown>)({ operationId: operationRecord.id }, context());
    const iterator = watch[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: {
        operation: {
          state: contract.OperationState.RUNNING,
          result: undefined
        }
      }
    });
    const watchNext = iterator.next();
    await Promise.resolve();
    watchConnections.revoke();
    expect(await watchNext).toMatchObject({ done: true });
    expect(operationSubscriber).toBeUndefined();
    expect(operationChangeSubscriber).toBeUndefined();
    expect(watchConnections.touches()).toBe(1);
  });

  it("subscribes before the initial WatchOperation read so a terminal commit cannot be lost", async () => {
    const connections = revocableConnections();
    const started = {
      id: "operation-watch-no-gap",
      connectionId: connections.authenticated.id,
      kind: "historical",
      body: {},
      bodyHash: operationBodyHash({}),
      completionMode: "transactional" as const,
      status: "started" as const,
      createdAt: 1,
      updatedAt: 1,
      revision: 1n
    };
    const completed = {
      ...started,
      status: "completed" as const,
      response: { accepted: true, resultCase: "acknowledgement" },
      updatedAt: 2,
      revision: 2n
    };
    let current = started as typeof started | typeof completed;
    let subscriber: ((event: PersistedEvent) => void) | undefined;
    let operationChangeSubscriber: ((operationId: string) => void) | undefined;
    let deliveredDuringInitialRead = false;
    const services = createConnectServices(stubApplication({
      connections,
      store: {
        subscribe: (listener: (event: PersistedEvent) => void) => {
          subscriber = listener;
          return () => { subscriber = undefined; };
        },
        subscribeOperationChanges: (listener: (operationId: string) => void) => {
          operationChangeSubscriber = listener;
          return () => { operationChangeSubscriber = undefined; };
        },
        getOperation: () => {
          const value = current;
          if (current.status === "started") {
            current = completed;
            deliveredDuringInitialRead = subscriber !== undefined && operationChangeSubscriber !== undefined;
            operationChangeSubscriber?.(started.id);
          }
          return value;
        },
        getSession: () => { throw new Error("unused"); },
        getTarget: () => { throw new Error("unused"); }
      }
    }));
    const watch = (services.operation.watchOperation as unknown as (
      request: object,
      handlerContext: unknown
    ) => AsyncIterable<unknown>)({ operationId: started.id }, context());
    const iterator = watch[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { operation: { state: contract.OperationState.RUNNING, result: undefined } }
    });
    expect(deliveredDuringInitialRead).toBe(true);
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { operation: { state: contract.OperationState.SUCCEEDED } }
    });
    expect(await iterator.next()).toMatchObject({ done: true });
    expect(subscriber).toBeUndefined();
    expect(operationChangeSubscriber).toBeUndefined();
  });

  it("returns durable running and failed Operations for idempotent submit races instead of transport errors", async () => {
    const connections = revocableConnections();
    const mutation = create(contract.OperationMutationSchema, {
      payload: {
        case: "compactSession",
        value: { sessionId: "session-compact-failure", customInstructions: "" }
      }
    });
    const base = {
      id: "operation-compact-failure",
      connectionId: connections.authenticated.id,
      kind: "compactSession",
      body: mutation,
      bodyHash: operationBodyHash(mutation),
      completionMode: "external_effect" as const,
      createdAt: 1,
      updatedAt: 1,
      revision: 1n
    };
    const running = { ...base, status: "started" as const };
    const storedError = {
      code: "PI_RPC_REJECTED",
      message: "Compaction failed because the summarizer is unavailable.",
      phase: "dispatch",
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Retry after the summarizer recovers."
    };
    const failed = {
      ...base,
      status: "failed" as const,
      error: storedError,
      updatedAt: 2,
      revision: 2n
    };
    let record: typeof running | typeof failed | undefined = running;
    const mutate = vi.fn(async () => {
      record = failed;
      throw new OperationPreviouslyFailedError(base.id, storedError);
    });
    const services = createConnectServices(stubApplication({
      connections,
      sessionHost: { mutate },
      store: {
        findOperation: () => record,
        getOperation: () => record,
        getSession: () => { throw new Error("unused"); },
        getTarget: () => { throw new Error("unused"); }
      }
    }));
    const request = {
      operationId: base.id,
      connectionId: connections.authenticated.id,
      mutation
    };

    const initial = await invoke(services.operation.submitOperation, request, context()) as contract.SubmitOperationResponse;
    expect(initial.operation).toMatchObject({
      state: contract.OperationState.RUNNING,
      result: undefined
    });
    expect(mutate).not.toHaveBeenCalled();

    record = undefined;
    const failedResponse = await invoke(services.operation.submitOperation, request, context()) as contract.SubmitOperationResponse;
    expect(failedResponse.operation).toMatchObject({
      state: contract.OperationState.FAILED,
      error: { code: storedError.code, message: storedError.message }
    });
    expect(mutate).toHaveBeenCalledTimes(1);

    const replay = await invoke(services.operation.submitOperation, request, context()) as contract.SubmitOperationResponse;
    expect(replay.operation).toMatchObject({
      state: contract.OperationState.FAILED,
      error: { code: storedError.code, message: storedError.message }
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("maps a missing durable entity to NOT_FOUND instead of framework INTERNAL", async () => {
    const registrations = new Map<string, Record<string, unknown>>();
    const router = {
      service(descriptor: { typeName: string }, implementation: Record<string, unknown>) {
        registrations.set(descriptor.typeName, implementation);
      }
    } as unknown as ConnectRouter;
    registerConnectServices(router, stubApplication({
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) },
      store: { getOperation: () => { throw new NotFoundError("Operation", "missing"); } }
    }));

    const operationService = registrations.get("joko.v1.OperationService");
    await expect(invoke(operationService?.["getOperation"], { operationId: "missing" }, context()))
      .rejects.toMatchObject({ code: Code.NotFound });
  });

  it("hashes every public mutation field at the SubmitOperation idempotency boundary", async () => {
    const newStart = (parentNativeReference: string) => create(contract.NativeSessionStartSchema, {
      kind: { case: "newSession", value: create(contract.NewNativeSessionSchema, { parentNativeReference }) }
    });
    const mutation = <T extends contract.OperationMutation["payload"]>(payload: T) => create(contract.OperationMutationSchema, {
      preconditions: [],
      payload
    });
    const cases: Array<{ name: string; first: contract.OperationMutation; second: contract.OperationMutation }> = [
      {
        name: "create_session.backend_id",
        first: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi-a", targetId: "target", displayName: "Task", nativeStart: newStart(""), permissionMode: contract.PermissionMode.ASK, planMode: false
        }) }),
        second: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi-b", targetId: "target", displayName: "Task", nativeStart: newStart(""), permissionMode: contract.PermissionMode.ASK, planMode: false
        }) })
      },
      {
        name: "create_session.native_start",
        first: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi", targetId: "target", displayName: "Task", nativeStart: newStart("parent-a"), permissionMode: contract.PermissionMode.ASK, planMode: false
        }) }),
        second: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi", targetId: "target", displayName: "Task", nativeStart: newStart("parent-b"), permissionMode: contract.PermissionMode.ASK, planMode: false
        }) })
      },
      {
        name: "create_session.append_system_prompt",
        first: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi", targetId: "target", displayName: "Task", nativeStart: newStart(""), permissionMode: contract.PermissionMode.ASK, planMode: false,
          appendSystemPrompt: "Prefer concise replies."
        }) }),
        second: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi", targetId: "target", displayName: "Task", nativeStart: newStart(""), permissionMode: contract.PermissionMode.ASK, planMode: false,
          appendSystemPrompt: "Explain every step."
        }) })
      },
      {
        name: "create_session.initial_placement",
        first: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi", targetId: "target", displayName: "Task", nativeStart: newStart(""), permissionMode: contract.PermissionMode.ASK,
          initialPlacement: contract.NativeSessionPlacement.PROJECT
        }) }),
        second: mutation({ case: "createSession", value: create(contract.CreateSessionMutationSchema, {
          backendId: "pi", targetId: "target", displayName: "Task", nativeStart: newStart(""), permissionMode: contract.PermissionMode.ASK,
          initialPlacement: contract.NativeSessionPlacement.DIALOGUE
        }) })
      },
      {
        name: "send_input.overrides",
        first: mutation({ case: "sendInput", value: create(contract.SendInputMutationSchema, {
          sessionId: "session", deliveryMode: contract.QueueDeliveryMode.PROMPT,
          overrides: create(contract.PerTurnOverridesSchema, { permissionMode: contract.PermissionMode.ASK, extraDirectoryIds: [] })
        }) }),
        second: mutation({ case: "sendInput", value: create(contract.SendInputMutationSchema, {
          sessionId: "session", deliveryMode: contract.QueueDeliveryMode.PROMPT,
          overrides: create(contract.PerTurnOverridesSchema, { permissionMode: contract.PermissionMode.AUTO, extraDirectoryIds: [] })
        }) })
      },
      {
        name: "delete_target.delete_managed_workspace",
        first: mutation({ case: "deleteTarget", value: create(contract.DeleteTargetMutationSchema, {
          targetId: "target", deleteManagedWorkspace: false, deleteProductSessions: false
        }) }),
        second: mutation({ case: "deleteTarget", value: create(contract.DeleteTargetMutationSchema, {
          targetId: "target", deleteManagedWorkspace: true, deleteProductSessions: false
        }) })
      }
    ];

    for (const item of cases) {
      const services = createConnectServices(stubApplication({
        connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) },
        store: { findOperation: () => ({ connectionId: "connection", bodyHash: operationBodyHash(item.first) }) }
      }));
      await expect(invoke(
        services.operation.submitOperation,
        { operationId: `operation-${item.name}`, connectionId: "connection", mutation: item.second },
        context()
      ), item.name).rejects.toBeInstanceOf(OperationConflictError);
    }
  });

  it("does not publish a Target when adapter workspace validation fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-target-validation-audit-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const upsertTarget = vi.fn();
    const register = vi.fn();
    const mutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "createTarget", value: create(contract.CreateTargetMutationSchema, {
        backendId: "pi",
        displayName: "Unsafe target",
        workspace: create(contract.TargetWorkspaceInputSchema, {
          kind: contract.WorkspaceKind.USER_PROJECT,
          serverPath: directory,
          createIfMissing: false
        })
      }) }
    });
    const store = { findOperation: () => undefined, upsertTarget };
    const services = createConnectServices(stubApplication({
      store,
      workspaces: { register },
      sessionHost: {
        validateTarget: async () => { throw new Error("adapter rejected workspace"); },
        mutate: async (input: { effect?: () => Promise<void>; commit: (value: typeof store) => unknown }) => {
          await input.effect?.();
          return { replayed: false, value: input.commit(store), operation: {} };
        }
      },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-invalid-target",
      connectionId: "connection",
      mutation
    }, context())).rejects.toThrow("adapter rejected workspace");
    expect(upsertTarget).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("moves only a managed Target workspace into recoverable trash before tombstoning it", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "joko-target-delete-audit-"));
    cleanups.push(() => rmSync(dataDirectory, { recursive: true, force: true }));
    const managedRoot = join(dataDirectory, "managed-workspaces");
    const workspaceRoot = join(managedRoot, "target-managed");
    mkdirSync(workspaceRoot, { recursive: true });
    const existing = {
      descriptor: {
        id: "target-managed",
        backendId: "pi",
        displayName: "Managed target",
        workspaceRoot,
        managed: true,
        trusted: false
      },
      metadata: { workspaceId: "workspace-managed" },
      revision: 1n,
      updatedAt: 1
    };
    const upsertTarget = vi.fn();
    const unregister = vi.fn();
    const store = {
      findOperation: () => undefined,
      getTarget: () => existing,
      listSessions: () => [],
      upsertTarget
    };
    const mutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "deleteTarget", value: create(contract.DeleteTargetMutationSchema, {
        targetId: existing.descriptor.id,
        deleteManagedWorkspace: true,
        deleteProductSessions: true
      }) }
    });
    const outcome = { accepted: true, resultCase: "target", entityId: existing.descriptor.id };
    const record = {
      id: "operation-delete-managed-target",
      connectionId: "connection",
      kind: "deleteTarget",
      body: mutation,
      bodyHash: operationBodyHash(mutation),
      completionMode: "external_effect",
      status: "completed",
      response: outcome,
      createdAt: 1,
      updatedAt: 2,
      revision: 2n
    } as const;
    const services = createConnectServices(stubApplication({
      config: { publicOrigin: "https://orchestrator.example.test", dataDirectory },
      store,
      workspaces: { unregister },
      sessionHost: {
        close: async () => undefined,
        mutate: async (input: { precondition?: (value: typeof store) => void; effect?: () => Promise<void>; commit: (value: typeof store) => unknown }) => {
          input.precondition?.(store);
          await input.effect?.();
          return { replayed: false, value: input.commit(store), operation: record };
        }
      },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    await invoke(services.operation.submitOperation, {
      operationId: record.id,
      connectionId: "connection",
      mutation
    }, context());

    expect(existsSync(workspaceRoot)).toBe(false);
    expect(readdirSync(join(managedRoot, ".trash"))).toHaveLength(1);
    expect(upsertTarget).toHaveBeenCalledWith(existing.descriptor, expect.objectContaining({
      state: "archived",
      deletionOperationId: record.id,
      managedWorkspaceTrashPath: expect.stringContaining(join("managed-workspaces", ".trash"))
    }));
    expect(unregister).toHaveBeenCalledWith("workspace-managed");
  });

  it("restores a typed BrowserTransfer result from the durable Operation outcome after service reconstruction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-connect-transfer-replay-"));
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    cleanups.push(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const transfer = create(contract.BrowserTransferSchema, {
      browserTransferId: "transfer-durable",
      browserProviderId: "browser",
      pageId: "page-1",
      toolCallId: "",
      direction: contract.TransferDirection.UPLOAD,
      state: contract.BrowserTransferState.COMPLETED
    });
    const operationMutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "uploadBrowserFile", value: create(contract.UploadBrowserFileMutationSchema, {
        browserProviderId: "browser",
        pageId: "page-1",
        inputHint: "input[type=file]"
      }) }
    });
    store.runOperation({ id: "operation-transfer", kind: "uploadBrowserFile", body: operationMutation }, () => ({
      accepted: true,
      resultCase: "browserTransfer",
      entityId: transfer.browserTransferId,
      browserTransferBinaryBase64: Buffer.from(toBinary(contract.BrowserTransferSchema, transfer)).toString("base64")
    }));
    const services = createConnectServices(stubApplication({
      store,
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    const response = await invoke(services.operation.getOperation, { operationId: "operation-transfer" }, context()) as { operation?: contract.Operation };

    expect(response.operation?.result?.payload.case).toBe("browserTransfer");
    if (response.operation?.result?.payload.case === "browserTransfer") {
      expect(response.operation.result.payload.value.browserTransferId).toBe("transfer-durable");
    }
  });

  it("claims a Browser takeover effect before invocation and does not replay it", async () => {
    const order: string[] = [];
    const beginHumanTakeover = vi.fn(async (binding: {
      providerId: string;
      pageId: string;
      generation: number;
      owner: string;
    }) => {
      order.push("effect");
      return { ...binding, takeoverId: "lease-1", startedAt: 1, expiresAt: 2 };
    });
    const outcome = { accepted: true, resultCase: "browserTakeover", entityId: "lease-1" };
    const record = {
      id: "operation-takeover",
      connectionId: "connection",
      kind: "beginBrowserTakeover",
      body: {},
      bodyHash: operationBodyHash({}),
      completionMode: "external_effect",
      status: "completed",
      response: outcome,
      createdAt: 1,
      updatedAt: 2,
      revision: 1n
    } as const;
    let replay = false;
    const mutate = vi.fn(async (input: { effect?: () => Promise<void>; commit: () => unknown }) => {
      order.push("claim");
      if (replay) return { replayed: true, value: outcome, operation: record };
      await input.effect?.();
      order.push("commit");
      replay = true;
      return { replayed: false, value: input.commit(), operation: record };
    });
    const operationMutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "beginBrowserTakeover", value: create(contract.BeginBrowserTakeoverMutationSchema, {
        browserProviderId: "browser",
        pageId: "page-1"
      }) }
    });
    const store = {
      findOperation: () => replay ? { ...record, bodyHash: operationBodyHash(operationMutation) } : undefined
    };
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: { mutate },
      browser: {
        id: "browser",
        generation: 1,
        beginHumanTakeover,
        assertHumanTakeover: () => undefined,
        currentHumanTakeover: () => undefined
      },
      browserState: {
        findRecoverablePage: () => ({
          browserProviderId: "browser",
          pageId: "page-1",
          generation: 1,
          sessionId: "session-1",
          targetId: "target-1",
          bindingGeneration: 1,
          url: "about:blank",
          title: "Page",
          state: "open" as const,
          updatedAt: 1
        })
      },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    await invoke(services.operation.submitOperation, { operationId: record.id, connectionId: "connection", mutation: operationMutation }, context());
    await invoke(services.operation.submitOperation, { operationId: record.id, connectionId: "connection", mutation: operationMutation }, context());

    expect(order).toEqual(["claim", "effect", "commit"]);
    expect(beginHumanTakeover).toHaveBeenCalledOnce();
  });

  it("starts a cold Browser after claiming the page-open effect and freezes the started generation", async () => {
    const order: string[] = [];
    let generation = 0;
    let takeover: {
      readonly providerId: string;
      readonly pageId: string;
      readonly generation: number;
      readonly owner: string;
      readonly takeoverId: string;
      readonly startedAt: number;
      readonly expiresAt: number;
    } | undefined;
    const start = vi.fn(async () => {
      order.push("start");
      generation = 1;
    });
    const openHumanPage = vi.fn(async (binding: {
      readonly providerId: string;
      readonly generation: number;
      readonly owner: string;
      readonly url: string;
    }) => {
      order.push("open");
      takeover = {
        providerId: binding.providerId,
        pageId: "page-opened",
        generation: binding.generation,
        owner: binding.owner,
        takeoverId: "takeover-opened",
        startedAt: 1,
        expiresAt: 2
      };
      return takeover;
    });
    const outcome = { accepted: true, resultCase: "browserTakeover", entityId: "takeover-opened" };
    const record = {
      id: "operation-browser-open-cold",
      connectionId: "connection",
      kind: "openBrowserPage",
      body: {},
      bodyHash: operationBodyHash({}),
      completionMode: "external_effect",
      status: "completed",
      response: outcome,
      createdAt: 1,
      updatedAt: 2,
      revision: 1n
    } as const;
    const mutate = vi.fn(async (input: {
      precondition?: () => void;
      effect?: () => Promise<void>;
      commit: () => unknown;
    }) => {
      order.push("claim");
      input.precondition?.();
      await input.effect?.();
      input.precondition?.();
      order.push("commit");
      return { replayed: false, value: input.commit(), operation: record };
    });
    const mutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "openBrowserPage", value: create(contract.OpenBrowserPageMutationSchema, {
        browserProviderId: "browser",
        sessionId: "session-browser-open",
        url: "https://example.test/open"
      }) }
    });
    const assertHumanTakeover = vi.fn((expected: typeof takeover) => {
      expect(expected).toBe(takeover);
    });
    const services = createConnectServices(stubApplication({
      store: {
        findOperation: () => undefined,
        findPendingSessionLifecycleCleanup: () => undefined,
        getSession: () => ({ descriptor: {
          id: "session-browser-open",
          targetId: "target-browser-open",
          binding: { generation: 0 },
          archived: false,
          deletedAt: undefined
        } })
      },
      sessionHost: { mutate },
      browser: {
        id: "browser",
        get generation() { return generation; },
        start,
        openHumanPage,
        listPages: async () => [{ id: "page-opened", title: "Opened", url: "https://example.test/open", state: "ready" as const }],
        assertHumanTakeover,
        currentHumanTakeover: () => takeover
      },
      browserSettings: {
        enabled: () => true,
        takeoverTimeout: () => 42_000
      },
      browserState: {
        findRecoverablePage: () => undefined,
        recordHumanPage: vi.fn()
      },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    await invoke(services.operation.submitOperation, {
      operationId: record.id,
      connectionId: "connection",
      mutation
    }, context());

    expect(order).toEqual(["claim", "start", "open", "commit"]);
    expect(openHumanPage).toHaveBeenCalledWith({
      providerId: "browser",
      generation: 1,
      owner: "connection",
      url: "https://example.test/open"
    }, 42_000);
    expect(assertHumanTakeover).toHaveBeenCalledOnce();
  });

  it("rejects cross-task Browser page recovery before observing or mutating the provider", async () => {
    const currentHumanTakeover = vi.fn(() => undefined);
    const start = vi.fn(async () => undefined);
    const openHumanPage = vi.fn(async () => undefined);
    const listPages = vi.fn(async () => []);
    const mutate = vi.fn(async () => {
      throw new Error("Browser recovery must fail before claiming an external effect.");
    });
    const recordHumanPage = vi.fn();
    const mutation = create(contract.OperationMutationSchema, {
      payload: { case: "openBrowserPage", value: create(contract.OpenBrowserPageMutationSchema, {
        browserProviderId: "browser",
        sessionId: "session-browser-b",
        recoveryPageId: "page-browser-a",
        url: "https://example.test/recover"
      }) }
    });
    const services = createConnectServices(stubApplication({
      store: {
        findOperation: () => undefined,
        findPendingSessionLifecycleCleanup: () => undefined,
        getSession: () => ({ descriptor: {
          targetId: "target-browser-b",
          id: "session-browser-b",
          binding: { generation: 0 },
          archived: false,
          deletedAt: undefined
        } })
      },
      sessionHost: { mutate },
      browser: {
        id: "browser",
        generation: 0,
        running: false,
        currentHumanTakeover,
        start,
        openHumanPage,
        listPages
      },
      browserState: {
        findRecoverablePage: () => ({
          browserProviderId: "browser",
          pageId: "page-browser-a",
          generation: 7,
          sessionId: "session-browser-a",
          targetId: "target-browser-a",
          bindingGeneration: 0,
          url: "https://example.test/recover",
          title: "Recovered page",
          state: "open" as const,
          updatedAt: 10
        }),
        recordHumanPage
      },
      browserSettings: { enabled: () => true },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    let failure: unknown;
    try {
      await invoke(services.operation.submitOperation, {
        operationId: "operation-browser-cross-task-recovery",
        connectionId: "connection",
        mutation
      }, context());
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConnectError);
    expect((failure as ConnectError).code).toBe(Code.FailedPrecondition);
    expect((failure as ConnectError).message).toMatch(/another task/u);
    expect(currentHumanTakeover).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(openHumanPage).not.toHaveBeenCalled();
    expect(listPages).not.toHaveBeenCalled();
    expect(recordHumanPage).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects Browser page opens for archived, deleted, and lifecycle-fenced tasks", async () => {
    const blockedStates = [
      { name: "archived", descriptor: { targetId: "target-browser", archived: true }, pending: undefined },
      { name: "deleted", descriptor: { targetId: "target-browser", archived: false, deletedAt: 20 }, pending: undefined },
      { name: "lifecycle-fenced", descriptor: { targetId: "target-browser", archived: false }, pending: { state: "pending" } }
    ] as const;

    for (const blocked of blockedStates) {
      const currentHumanTakeover = vi.fn(() => undefined);
      const mutate = vi.fn();
      const mutation = create(contract.OperationMutationSchema, {
        payload: { case: "openBrowserPage", value: create(contract.OpenBrowserPageMutationSchema, {
          browserProviderId: "browser",
          sessionId: `session-browser-${blocked.name}`,
          url: "https://example.test/open"
        }) }
      });
      const services = createConnectServices(stubApplication({
        store: {
          findOperation: () => undefined,
          findPendingSessionLifecycleCleanup: () => blocked.pending,
          getSession: () => ({ descriptor: blocked.descriptor })
        },
        sessionHost: { mutate },
        browser: { id: "browser", generation: 0, currentHumanTakeover },
        browserSettings: { enabled: () => true },
        connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
      }));

      let failure: unknown;
      try {
        await invoke(services.operation.submitOperation, {
          operationId: `operation-browser-${blocked.name}`,
          connectionId: "connection",
          mutation
        }, context());
      } catch (error) {
        failure = error;
      }

      expect(failure, blocked.name).toBeInstanceOf(ConnectError);
      expect((failure as ConnectError).code, blocked.name).toBe(Code.FailedPrecondition);
      expect(currentHumanTakeover, blocked.name).not.toHaveBeenCalled();
      expect(mutate, blocked.name).not.toHaveBeenCalled();
    }
  });

  it("focuses and closes Browser pages only through the complete owned takeover fence", async () => {
    let current: {
      readonly providerId: string;
      readonly pageId: string;
      readonly generation: number;
      readonly owner: string;
      readonly takeoverId: string;
      readonly startedAt: number;
      readonly expiresAt: number;
    } | undefined = {
      providerId: "browser",
      pageId: "page-7-1",
      generation: 7,
      owner: "connection",
      takeoverId: "takeover-1",
      startedAt: 1,
      expiresAt: 60_000
    };
    const focusHumanPage = vi.fn(async (_fence: NonNullable<typeof current>, pageId: string) => {
      current = { ...current!, pageId, takeoverId: "takeover-2" };
      return current;
    });
    const closeHumanPage = vi.fn(async () => {
      current = { ...current!, pageId: "page-7-1", takeoverId: "takeover-3" };
      return current;
    });
    const recordHumanPage = vi.fn();
    const recordClosedPage = vi.fn();
    const mutate = async (input: {
      operationId: string;
      connection: { id: string };
      kind: string;
      body: contract.OperationMutation;
      precondition?: () => void;
      effect?: () => Promise<void>;
      commit: () => unknown;
    }) => {
      input.precondition?.();
      await input.effect?.();
      input.precondition?.();
      const outcome = input.commit();
      return { replayed: false, value: outcome, operation: {
        id: input.operationId,
        connectionId: input.connection.id,
        kind: input.kind,
        body: input.body,
        bodyHash: operationBodyHash(input.body),
        completionMode: "external_effect",
        status: "completed",
        response: outcome,
        createdAt: 1,
        updatedAt: 2,
        revision: 1n
      } };
    };
    const provider = {
      id: "browser",
      generation: 7,
      currentHumanTakeover: () => current,
      assertHumanTakeover: (fence: NonNullable<typeof current>) => {
        if (current?.takeoverId !== fence.takeoverId || current.pageId !== fence.pageId) throw new Error("stale fence");
        return current;
      },
      focusHumanPage,
      closeHumanPage,
      listPages: async () => [{ id: "page-7-1", title: "One", url: "https://one.test/", state: "ready" as const }, { id: "page-7-2", title: "Two", url: "https://two.test/", state: "ready" as const }]
    };
    const services = createConnectServices(stubApplication({
      store: { findOperation: () => undefined },
      sessionHost: { mutate },
      browser: provider,
      browserState: {
        findRecoverablePage: (_providerId: string, pageId: string) => ({
          browserProviderId: "browser",
          pageId,
          sessionId: "session-1",
          targetId: "target-1",
          bindingGeneration: 1,
          generation: 7,
          url: pageId === "page-7-1" ? "https://one.test/" : "https://two.test/",
          title: pageId,
          state: "open" as const,
          updatedAt: 10
        }),
        recordHumanPage,
        closeHumanPage: recordClosedPage
      },
      browserSettings: { takeoverTimeout: () => 42_000 },
      now: () => 20,
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    const focus = create(contract.OperationMutationSchema, { payload: { case: "focusBrowserPage", value: create(contract.FocusBrowserPageMutationSchema, {
      browserProviderId: "browser",
      pageId: "page-7-2",
      currentPageId: "page-7-1",
      takeoverId: "takeover-1",
      generation: 7n
    }) } });
    await invoke(services.operation.submitOperation, { operationId: "focus-page", connectionId: "connection", mutation: focus }, context());
    expect(focusHumanPage).toHaveBeenCalledWith(expect.objectContaining({ takeoverId: "takeover-1" }), "page-7-2", 42_000);
    expect(recordHumanPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "page-7-2", sessionId: "session-1" }), { active: true });

    const close = create(contract.OperationMutationSchema, { payload: { case: "closeBrowserPage", value: create(contract.CloseBrowserPageMutationSchema, {
      browserProviderId: "browser",
      pageId: "page-7-2",
      currentPageId: "page-7-2",
      takeoverId: "takeover-2",
      generation: 7n
    }) } });
    await invoke(services.operation.submitOperation, { operationId: "close-page", connectionId: "connection", mutation: close }, context());
    expect(closeHumanPage).toHaveBeenCalledWith(expect.objectContaining({ takeoverId: "takeover-2" }), "page-7-2", 42_000);
    expect(recordClosedPage).toHaveBeenCalledWith("browser", "page-7-2", 7, "page-7-1");
    expect(recordHumanPage).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: "page-7-1", sessionId: "session-1" }), { active: true });
  });

  it("rejects a cross-Session Browser focus before dispatch", async () => {
    const takeover = {
      providerId: "browser",
      pageId: "page-a",
      generation: 7,
      owner: "connection",
      takeoverId: "takeover-a",
      startedAt: 1,
      expiresAt: 60_000
    } as const;
    const focusHumanPage = vi.fn();
    const mutate = vi.fn();
    const services = createConnectServices(stubApplication({
      store: { findOperation: () => undefined },
      sessionHost: { mutate },
      browser: {
        id: "browser",
        generation: 7,
        currentHumanTakeover: () => takeover,
        focusHumanPage
      },
      browserState: {
        findRecoverablePage: (_providerId: string, pageId: string) => ({
          browserProviderId: "browser",
          pageId,
          generation: 7,
          sessionId: pageId === "page-a" ? "session-a" : "session-b",
          targetId: pageId === "page-a" ? "target-a" : "target-b",
          bindingGeneration: 1,
          url: `https://${pageId}.example.test/`,
          title: pageId,
          state: "open" as const,
          updatedAt: 1
        })
      },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));
    const mutation = create(contract.OperationMutationSchema, {
      payload: { case: "focusBrowserPage", value: create(contract.FocusBrowserPageMutationSchema, {
        browserProviderId: "browser",
        pageId: "page-b",
        currentPageId: "page-a",
        takeoverId: "takeover-a",
        generation: 7n
      }) }
    });

    await expect(invoke(services.operation.submitOperation, {
      operationId: "focus-cross-session",
      connectionId: "connection",
      mutation
    }, context())).rejects.toThrow(/authority/u);
    expect(mutate).not.toHaveBeenCalled();
    expect(focusHumanPage).not.toHaveBeenCalled();
  });

  it("authenticates and exact-fences every typed remote Browser takeover input", async () => {
    const takeover = {
      providerId: "browser",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7,
      owner: "connection-owner",
      startedAt: 1,
      expiresAt: 60_000
    } as const;
    const performHumanTakeoverAction = vi.fn(async (
      _fence: typeof takeover,
      _input: unknown
    ) => undefined);
    const recordHumanPage = vi.fn();
    const store = { findOperation: () => undefined };
    const mutate = vi.fn(async (input: {
      operationId: string;
      connection: { id: string };
      kind: string;
      body: contract.OperationMutation;
      precondition?: () => void;
      effect?: () => Promise<void>;
      commit: () => unknown;
    }) => {
      input.precondition?.();
      await input.effect?.();
      const outcome = input.commit() as { accepted: boolean; resultCase?: string };
      return {
        replayed: false,
        value: outcome,
        operation: {
          id: input.operationId,
          connectionId: input.connection.id,
          kind: input.kind,
          body: input.body,
          bodyHash: operationBodyHash(input.body),
          completionMode: "external_effect",
          status: "completed",
          response: outcome,
          createdAt: 1,
          updatedAt: 2,
          revision: 1n
        }
      };
    });
    const services = createConnectServices(stubApplication({
      store,
      sessionHost: { mutate },
      browser: {
        id: "browser",
        generation: 7,
        currentHumanTakeover: () => takeover,
        assertHumanTakeover: () => takeover,
        performHumanTakeoverAction,
        listPages: async () => [{ id: takeover.pageId, title: "Owned", url: "https://example.test/docs", state: "ready" as const }]
      },
      browserState: {
        findRecoverablePage: () => ({
          browserProviderId: "browser",
          pageId: "page-1",
          sessionId: "session-owner",
          targetId: "target-owner",
          bindingGeneration: 1,
          generation: 7,
          url: "https://example.test/docs",
          title: "Owned",
          state: "open" as const,
          updatedAt: 1
        }),
        recordHumanPage
      },
      connections: { authenticate: () => ({ id: takeover.owner, authKeyDigest: "digest", state: "active" }) }
    }));
    const actions: readonly contract.BrowserTakeoverActionMutation["action"][] = [
      {
        case: "mouseClick",
        value: create(contract.BrowserTakeoverMouseClickSchema, {
          normalizedX: 0.25,
          normalizedY: 0.75,
          button: contract.BrowserTakeoverMouseButton.SECONDARY
        })
      },
      {
        case: "scroll",
        value: create(contract.BrowserTakeoverScrollSchema, { deltaXCssPixels: -10, deltaYCssPixels: 120 })
      },
      {
        case: "keyPress",
        value: create(contract.BrowserTakeoverKeyPressSchema, {
          character: "c",
          modifiers: [contract.BrowserTakeoverKeyModifier.CONTROL, contract.BrowserTakeoverKeyModifier.SHIFT]
        })
      },
      {
        case: "textInput",
        value: create(contract.BrowserTakeoverTextInputSchema, { text: "typed remotely" })
      },
      {
        case: "navigate",
        value: create(contract.BrowserTakeoverNavigateSchema, { url: "https://example.test/docs" })
      },
      {
        case: "navigationCommand",
        value: create(contract.BrowserTakeoverNavigationCommandSchema, {
          command: contract.BrowserTakeoverNavigationCommandKind.BACK
        })
      },
      {
        case: "navigationCommand",
        value: create(contract.BrowserTakeoverNavigationCommandSchema, {
          command: contract.BrowserTakeoverNavigationCommandKind.FORWARD
        })
      },
      {
        case: "navigationCommand",
        value: create(contract.BrowserTakeoverNavigationCommandSchema, {
          command: contract.BrowserTakeoverNavigationCommandKind.RELOAD
        })
      },
      {
        case: "navigationCommand",
        value: create(contract.BrowserTakeoverNavigationCommandSchema, {
          command: contract.BrowserTakeoverNavigationCommandKind.STOP
        })
      }
    ];

    for (const [index, action] of actions.entries()) {
      const mutation = create(contract.OperationMutationSchema, {
        payload: {
          case: "browserTakeoverAction",
          value: create(contract.BrowserTakeoverActionMutationSchema, {
            browserProviderId: takeover.providerId,
            pageId: takeover.pageId,
            takeoverId: takeover.takeoverId,
            generation: BigInt(takeover.generation),
            action
          })
        }
      });
      await invoke(services.operation.submitOperation, {
        operationId: `operation-human-input-${index}`,
        connectionId: takeover.owner,
        mutation
      }, context());
    }

    expect(performHumanTakeoverAction.mock.calls.map((call) => call[0])).toEqual([
      takeover, takeover, takeover, takeover, takeover, takeover, takeover, takeover, takeover
    ]);
    expect(performHumanTakeoverAction.mock.calls.map((call) => call[1])).toEqual([
      { type: "mouseClick", normalizedX: 0.25, normalizedY: 0.75, button: "secondary" },
      { type: "scroll", deltaX: -10, deltaY: 120 },
      { type: "keyPress", key: "c", modifiers: ["Control", "Shift"] },
      { type: "textInput", text: "typed remotely" },
      { type: "navigate", url: "https://example.test/docs" },
      { type: "navigationCommand", command: "back" },
      { type: "navigationCommand", command: "forward" },
      { type: "navigationCommand", command: "reload" },
      { type: "navigationCommand", command: "stop" }
    ]);
    expect(recordHumanPage).toHaveBeenLastCalledWith(expect.objectContaining({
      pageId: "page-1",
      sessionId: "session-owner",
      url: "https://example.test/docs"
    }), { active: true });
  });

  it("rejects stale, foreign-owner, and out-of-range Browser takeover input before dispatch", async () => {
    const takeover = {
      providerId: "browser",
      pageId: "page-1",
      takeoverId: "takeover-1",
      generation: 7,
      owner: "connection-owner",
      startedAt: 1,
      expiresAt: 60_000
    } as const;
    const performHumanTakeoverAction = vi.fn(async (
      _fence: typeof takeover,
      _input: unknown
    ) => undefined);
    let authenticatedId: string = takeover.owner;
    const services = createConnectServices(stubApplication({
      store: { findOperation: () => undefined },
      sessionHost: { mutate: vi.fn() },
      browser: {
        id: "browser",
        generation: 7,
        currentHumanTakeover: () => takeover,
        performHumanTakeoverAction
      },
      connections: { authenticate: () => ({ id: authenticatedId, authKeyDigest: "digest", state: "active" }) }
    }));
    const mutation = (overrides: Partial<{
      pageId: string;
      takeoverId: string;
      generation: bigint;
      normalizedX: number;
    }> = {}) => create(contract.OperationMutationSchema, {
      payload: {
        case: "browserTakeoverAction",
        value: create(contract.BrowserTakeoverActionMutationSchema, {
          browserProviderId: takeover.providerId,
          pageId: overrides.pageId ?? takeover.pageId,
          takeoverId: overrides.takeoverId ?? takeover.takeoverId,
          generation: overrides.generation ?? BigInt(takeover.generation),
          action: {
            case: "mouseClick",
            value: create(contract.BrowserTakeoverMouseClickSchema, {
              normalizedX: overrides.normalizedX ?? 0.5,
              normalizedY: 0.5,
              button: contract.BrowserTakeoverMouseButton.PRIMARY
            })
          }
        })
      }
    });

    for (const [index, value] of [
      mutation({ pageId: "page-stale" }),
      mutation({ takeoverId: "takeover-stale" }),
      mutation({ generation: 8n })
    ].entries()) {
      await expect(invoke(services.operation.submitOperation, {
        operationId: `operation-stale-human-input-${index}`,
        connectionId: authenticatedId,
        mutation: value
      }, context())).rejects.toMatchObject({ code: Code.FailedPrecondition });
    }

    authenticatedId = "connection-foreign";
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-foreign-human-input",
      connectionId: authenticatedId,
      mutation: mutation()
    }, context())).rejects.toMatchObject({ code: Code.FailedPrecondition });
    authenticatedId = takeover.owner;
    await expect(invoke(services.operation.submitOperation, {
      operationId: "operation-invalid-human-input",
      connectionId: authenticatedId,
      mutation: mutation({ normalizedX: Number.POSITIVE_INFINITY })
    }, context())).rejects.toThrow(/normalized x coordinate/u);
    expect(performHumanTakeoverAction).not.toHaveBeenCalled();
  });

  it("does not commit a Browser screenshot outcome when the claimed effect fails", async () => {
    const order: string[] = [];
    const commit = vi.fn();
    const mutate = vi.fn(async (input: { effect?: () => Promise<void>; commit: () => unknown }) => {
      order.push("claim");
      await input.effect?.();
      order.push("commit");
      commit();
      return { replayed: false, value: input.commit(), operation: {} };
    });
    const operationMutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "captureBrowserScreenshot", value: create(contract.CaptureBrowserScreenshotMutationSchema, {
        browserProviderId: "browser",
        pageId: "page-1"
      }) }
    });
    const services = createConnectServices(stubApplication({
      store: { findOperation: () => undefined },
      sessionHost: { mutate },
      browser: {
        id: "browser",
        generation: 1,
        currentHumanTakeover: () => undefined,
        acquireAgentLease: () => ({ id: "lease", generation: 1 }),
        releaseAgentLease: async () => undefined,
        snapshot: async () => { order.push("effect"); throw new Error("capture failed"); }
      },
      browserState: {
        findRecoverablePage: () => ({
          browserProviderId: "browser",
          pageId: "page-1",
          generation: 1,
          sessionId: "session-1",
          targetId: "target-1",
          bindingGeneration: 1,
          url: "about:blank",
          title: "Page",
          state: "open" as const,
          updatedAt: 1
        })
      },
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    await expect(invoke(
      services.operation.submitOperation,
      { operationId: "operation-screenshot-failure", connectionId: "connection", mutation: operationMutation },
      context()
    )).rejects.toThrow("capture failed");
    expect(order).toEqual(["claim", "effect"]);
    expect(commit).not.toHaveBeenCalled();
  });

  it("honors full-page capture and projects the generation-fenced durable screenshot", async () => {
    const screenshot = Buffer.from("png-image");
    const snapshot = vi.fn(async (
      _pageId: string,
      _lease: Readonly<Record<string, unknown>>,
      options: { fullPage?: boolean }
    ) => ({
      page: { id: "page-1", title: "Example", url: "https://example.test/", state: "ready" as const },
      screenshot,
      aria: "document"
    }));
    const durable = {
      browserProviderId: "browser",
      pageId: "page-1",
      generation: 4,
      artifactId: "artifact-screenshot",
      blob: {
        id: "artifact-screenshot",
        sha256: "a".repeat(64),
        byteLength: screenshot.byteLength,
        mimeType: "image/png",
        fileName: "page-1.png"
      },
      capturedAt: 20
    };
    let recorded: typeof durable | undefined;
    const browserState = {
      recordScreenshot: vi.fn((value: typeof durable) => { recorded = value; }),
      findScreenshot: (_providerId: string, _pageId: string, generation: number) => generation === 4 ? recorded : undefined,
      findRecoverablePage: () => ({
        browserProviderId: "browser",
        pageId: "page-1",
        sessionId: "session-browser-page",
        targetId: "target-browser-page",
        bindingGeneration: 4,
        generation: 4,
        url: "https://example.test/",
        title: "Example",
        state: "open" as const,
        updatedAt: 20
      })
    };
    const browser = {
      id: "browser",
      generation: 4,
      running: true,
      currentHumanTakeover: () => undefined,
      acquireAgentLease: () => ({ id: "lease", generation: 4 }),
      releaseAgentLease: async () => undefined,
      snapshot,
      listPages: async () => [{ id: "page-1", title: "Example", url: "https://example.test/", state: "ready", canGoBack: true, canGoForward: false }],
      leases: { current: () => undefined }
    };
    const operationMutation = create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "captureBrowserScreenshot", value: create(contract.CaptureBrowserScreenshotMutationSchema, {
        browserProviderId: "browser",
        pageId: "page-1",
        fullPage: true
      }) }
    });
    const response = { accepted: true, resultCase: "screenshot", entityId: "artifact-screenshot" };
    const record = {
      id: "operation-full-page-screenshot",
      connectionId: "connection",
      kind: "captureBrowserScreenshot",
      body: operationMutation,
      bodyHash: operationBodyHash(operationMutation),
      completionMode: "external_effect",
      status: "completed",
      response,
      createdAt: 10,
      updatedAt: 20,
      revision: 1n
    } as const;
    const services = createConnectServices(stubApplication({
      store: { findOperation: () => undefined },
      sessionHost: {
        mutate: async (input: { precondition?: () => void; effect?: () => Promise<void>; commit: () => unknown }) => {
          input.precondition?.();
          await input.effect?.();
          return { replayed: false, value: input.commit(), operation: record };
        }
      },
      browser,
      browserState,
      blobTransfers: {
        beginUpload: async () => ({ ticketId: "ticket", relativeEndpoint: "/v1/blobs/upload/ticket/secret" }),
        acceptUpload: async () => durable.blob
      },
      now: () => 20,
      connections: { authenticate: () => ({ id: "connection", authKeyDigest: "digest", state: "active" }) }
    }));

    await invoke(services.operation.submitOperation, {
      operationId: record.id,
      connectionId: "connection",
      mutation: operationMutation
    }, context());
    const pageResponse = await invoke(services.browser.getBrowserPage, { browserProviderId: "browser", pageId: "page-1" }, context()) as {
      page?: contract.BrowserPage;
    };
    const wirePage = pageResponse.page === undefined
      ? undefined
      : fromBinary(contract.BrowserPageSchema, toBinary(contract.BrowserPageSchema, pageResponse.page));

    expect(snapshot).toHaveBeenCalledWith(
      "page-1",
      { id: "lease", generation: 4 },
      { fullPage: true }
    );
    expect(browserState.recordScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      browserProviderId: "browser",
      pageId: "page-1",
      generation: 4,
      artifactId: "artifact-screenshot",
      blob: durable.blob
    }));
    expect(pageResponse.page?.latestScreenshot?.blob?.blobId).toBe("artifact-screenshot");
    expect(wirePage?.latestScreenshot?.blob?.blobId).toBe("artifact-screenshot");
    expect(wirePage?.canGoBack).toBe(true);
    expect(wirePage?.canGoForward).toBe(false);
    expect(wirePage?.sessionId).toBe("session-browser-page");
  });
});

function sessionUsageRecord(id: string, backendId: string, providerId: string, totalTokens: number) {
  return {
    descriptor: { id, backendId, providerId, createdAt: 1 },
    runtimeState: {
      usage: {
        inputTokens: totalTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens,
        cost: 0
      },
      updatedAt: 2
    }
  };
}

function piContractTreeDepth(root: contract.PiSessionTreeNestedNode | undefined): number {
  let current = root;
  let depth = 0;
  while (current !== undefined) {
    if (current.children.length > 1) throw new Error("Pi Session tree is not linear.");
    depth += 1;
    current = current.children[0];
  }
  return depth;
}

type TestEventQuery = NonNullable<Parameters<OperationalStore["listEvents"]>[0]>;

function syntheticEventPage(
  total: number,
  query: TestEventQuery = {},
  factory: (cursor: bigint) => PersistedEvent = persistedStatus
): PersistedEvent[] {
  const after = query.afterCursor ?? 0n;
  const before = query.beforeCursor ?? BigInt(total + 1);
  const first = Math.max(1, Number(after + 1n));
  const last = Math.min(total, Number(before - 1n));
  if (first > last) return [];
  const limit = query.limit ?? 1_000;
  const length = Math.min(limit, last - first + 1);
  return Array.from({ length }, (_, index) => factory(BigInt(
    query.order === "desc" ? last - index : first + index
  )));
}
