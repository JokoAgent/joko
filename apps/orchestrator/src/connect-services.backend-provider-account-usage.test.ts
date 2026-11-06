import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { ConnectionManager, digestAuthKey } from "./connection-manager.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];
const originalKey = "original-account-usage-device";
const observerKey = "observer-account-usage-device";

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Backend-native Provider account usage", () => {
  it("joins list, get, usage, and Snapshot reads by Backend and Provider identity", async () => {
    const fixture = createFixture([
      nativeBackend("backend-one", "provider-shared"),
      nativeBackend("backend-two", "provider-shared")
    ], [
      accountUsageAdapter("backend-one", "provider-shared", "plus", 20),
      accountUsageAdapter("backend-two", "provider-shared", "team", 65)
    ]);

    const listed = await invoke<any>(fixture.services.backend.listProviders, { backendId: "" });
    expect(accountUsageByBackend(listed.providers)).toEqual({
      "backend-one": { planType: "plus", usedPercent: 20 },
      "backend-two": { planType: "team", usedPercent: 65 }
    });
    for (const provider of listed.providers) {
      expect(provider.capabilities?.capabilities).toContainEqual(expect.objectContaining({
        name: "provider.account_usage",
        support: contract.CapabilitySupport.SUPPORTED
      }));
    }
    await expect(invoke(fixture.services.backend.getProviderUsage, {
      backendId: "",
      providerId: "provider-shared"
    })).rejects.toThrow("backend_id is required");

    const selected = await invoke<any>(fixture.services.backend.getProvider, {
      backendId: "backend-one",
      providerId: "provider-shared"
    });
    expect(selected.provider.accountUsage).toMatchObject({
      providerId: "provider-shared",
      planType: "plus",
      primaryWindow: { usedPercent: 20, windowMinutes: 300 }
    });

    const usage = await invoke<any>(fixture.services.backend.getProviderUsage, {
      backendId: "backend-two",
      providerId: "provider-shared"
    });
    expect(usage.accountUsage).toMatchObject({
      providerId: "provider-shared",
      planType: "team",
      primaryWindow: { usedPercent: 65, windowMinutes: 300 },
      buckets: [{ id: "metered", displayName: "Metered", primaryWindow: { usedPercent: 65, windowMinutes: 300 } }],
      modelWindows: [{ modelId: "model-scoped", displayName: "Scoped model", window: { usedPercent: 40, windowMinutes: 10_080, severity: "warning" } }],
      extraUsage: { enabled: false, usedCredits: 0, monthlyLimit: 100 },
      resetCredits: { availableCount: 3, earliestExpiryAt: { seconds: 1_800_000_000n } }
    });

    const snapshot = await invoke<any>(fixture.services.event.getSnapshot, {});
    expect(accountUsageByBackend(snapshot.snapshot.providers)).toEqual({
      "backend-one": { planType: "plus", usedPercent: 20 },
      "backend-two": { planType: "team", usedPercent: 65 }
    });
    expect(fixture.adapters[0]!.readAccountUsage).toHaveBeenCalledTimes(3);
    expect(fixture.adapters[1]!.readAccountUsage).toHaveBeenCalledTimes(3);
    expect(fixture.adapters[0]!.readAccountUsage).toHaveBeenCalledWith(
      "provider-shared",
      expect.any(AbortSignal)
    );
  });

  it("does not expose another Provider's snapshot or advertise an unavailable port", async () => {
    const wrongIdentity = accountUsageAdapter("backend-guarded", "provider-foreign", "foreign", 99);
    const fixture = createFixture([
      nativeBackend("backend-guarded", "provider-owned"),
      nativeBackend("backend-no-port", "provider-owned")
    ], [wrongIdentity, { id: "backend-no-port" }]);

    const listed = await invoke<any>(fixture.services.backend.listProviders, { backendId: "" });
    const guarded = listed.providers.find((provider: contract.ProviderDescriptor) =>
      provider.backendId === "backend-guarded");
    const unavailable = listed.providers.find((provider: contract.ProviderDescriptor) =>
      provider.backendId === "backend-no-port");
    expect(guarded?.accountUsage).toBeUndefined();
    expect(guarded?.capabilities?.capabilities).toContainEqual(expect.objectContaining({
      name: "provider.account_usage",
      support: contract.CapabilitySupport.SUPPORTED
    }));
    expect(unavailable?.accountUsage).toBeUndefined();
    expect(unavailable?.capabilities?.capabilities.some((capability: contract.Capability) =>
      capability.name === "provider.account_usage")).not.toBe(true);
  });

  it.each([
    ["usage", "value", "revoked"], ["list", "value", "revoked"], ["provider", "value", "revoked"],
    ["snapshot", "value", "revoked"], ["snapshot", "empty", "revoked"], ["snapshot", "error", "revoked"],
    ["snapshot", "value", "cancelled"]
  ] as const)("retires the %s read with a late %s after it is %s", async (endpoint, result, retirement) => {
    const backendId = "backend-owned";
    const providerId = "provider-owned";
    const sample = accountUsageAdapter(backendId, providerId, "team", 65);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const readAccountUsage = vi.fn(async (_providerId: string, _signal?: AbortSignal) => {
      await pending;
      if (result === "error") throw new Error("Quota backend failed.");
      return result === "value" ? sample.readAccountUsage() : undefined;
    });
    const fixture = createFixture([nativeBackend(backendId, providerId)], [{ id: backendId, readAccountUsage }]);
    if (endpoint === "snapshot") {
      fixture.store.upsertTarget({ id: "project", backendId, displayName: "Project", workspaceRoot: fixture.directory,
        managed: false, trusted: true });
      fixture.store.createSession({ id: "task", backendId, targetId: "project", title: "Private task",
        binding: { opaqueRef: "native/task", generation: 0 }, pinned: false, archived: false, permissionMode: "ask",
        planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    }
    const call = (key: string, signal?: AbortSignal) => {
      switch (endpoint) {
        case "usage": return invoke(fixture.services.backend.getProviderUsage, { backendId, providerId }, key, signal);
        case "list": return invoke(fixture.services.backend.listProviders, { backendId }, key, signal);
        case "provider": return invoke(fixture.services.backend.getProvider, { backendId, providerId }, key, signal);
        case "snapshot": return invoke(fixture.services.event.getSnapshot, {}, key, signal);
      }
    };
    const request = new AbortController();
    const first = call(originalKey, request.signal);
    const observed = expect(first).rejects.toMatchObject({
      code: retirement === "revoked" ? Code.Unauthenticated : Code.Canceled
    });
    const other = call(observerKey);
    try {
      await vi.waitFor(() => expect(readAccountUsage).toHaveBeenCalledTimes(2));
      if (retirement === "revoked") fixture.connections.revokeDevice(fixture.original.deviceId);
      else request.abort();
      expect(readAccountUsage.mock.calls[0]?.[1]?.aborted).toBe(true);
      expect(readAccountUsage.mock.calls[1]?.[1]?.aborted).toBe(false);
    } finally { release(); }
    await observed;
    const response = await other;
    if (endpoint === "snapshot") {
      expect(response).toMatchObject({ snapshot: { sessions: [{ title: "Private task" }] } });
    }
    if (retirement === "revoked") await expect(call(originalKey)).rejects.toMatchObject({ code: Code.Unauthenticated });
  });
});

