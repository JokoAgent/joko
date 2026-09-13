import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

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
      primaryWindow: { usedPercent: 65, windowMinutes: 300 }
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
  const authenticated = {
    id: "connection-account-usage",
    name: "Account usage",
    authKeyDigest: "digest",
    state: "active" as const,
    pairedAt: 1,
    revision: 1n
  };
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => authenticated },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    scheduler: {},
    sessionHost: {
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
  return { services: createConnectServices(application), adapters };
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

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T>)(request, {
    requestHeader: new Headers(),
    signal: new AbortController().signal
  });
}
