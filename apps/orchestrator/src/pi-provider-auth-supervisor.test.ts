import { readFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";

import {
  CredentialManager,
  ProviderAuthGenerationConflictError,
  ProviderAuthUnsupportedError,
  ProviderCatalogManager
} from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import {
  PiProviderAuthSupervisor,
  nativeThinkingLevels,
  supportsProviderAccountUsage,
  type PiAuthInteraction,
  type PiApiKeyCredential,
  type PiCredentialStore,
  type PiOAuthCredential,
  type PiProviderAuthPromptKind,
  type PiProviderAuthPromptRecord,
  type PiProviderAuthFlowState,
  type PiProviderAuthRuntime
} from "./pi-provider-auth-supervisor.js";
import { PROVIDER_ACCOUNT_USAGE_CAPABILITY } from "./provider-account-usage.js";

const NOW = 1_800_000_000_000;

describe("nativeThinkingLevels", () => {
  it("matches Pi defaults and partial-map null/extended semantics", () => {
    expect(nativeThinkingLevels(false, { max: "max" })).toEqual([]);
    expect(nativeThinkingLevels(true, undefined)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(nativeThinkingLevels(true, {})).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(nativeThinkingLevels(true, {
      off: null,
      low: null,
      high: "provider-high",
      xhigh: null,
      max: "provider-max"
    })).toEqual(["minimal", "medium", "high", "max"]);
  });
});

describe("supportsProviderAccountUsage", () => {
  const provider = (input: { readonly subscription: boolean; readonly apis: readonly string[] }) => ({
    id: "renamed-subscription-provider",
    getModels: () => input.apis.map((api, index) => ({
      id: `model-${index}`,
      api,
      contextWindow: 128_000,
      maxTokens: 16_000
    })),
    auth: {
      oauth: {
        isSubscription: input.subscription,
        refresh: async (credential: PiOAuthCredential) => credential
      }
    }
  });

  it("derives support from subscription auth plus the runtime protocol, not Provider identity", () => {
    expect(supportsProviderAccountUsage(provider({
      subscription: true,
      apis: ["openai-codex-responses"]
    }))).toBe(true);
    expect(supportsProviderAccountUsage(provider({
      subscription: false,
      apis: ["openai-codex-responses"]
    }))).toBe(false);
    expect(supportsProviderAccountUsage(provider({
      subscription: true,
      apis: ["openai-codex-responses", "openai-responses"]
    }))).toBe(false);
  });
});

async function fixture(providerId = "openai-codex", seedManagedProvider = true, managedProviderEnabled = true) {
  const root = await mkdtemp(join(tmpdir(), "joko-pi-provider-auth-"));
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({
    vault,
    storagePath: join(root, "credential-records.json"),
    now: () => NOW
  });
  await credentials.initialize();
  const store = new OperationalStore(join(root, "orchestrator.db"), { now: () => NOW });
  const providers = new ProviderCatalogManager({ store, credentials, now: () => NOW });
  providers.initialize();
  if (seedManagedProvider) await providers.upsert({
    provider: {
      id: providerId,
      api: "openai-responses",
      models: [{ id: "native-model", contextWindow: 128_000, maxTokens: 16_000 }]
    },
    displayName: "Native subscription",
    kind: "subscription",
    credentialBindings: {},
    enabled: managedProviderEnabled,
    supportsLogin: true,
    supportsLogout: true,
    supportsRefresh: true
  });
  return { root, credentials, store, providers, providerId };
}

class FakePiRuntime implements PiProviderAuthRuntime {
  readonly #credentials: PiCredentialStore;
  readonly #providerId: string;
  readonly #loginGate = deferred<void>();
  readonly selections: string[] = [];
  refreshCount = 0;
  refreshFailuresRemaining = 0;

  constructor(credentials: PiCredentialStore, providerId: string) {
    this.#credentials = credentials;
    this.#providerId = providerId;
  }

  getProviders() {
    return [{
      id: this.#providerId,
      name: "Fake native subscription",
      getModels: () => [
        { id: "native-model", api: "openai-responses", contextWindow: 128_000, maxTokens: 16_000 },
        ...(this.refreshCount === 0
          ? []
          : [{ id: "refreshed-native-model", api: "openai-responses", contextWindow: 256_000, maxTokens: 32_000 }])
      ],
      refreshModels: async () => undefined,
      auth: {
        oauth: {
          isSubscription: true,
          refresh: async (credential: PiOAuthCredential, signal: AbortSignal): Promise<PiOAuthCredential> => {
            signal.throwIfAborted();
            return {
              ...credential,
              access: "access-token-after-refresh",
              refresh: "refresh-token-after-refresh",
              expires: NOW + 2 * 60 * 60_000
            };
          }
        }
      }
    }];
  }

  getProvider(providerId: string) {
    return this.getProviders().find((provider) => provider.id === providerId);
  }

  async login(providerId: string, type: "oauth", interaction: PiAuthInteraction): Promise<PiOAuthCredential> {
    expect(providerId).toBe(this.#providerId);
    expect(type).toBe("oauth");
    const selection = await interaction.prompt({
      type: "select",
      message: "Select native login method",
      options: [
        { id: "browser", label: "Browser login" },
        { id: "device_code", label: "Device code login" }
      ]
    });
    this.selections.push(selection);
    if (selection === "device_code") {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://login.example.test/device",
        expiresInSeconds: 300
      });
    } else {
      interaction.notify({ type: "auth_url", url: "https://login.example.test/authorize?state=public-flow-state" });
    }
    await waitForGate(this.#loginGate, interaction.signal);
    const credential: PiOAuthCredential = {
      type: "oauth",
      access: "access-token-never-public",
      refresh: "refresh-token-never-public",
      expires: NOW + 60 * 60_000,
      accountId: "account-public-metadata"
    };
    await this.#credentials.modify(providerId, async () => credential, { signal: interaction.signal });
    return credential;
  }

  async logout(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    await this.#credentials.delete(providerId, options);
  }

  async refresh(): Promise<{ readonly aborted: false; readonly errors: ReadonlyMap<string, Error> }> {
    this.refreshCount += 1;
    if (this.refreshFailuresRemaining > 0) {
      this.refreshFailuresRemaining -= 1;
      return { aborted: false, errors: new Map([[this.#providerId, new Error("private upstream failure")]]) };
    }
    return { aborted: false, errors: new Map() };
  }

  completeLogin(): void {
    this.#loginGate.resolve();
  }
}

class FakeApiKeyRuntime implements PiProviderAuthRuntime {
  readonly #credentials: PiCredentialStore;
  readonly #providerId: string;
  readonly selections: string[] = [];

  constructor(credentials: PiCredentialStore, providerId = "amazon-bedrock") {
    this.#credentials = credentials;
    this.#providerId = providerId;
  }

  getProviders() {
    return [{
      id: this.#providerId,
      name: "Native ambient Provider",
      getModels: () => [{
        id: "native-ambient-model",
        api: "bedrock-converse-stream",
        contextWindow: 128_000,
        maxTokens: 16_000
      }],
      auth: { apiKey: { name: "AWS credentials" } }
    }];
  }

  getProvider(providerId: string) {
    return this.getProviders().find((provider) => provider.id === providerId);
  }

  async login(providerId: string, type: "api_key" | "oauth", interaction: PiAuthInteraction): Promise<PiApiKeyCredential> {
    expect(providerId).toBe(this.#providerId);
    expect(type).toBe("api_key");
    const selection = await interaction.prompt({
      type: "select",
      message: "Select native credential source",
      options: [
        { id: "aws-profile", label: "AWS profile" },
        { id: "credential-chain", label: "Ambient credential chain" }
      ]
    });
    this.selections.push(selection);
    const credential: PiApiKeyCredential = selection === "aws-profile"
      ? {
        type: "api_key",
        env: {
          AWS_PROFILE: await interaction.prompt({ type: "text", message: "AWS profile" })
        }
      }
      : { type: "api_key" };
    await this.#credentials.modify(providerId, async () => credential, { signal: interaction.signal });
    return credential;
  }

  async logout(providerId: string, options?: { readonly signal?: AbortSignal }): Promise<void> {
    await this.#credentials.delete(providerId, options);
  }
}

describe("PiProviderAuthSupervisor", () => {
  it("refreshes a native model source, activates the new catalog, and exposes its capability", async () => {
    const { store, providers, providerId } = await fixture();
    let runtime!: FakePiRuntime;
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => (runtime = new FakePiRuntime(credentialStore, providerId))
    });

    expect(supervisor.supportsModelRefresh(providerId)).toBe(true);
    await expect(supervisor.refreshModelCatalogs({ providerId, automatic: false })).resolves.toEqual({
      refreshedProviderIds: [providerId],
      skippedProviderIds: [],
      addedModelCount: 0
    });
    expect(runtime.refreshCount).toBe(1);
    expect(supervisor.listNativeModels().map((model) => model.modelId)).toContain("refreshed-native-model");
    expect(generationRefreshes).toBe(1);
    expect(providers.get(providerId).supportsModelRefresh).toBe(true);
    await supervisor.close();
    store.close();
  });

  it("applies success and failure cooldowns to automatic refresh without surfacing source errors", async () => {
    const { store, providers, providerId } = await fixture();
    let now = NOW;
    let runtime!: FakePiRuntime;
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => now,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => (runtime = new FakePiRuntime(credentialStore, providerId))
    });
    providers.setNativeAuthenticationState(providerId, "not_required");
    runtime.refreshFailuresRemaining = 1;

    await expect(supervisor.refreshModelCatalogs({ automatic: true })).resolves.toEqual({
      refreshedProviderIds: [],
      skippedProviderIds: [providerId],
      addedModelCount: 0
    });
    expect(runtime.refreshCount).toBe(1);
    await supervisor.refreshModelCatalogs({ automatic: true });
    expect(runtime.refreshCount).toBe(1);

    now += 5 * 60_000;
    await supervisor.refreshModelCatalogs({ automatic: true });
    expect(runtime.refreshCount).toBe(2);
    expect(generationRefreshes).toBe(1);
    await supervisor.refreshModelCatalogs({ automatic: true });
    expect(runtime.refreshCount).toBe(2);

    now += 30 * 60_000;
    await supervisor.refreshModelCatalogs({ automatic: true });
    expect(runtime.refreshCount).toBe(3);
    expect(generationRefreshes).toBe(2);
    await supervisor.close();
    store.close();
  });

  it("seeds the authoritative installed Pi authentication registry without turning builtins into managed endpoints", async () => {
    const { root, store, providers } = await fixture("unused", false);
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => undefined
    });
    const nativeModels = supervisor.listNativeModels();
    expect(nativeModels.length).toBeGreaterThan(100);
    expect(new Set(nativeModels.map((model) => `${model.providerId}\0${model.modelId}`)).size).toBe(nativeModels.length);
    expect([...new Set(nativeModels.map((model) => model.providerId))]).toEqual(expect.arrayContaining([
      "anthropic",
      "google",
      "openai",
      "openai-codex"
    ]));
    expect(nativeModels.some((model) => model.supportsImages)).toBe(true);
    expect(nativeModels.some((model) => model.thinkingLevels.length > 0)).toBe(true);
    expect(nativeModels.some((model) => model.cost.input > 0 && model.cost.output > 0)).toBe(true);
    expect(nativeModels.some((model) => model.supportsFastMode === true)).toBe(true);
    expect(nativeModels.filter((model) => model.supportsFastMode === true).every((model) =>
      model.api === "openai-codex-responses")).toBe(true);
    for (const model of nativeModels) {
      expect(model.api).not.toBe("");
      expect(model.contextWindow).toBeGreaterThan(0);
      expect(model.maxOutputTokens).toBeGreaterThan(0);
    }
    const native = providers.list().filter((provider) => provider.supportsLogin);
    expect(native.map((provider) => provider.provider.id)).toEqual(expect.arrayContaining([
      "amazon-bedrock",
      "anthropic",
      "azure-openai-responses",
      "github-copilot",
      "google-vertex",
      "kimi-coding",
      "openai-codex",
      "openrouter",
      "radius",
      "xai"
    ]));
    expect(providers.get("openai-codex")).toMatchObject({
      kind: "subscription",
      authenticationState: "signed_out",
      enabled: false,
      supportsLogin: true,
      supportsRefresh: true,
      supportsLogout: true
    });
    expect(providers.get("amazon-bedrock")).toMatchObject({
      kind: "api_key",
      authenticationState: "signed_out",
      enabled: false,
      supportsLogin: true,
      supportsRefresh: false,
      supportsLogout: true
    });
    expect(providers.get("openai-codex").capabilities?.has(PROVIDER_ACCOUNT_USAGE_CAPABILITY)).toBe(true);
    for (const providerId of ["amazon-bedrock", "azure-openai-responses", "google-vertex"]) {
      expect(providers.get(providerId)).toMatchObject({
        kind: "api_key",
        authenticationState: "signed_out",
        supportsLogin: true,
        supportsRefresh: false,
        supportsLogout: true
      });
    }
    const snapshot = await providers.createPiGenerationSnapshot({ snapshotsRoot: join(root, "generations") });
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.nativeAuthProviderIds).toEqual(expect.arrayContaining([
      "amazon-bedrock",
      "anthropic",
      "azure-openai-responses",
      "github-copilot",
      "google-vertex",
      "kimi-coding",
      "openai-codex",
      "openrouter",
      "radius",
      "xai"
    ]));
    expect(snapshot.nativeAuthenticatedProviderIds).toEqual([]);
    expect(snapshot.environment).toEqual({});
    expect(JSON.parse(await readFile(join(snapshot.agentHome, "models.json"), "utf8"))).toEqual({ providers: {} });
    expect(supervisor.loadNativeAuth({
      providerIds: ["amazon-bedrock"],
      expectedCatalogGeneration: snapshot.catalogGeneration
    }).credentials).toEqual({});
    expect(stringify(store.listSettings())).not.toContain('"models"');
    await supervisor.close();
    store.close();
  });

  it("returns a durable starting flow without waiting for Provider network discovery", async () => {
    const { store, providers, providerId } = await fixture();
    const networkGate = deferred<void>();
    const oauthProvider = {
      id: providerId,
      name: "Slow native subscription",
      getModels: () => [{ id: "native-model", api: "openai-responses", contextWindow: 128_000, maxTokens: 16_000 }],
      auth: { oauth: { isSubscription: true, refresh: async (credential: PiOAuthCredential) => credential } }
    };
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async () => ({
        getProviders: () => [oauthProvider],
        getProvider: (id: string) => id === providerId ? oauthProvider : undefined,
        login: async (_id: string, _type: "oauth", interaction: PiAuthInteraction) => {
          await waitForGate(networkGate, interaction.signal);
          throw new Error("unreachable after cancellation");
        },
        logout: async () => undefined
      })
    });

    const flow = await supervisor.beginLogin(providerId, "device_code");
    expect(flow.opaqueFlowId).toMatch(/^pflow_/u);
    expect(supervisor.getFlow(flow.opaqueFlowId)).toMatchObject({ state: "starting" });
    expect(stringify(store.listSettings())).toContain(flow.opaqueFlowId);
    expect(supervisor.cancel(flow.opaqueFlowId)).toMatchObject({ state: "cancelled" });
    await supervisor.close();
    store.close();
  });

  it("returns the native device flow before completion and seals the complete OAuth credential", async () => {
    const { root, credentials, store, providers, providerId } = await fixture();
    let runtime!: FakePiRuntime;
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => (runtime = new FakePiRuntime(credentialStore, providerId))
    });
    const generationBeforeLogin = providers.generation;

    const flow = await supervisor.beginLogin(providerId, "device_code");
    expect(flow).toMatchObject({ providerId, method: "device_code" });
    await expectFlowState(supervisor, flow.opaqueFlowId, "pending");
    expect(supervisor.getFlow(flow.opaqueFlowId)).toMatchObject({
      providerId,
      method: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://login.example.test/device"
    });
    expect(runtime.selections).toEqual(["device_code"]);
    expect(supervisor.getFlow(flow.opaqueFlowId)?.state).toBe("pending");
    expect(providers.get(providerId).authenticationState).toBe("pending");

    runtime.completeLogin();
    await expectFlowState(supervisor, flow.opaqueFlowId, "completed");
    expect(providers.get(providerId)).toMatchObject({ authenticationState: "authenticated" });
    const authenticatedSnapshot = await providers.createPiGenerationSnapshot({
      snapshotsRoot: join(root, "authenticated-generations")
    });
    expect(authenticatedSnapshot.nativeAuthenticatedProviderIds).toEqual([providerId]);
    expect(providers.generation).toBe(generationBeforeLogin + 1);
    expect(generationRefreshes).toBe(1);
    const native = providers.readNativeCredential(providerId);
    expect(JSON.parse(native?.serializedCredential ?? "{}")).toMatchObject({
      type: "oauth",
      access: "access-token-never-public",
      refresh: "refresh-token-never-public",
      accountId: "account-public-metadata"
    });
    const vaultFile = await readFile(join(root, "credential-records.json"), "utf8");
    expect(vaultFile).not.toContain("access-token-never-public");
    expect(vaultFile).not.toContain("refresh-token-never-public");
    expect(credentials.redactText("upstream access-token-never-public refresh-token-never-public"))
      .toBe("upstream [REDACTED] [REDACTED]");
    const operational = stringify(store.listSettings());
    expect(operational).not.toContain("access-token-never-public");
    expect(operational).not.toContain("refresh-token-never-public");
    expect(operational).toContain(flow.opaqueFlowId);

    await supervisor.close();
    const reloadedProviders = new ProviderCatalogManager({ store, credentials, now: () => NOW });
    reloadedProviders.initialize();
    const reloadedSupervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers: reloadedProviders,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async (credentialStore) => new FakePiRuntime(credentialStore, providerId)
    });
    expect(reloadedProviders.get(providerId)).toMatchObject({ authenticationState: "authenticated" });
    expect(JSON.parse(reloadedProviders.readNativeCredential(providerId)?.serializedCredential ?? "{}")).toMatchObject({
      refresh: "refresh-token-never-public"
    });
    await reloadedSupervisor.close();
    store.close();
    expect(credentials.list({ providerId })).toHaveLength(1);
  });

  it("activates only the authenticated managed Provider and preserves a later manual disable", async () => {
    const { credentials, store, providers, providerId } = await fixture("managed-disabled", true, false);
    await providers.upsert({
      provider: {
        id: "unrelated-disabled",
        api: "openai-responses",
        keyless: true,
        models: [{ id: "unrelated-model", contextWindow: 32_000, maxTokens: 4_000 }]
      },
      displayName: "Unrelated disabled Provider",
      kind: "custom_endpoint",
      credentialBindings: {},
      enabled: false,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });
    let runtime!: FakePiRuntime;
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => (runtime = new FakePiRuntime(credentialStore, providerId))
    });
    const generationBeforeLogin = providers.generation;

    const flow = await providers.beginLogin(providerId, "subscription");
    runtime.completeLogin();
    await expectFlowState(supervisor, flow.opaqueFlowId, "completed");

    expect(providers.get(providerId)).toMatchObject({ enabled: true, authenticationState: "authenticated" });
    expect(providers.get("unrelated-disabled").enabled).toBe(false);
    expect(providers.generation).toBe(generationBeforeLogin + 2);
    expect(generationRefreshes).toBe(1);
    const activatedReload = new ProviderCatalogManager({ store, credentials, now: () => NOW });
    activatedReload.initialize();
    expect(activatedReload.get(providerId)).toMatchObject({
      enabled: true,
      authenticationState: "authenticated"
    });
    expect(activatedReload.get("unrelated-disabled").enabled).toBe(false);

    await providers.upsert({
      provider: {
        id: providerId,
        api: "openai-responses",
        models: [{ id: "native-model", contextWindow: 128_000, maxTokens: 16_000 }]
      },
      displayName: "Native subscription",
      kind: "subscription",
      credentialBindings: {},
      enabled: false,
      supportsLogin: true,
      supportsLogout: true,
      supportsRefresh: true
    });
    await providers.refreshCredential(providerId);
    expect(providers.get(providerId)).toMatchObject({ enabled: false, authenticationState: "authenticated" });
    expect(providers.get("unrelated-disabled").enabled).toBe(false);

    await supervisor.close();
    const reloadedProviders = new ProviderCatalogManager({ store, credentials, now: () => NOW });
    reloadedProviders.initialize();
    expect(reloadedProviders.get(providerId)).toMatchObject({
      enabled: false,
      authenticationState: "authenticated"
    });
    expect(reloadedProviders.get("unrelated-disabled").enabled).toBe(false);
    store.close();
  });

  it("persists native ambient API-key auth across generations and restart, redacts it, and deletes it", async () => {
    const providerId = "amazon-bedrock";
    const { root, credentials, store, providers } = await fixture("unused", false);
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => new FakeApiKeyRuntime(credentialStore, providerId)
    });

    const flow = await providers.beginLogin(providerId, "api_key");
    const sourcePrompt = await expectFlowPrompt(supervisor, flow.opaqueFlowId, "select");
    supervisor.submitInput({
      flowId: flow.opaqueFlowId,
      promptId: sourcePrompt.promptId,
      connectionId: "settings-connection",
      answer: { case: "choice", optionId: "aws-profile" }
    });
    const profilePrompt = await expectFlowPrompt(supervisor, flow.opaqueFlowId, "text");
    supervisor.submitInput({
      flowId: flow.opaqueFlowId,
      promptId: profilePrompt.promptId,
      connectionId: "settings-connection",
      answer: { case: "text", text: "engineering-profile-private" }
    });
    await expectFlowState(supervisor, flow.opaqueFlowId, "completed");
    expect(providers.get(providerId)).toMatchObject({
      kind: "api_key",
      enabled: true,
      authenticationState: "authenticated",
      supportsLogin: true,
      supportsRefresh: false,
      supportsLogout: true
    });
    const generation = await providers.createPiGenerationSnapshot({ snapshotsRoot: join(root, "ambient-generations") });
    expect(generation.providers).toEqual([]);
    expect(generation.nativeAuthProviderIds).toContain(providerId);
    expect(generation.nativeAuthenticatedProviderIds).toContain(providerId);
    expect(generation.environment).toEqual({});
    expect(supervisor.loadNativeAuth({
      providerIds: [providerId],
      expectedCatalogGeneration: generation.catalogGeneration
    }).credentials[providerId]).toEqual({
      type: "api_key",
      env: { AWS_PROFILE: "engineering-profile-private" }
    });
    expect(credentials.redactText("using engineering-profile-private")).toBe("using [REDACTED]");
    expect(await readFile(join(root, "credential-records.json"), "utf8")).not.toContain("engineering-profile-private");
    expect(stringify(store.listSettings())).not.toContain("engineering-profile-private");
    expect(generationRefreshes).toBe(1);

    await supervisor.close();
    const reloadedProviders = new ProviderCatalogManager({ store, credentials, now: () => NOW });
    reloadedProviders.initialize();
    const reloaded = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers: reloadedProviders,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => new FakeApiKeyRuntime(credentialStore, providerId)
    });
    expect(reloadedProviders.get(providerId)).toMatchObject({ enabled: true, authenticationState: "authenticated" });
    expect(reloaded.loadNativeAuth({
      providerIds: [providerId],
      expectedCatalogGeneration: reloadedProviders.generation
    }).credentials[providerId]).toEqual({
      type: "api_key",
      env: { AWS_PROFILE: "engineering-profile-private" }
    });
    await expect(reloadedProviders.logout(providerId)).resolves.toMatchObject({
      enabled: false,
      authenticationState: "signed_out",
      credentialReferenceIds: []
    });
    expect(reloadedProviders.readNativeCredential(providerId)).toBeUndefined();
    expect(credentials.list({ providerId })).toEqual([]);
    await reloaded.close();
    store.close();
  });

  it("uses Pi's native refresh and logout while retaining no token in public outcomes", async () => {
    const { credentials, store, providers, providerId } = await fixture();
    let runtime!: FakePiRuntime;
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => (runtime = new FakePiRuntime(credentialStore, providerId))
    });
    const flow = await providers.beginLogin(providerId, "subscription");
    expect(runtime.selections).toEqual(["browser"]);
    runtime.completeLogin();
    await expectFlowState(supervisor, flow.opaqueFlowId, "completed");

    const loadedGeneration = providers.generation;
    expect(supervisor.loadNativeAuth({
      providerIds: [providerId],
      expectedCatalogGeneration: loadedGeneration
    }).credentials[providerId]).toMatchObject({ access: "access-token-never-public" });
    const persisted = await supervisor.persistNativeAuth({
      providerId,
      expectedCatalogGeneration: loadedGeneration,
      credential: {
        type: "oauth",
        access: "runtime-access-writeback",
        refresh: "runtime-refresh-writeback",
        expires: NOW + 90 * 60_000,
        accountId: "account-public-metadata"
      }
    });
    expect(persisted.catalogGeneration).toBeGreaterThan(loadedGeneration);
    expect(() => supervisor.loadNativeAuth({
      providerIds: [providerId],
      expectedCatalogGeneration: loadedGeneration
    })).toThrow(ProviderAuthGenerationConflictError);

    const refreshed = await providers.refreshCredential(providerId);
    expect(refreshed).not.toHaveProperty("secret");
    expect(JSON.parse(providers.readNativeCredential(providerId)?.serializedCredential ?? "{}")).toMatchObject({
      access: "access-token-after-refresh",
      refresh: "refresh-token-after-refresh"
    });
    expect(runtime.refreshCount).toBe(1);
    expect(generationRefreshes).toBe(3);

    const loggedOut = await providers.logout(providerId);
    expect(loggedOut.authenticationState).toBe("signed_out");
    expect(loggedOut.credentialReferenceIds).toEqual([]);
    expect(providers.readNativeCredential(providerId)).toBeUndefined();
    expect(credentials.list({ providerId })).toEqual([]);
    expect(generationRefreshes).toBe(4);
    await supervisor.close();
    store.close();
  });

  it("allows a fenced runtime to flush OAuth rotation during shutdown without rotating Pi again", async () => {
    const { store, providers, providerId } = await fixture();
    let runtime!: FakePiRuntime;
    let generationRefreshes = 0;
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => { generationRefreshes += 1; },
      runtimeFactory: async (credentialStore) => (runtime = new FakePiRuntime(credentialStore, providerId))
    });
    const flow = await supervisor.beginLogin(providerId, "device_code");
    runtime.completeLogin();
    await expectFlowState(supervisor, flow.opaqueFlowId, "completed");
    expect(generationRefreshes).toBe(1);

    const loadedGeneration = providers.generation;
    supervisor.beginShutdown();
    const persisted = await supervisor.persistNativeAuth({
      providerId,
      expectedCatalogGeneration: loadedGeneration,
      credential: {
        type: "oauth",
        access: "shutdown-access-rotation",
        refresh: "shutdown-refresh-rotation",
        expires: NOW + 2 * 60 * 60_000
      }
    });
    expect(generationRefreshes).toBe(1);
    expect(supervisor.loadNativeAuth({
      providerIds: [providerId],
      expectedCatalogGeneration: persisted.catalogGeneration
    }).credentials[providerId]).toMatchObject({ refresh: "shutdown-refresh-rotation" });
    await expect(supervisor.beginLogin(providerId, "device_code")).rejects.toThrow(/closing/u);
    await supervisor.close();
    store.close();
  });

  it("marks an interrupted durable flow outcome unknown and recovers it without token material", async () => {
    const { store, providers, providerId, credentials } = await fixture();
    let firstRuntime!: FakePiRuntime;
    const first = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async (credentialStore) => (firstRuntime = new FakePiRuntime(credentialStore, providerId))
    });
    const flow = await first.beginLogin(providerId, "device_code");
    expect(firstRuntime.selections).toEqual(["device_code"]);
    await first.close();
    expect(first.getFlow(flow.opaqueFlowId)).toMatchObject({ state: "outcome_unknown" });

    const reloadedProviders = new ProviderCatalogManager({ store, credentials, now: () => NOW });
    reloadedProviders.initialize();
    const second = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers: reloadedProviders,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async (credentialStore) => new FakePiRuntime(credentialStore, providerId)
    });
    expect(second.getFlow(flow.opaqueFlowId)).toMatchObject({
      state: "outcome_unknown",
      error: expect.stringContaining("unknown")
    });
    expect(stringify(store.listSettings())).not.toContain("token-never-public");
    await second.close();
    store.close();
  });

  it("retains every one of 129 concurrent active auth flows in memory and durable storage", async () => {
    const { credentials, store, providers } = await fixture("unused", false);
    const gate = deferred<void>();
    const nativeProviders = Array.from({ length: 129 }, (_unused, index) => ({
      id: `ambient-provider-${index.toString(10).padStart(3, "0")}`,
      name: `Ambient Provider ${index}`,
      getModels: () => [],
      auth: { apiKey: { name: "Ambient credentials" } }
    }));
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async () => ({
        getProviders: () => nativeProviders,
        getProvider: (providerId: string) => nativeProviders.find((provider) => provider.id === providerId),
        login: async (_providerId: string, _type: "api_key" | "oauth", interaction: PiAuthInteraction) => {
          await waitForGate(gate, interaction.signal);
          throw new Error("unreachable after shutdown");
        },
        logout: async () => undefined
      })
    });

    const flows = [];
    for (const provider of nativeProviders) flows.push(await supervisor.beginLogin(provider.id, "api_key"));
    expect(supervisor.listFlows()).toHaveLength(129);
    expect(supervisor.getFlow(flows[0]!.opaqueFlowId)).toMatchObject({
      providerId: nativeProviders[0]!.id,
      state: "starting"
    });
    const durable = store.findSetting<{ readonly format: 1; readonly flows: readonly unknown[] }>(
      "service",
      "orchestrator",
      "pi_provider_auth_flows"
    );
    expect(durable?.value.flows).toHaveLength(129);
    expect(stringify(durable?.value)).toContain(flows[0]!.opaqueFlowId);

    await supervisor.close();
    const reloadedProviders = new ProviderCatalogManager({ store, credentials, now: () => NOW });
    reloadedProviders.initialize();
    const reloaded = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers: reloadedProviders,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async () => ({
        getProviders: () => nativeProviders,
        getProvider: (providerId: string) => nativeProviders.find((provider) => provider.id === providerId),
        login: async () => { throw new Error("login should not run during recovery"); },
        logout: async () => undefined
      })
    });
    expect(reloaded.listFlows()).toHaveLength(129);
    expect(reloaded.getFlow(flows[0]!.opaqueFlowId)).toMatchObject({
      providerId: nativeProviders[0]!.id,
      state: "outcome_unknown",
      error: expect.stringContaining("unknown")
    });
    expect(store.findSetting<{ readonly recoveryRequiredFlowIds?: readonly string[] }>(
      "service",
      "orchestrator",
      "pi_provider_auth_flows"
    )?.value.recoveryRequiredFlowIds).toHaveLength(129);
    await reloaded.close();
    store.close();
  }, 20_000);

  it("cancels a pending native flow without committing a credential", async () => {
    const { store, providers, providerId, credentials } = await fixture();
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async (credentialStore) => new FakePiRuntime(credentialStore, providerId)
    });
    const flow = await supervisor.beginLogin(providerId, "device_code");
    expect(supervisor.cancel(flow.opaqueFlowId)).toMatchObject({ state: "cancelled" });
    await expectFlowState(supervisor, flow.opaqueFlowId, "cancelled");
    expect(() => supervisor.cancel(flow.opaqueFlowId)).toThrow(/not active/u);
    expect(credentials.list({ providerId })).toEqual([]);
    expect(providers.get(providerId).authenticationState).toBe("error");
    await supervisor.close();
    store.close();
  });

  it("times out a pending native flow and leaves the vault untouched", async () => {
    const { store, providers, providerId, credentials } = await fixture();
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      flowTimeoutMs: 1_000,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async (credentialStore) => new FakePiRuntime(credentialStore, providerId)
    });
    const flow = await supervisor.beginLogin(providerId, "device_code");
    await expectFlowState(supervisor, flow.opaqueFlowId, "timed_out");
    expect(credentials.list({ providerId })).toEqual([]);
    expect(providers.get(providerId)).toMatchObject({
      authenticationState: "error",
      error: "Provider login timed out."
    });
    await supervisor.close();
    store.close();
  });

  it("correlates a manual OAuth code through a one-time credential-channel ticket", async () => {
    const { credentials, store, providers, providerId } = await fixture();
    const promptingProvider = {
      id: providerId,
      name: "Prompting subscription",
      getModels: () => [{ id: "native-model", api: "openai-responses", contextWindow: 128_000, maxTokens: 16_000 }],
      auth: { oauth: { isSubscription: true, refresh: async (credential: PiOAuthCredential) => credential } }
    };
    const supervisor = await PiProviderAuthSupervisor.create({
      store,
      backendId: "managed-runtime",
      providers,
      now: () => NOW,
      refreshPiGeneration: async () => undefined,
      runtimeFactory: async () => ({
        getProviders: () => [promptingProvider],
        getProvider: (id: string) => id === providerId ? promptingProvider : undefined,
        login: async (_id: string, _type: "oauth", interaction: PiAuthInteraction) => {
          interaction.notify({
            type: "auth_url",
            url: "https://login.example.test/authorize?state=public-state"
          });
          const code = await interaction.prompt({
            type: "manual_code",
            message: "Paste secret authorization code or redirect URL",
            placeholder: "http://localhost/callback"
          });
          expect(code).toBe("https://localhost/callback?code=secret-one-time-code&state=public-state");
          return {
            type: "oauth",
            access: "access-after-manual-code",
            refresh: "refresh-after-manual-code",
            expires: NOW + 60 * 60_000
          };
        },
        logout: async () => undefined
      })
    });

    const flow = await providers.beginLogin(providerId, "subscription");
    const pending = supervisor.getFlow(flow.opaqueFlowId)?.pendingPrompt;
    expect(pending).toMatchObject({ kind: "manual_code" });
    expect(stringify(store.listSettings())).not.toContain("secret authorization code");
    expect(() => supervisor.submitInput({
      flowId: flow.opaqueFlowId,
      promptId: pending!.promptId,
      connectionId: "connection-a",
      answer: { case: "text", text: "must-not-bypass-channel" }
    })).toThrow(/credential upload channel/u);
    const ticket = supervisor.beginInputUpload({
      flowId: flow.opaqueFlowId,
      promptId: pending!.promptId,
      connectionId: "connection-a"
    });
    credentials.upload(
      ticket.credentialUploadTicketId,
      "https://localhost/callback?code=secret-one-time-code&state=public-state",
      "connection-a"
    );
    expect(supervisor.submitInput({
      flowId: flow.opaqueFlowId,
      promptId: pending!.promptId,
      connectionId: "connection-a",
      answer: { case: "credential_upload", credentialUploadTicketId: ticket.credentialUploadTicketId }
    }).pendingPrompt).toBeUndefined();
    expect(() => supervisor.submitInput({
      flowId: flow.opaqueFlowId,
      promptId: pending!.promptId,
      connectionId: "connection-a",
      answer: { case: "credential_upload", credentialUploadTicketId: ticket.credentialUploadTicketId }
    })).toThrow(/stale|does not exist/u);
    await expectFlowState(supervisor, flow.opaqueFlowId, "completed");
    expect(stringify(store.listSettings())).not.toContain("secret-one-time-code");
    await supervisor.close();
    store.close();
  });
});

async function expectFlowState(
  supervisor: PiProviderAuthSupervisor,
  flowId: string,
  state: PiProviderAuthFlowState
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (supervisor.getFlow(flowId)?.state === state) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Flow ${flowId} did not reach ${state}: ${JSON.stringify(supervisor.getFlow(flowId))}`);
}

async function expectFlowPrompt(
  supervisor: PiProviderAuthSupervisor,
  flowId: string,
  kind: PiProviderAuthPromptKind
): Promise<PiProviderAuthPromptRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const prompt = supervisor.getFlow(flowId)?.pendingPrompt;
    if (prompt?.kind === kind) return prompt;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Flow ${flowId} did not expose a ${kind} prompt: ${JSON.stringify(supervisor.getFlow(flowId))}`);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value?: T) => resolve(value as T) };
}

function waitForGate(gate: ReturnType<typeof deferred<void>>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return gate.promise;
  return Promise.race([
    gate.promise,
    new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })
  ]);
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