function nativeBackend(backendId: string, providerId: string) {
  return {
    id: backendId,
    adapterKind: "native-test",
    instanceGeneration: 1,
    displayName: backendId,
    version: "test",
    health: "healthy" as const,
    installationState: "installed" as const,
    authenticationState: "authenticated" as const,
    capabilities: new Map([
      ["provider.account_usage", { key: "provider.account_usage", supported: true }]
    ]),
    providers: [{
      providerId,
      displayName: providerId,
      api: "openai-responses" as const,
      authenticationState: "authenticated" as const,
      loginMethods: [],
      supportsLogin: false,
      supportsLogout: false,
      supportsRefresh: true,
      supportsModelRefresh: true
    }],
    models: [],
    tools: [],
    diagnostics: []
  };
}

function accountUsageAdapter(
  backendId: string,
  providerId: string,
  planType: string,
  usedPercent: number
) {
  return {
    id: backendId,
    readAccountUsage: vi.fn(async () => ({
      providerId,
      primaryWindow: { usedPercent, windowMinutes: 300, resetAt: 1_800_000_000_000 },
      planType,
      credits: { hasCredits: true, unlimited: false, balance: "5", observedAt: 1_700_000_000_000 },
      buckets: [{ id: "metered", displayName: "Metered", primaryWindow: { usedPercent, windowMinutes: 300 } }],
      modelWindows: [{ modelId: "model-scoped", displayName: "Scoped model", window: { usedPercent: 40, windowMinutes: 10_080, severity: "warning" } }],
      extraUsage: { enabled: false, usedCredits: 0, monthlyLimit: 100 },
      resetCredits: { availableCount: 3, earliestExpiryAt: 1_800_000_000_000 },
      observedAt: 1_700_000_000_000
    }))
  };
}

function createFixture(
  backends: readonly ReturnType<typeof nativeBackend>[],
  adapters: ReadonlyArray<{ readonly id: string; readonly readAccountUsage?: ReturnType<typeof vi.fn> }>
) {
  const directory = mkdtempSync(join(tmpdir(), "joko-native-account-usage-"));
  const store = new OperationalStore(join(directory, "orchestrator.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const backend of backends) store.upsertBackend(backend);
  const connections = new ConnectionManager(store);
  const original = store.createConnection({ id: "connection-account-usage", name: "Account usage",
    authKeyDigest: digestAuthKey(originalKey) });
  store.createConnection({ id: "observer-account-usage", name: "Observer", authKeyDigest: digestAuthKey(observerKey) });
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections,
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    sessionHost: {
      sideChatSourceAllowed: () => false,
      getSessionRuntimeControl: () => ({ generation: 0, fallbackHop: 0, visitedRoutes: [] }),
      invokeBackendAdapter: async <T>(
        backendId: string,
        effect: (adapter: typeof adapters[number], generation: number) => T | Promise<T>
      ): Promise<T> => {
        const adapter = adapters.find((candidate) => candidate.id === backendId);
        if (adapter === undefined) throw new Error("Backend not found.");
        return await effect(adapter, 1);
      }
    },
    adapters,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  return { services: createConnectServices(application), adapters, directory, store, connections, original };
}

function accountUsageByBackend(providers: readonly contract.ProviderDescriptor[]) {
  return Object.fromEntries(providers.map((provider) => [
    provider.backendId,
    {
      planType: provider.accountUsage?.planType,
      usedPercent: provider.accountUsage?.primaryWindow?.usedPercent
    }
  ]));
}

async function invoke<T>(handler: unknown, request: unknown, key = originalKey,
  signal: AbortSignal = new AbortController().signal): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T>)(request, {
    requestHeader: new Headers({ authorization: `Bearer ${key}` }),
    signal
  });
}
