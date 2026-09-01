import { readFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";

async function fixture(now = 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), "joko-credentials-"));
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({
    vault,
    storagePath: join(root, "credential-records.json"),
    now: () => now
  });
  await credentials.initialize();
  const store = new OperationalStore(join(root, "orchestrator.db"), { now: () => now });
  return { root, credentials, store, now };
}

describe("CredentialManager", () => {
  it("uses a one-time upload ticket and persists ciphertext without plaintext", async () => {
    const { root, credentials, store } = await fixture();
    const secret = "test-provider-secret-with-entropy";
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, secret);
    const descriptor = await credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_provider_test",
      displayName: "Test provider",
      kind: "api_key",
      providerId: "test"
    });

    expect(descriptor).toMatchObject({ credentialReferenceId: "cred_provider_test", configured: true });
    expect(credentials.resolve("cred_provider_test")).toBe(secret);
    expect(() => credentials.upload(ticket.credentialUploadTicketId, "second")).toThrow(/invalid|consumed/u);
    const durable = await readFile(join(root, "credential-records.json"), "utf8");
    expect(durable).not.toContain(secret);
    expect(durable).toContain("aes-256-gcm");
    const reopenedVault = await CredentialVault.open(join(root, "vault.key"));
    const reopened = new CredentialManager({ vault: reopenedVault, storagePath: join(root, "credential-records.json") });
    await reopened.initialize();
    expect(reopened.resolve("cred_provider_test")).toBe(secret);
    expect(stringify(store.listSettings())).not.toContain(secret);
    store.close();
  });

  it("rejects expired and oversized tickets", async () => {
    let now = 1_800_000_000_000;
    const root = await mkdtemp(join(tmpdir(), "joko-credential-expiry-"));
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({
      vault,
      storagePath: join(root, "records.json"),
      ticketTtlMs: 1_000,
      maximumSecretBytes: 8,
      now: () => now
    });
    await credentials.initialize();
    const expired = credentials.createUploadTicket();
    now += 1_001;
    expect(() => credentials.upload(expired.credentialUploadTicketId, "value")).toThrow(/expired/u);
    const bounded = credentials.createUploadTicket();
    expect(() => credentials.upload(bounded.credentialUploadTicketId, "123456789")).toThrow(/limit|policy/u);
  });

  it("binds upload tickets to the requesting connection, provider, and kind", async () => {
    const { credentials, store } = await fixture();
    const ticket = credentials.createUploadTicket({ kind: "api_key", providerId: "provider-a", connectionId: "connection-a" });
    expect(() => credentials.upload(ticket.credentialUploadTicketId, "attacker-secret", "connection-b")).toThrow(/connection/u);
    credentials.upload(ticket.credentialUploadTicketId, "bound-secret", "connection-a");
    await expect(credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_bound_test",
      displayName: "Bound",
      kind: "header_secret",
      providerId: "provider-a",
      connectionId: "connection-a"
    })).rejects.toThrow(/kind/u);
    await expect(credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_bound_test",
      displayName: "Bound",
      kind: "api_key",
      providerId: "provider-a",
      connectionId: "connection-b"
    })).rejects.toThrow(/connection/u);
    store.close();
  });

  it("keeps adapter-owned account credentials out of generic credential mutations", async () => {
    const { credentials, store, now } = await fixture();
    const reference = "cred_backend_subscription_test";
    credentials.reserveManagedSecret({
      credentialReferenceId: reference,
      kind: "subscription",
      providerId: "native-backend"
    });
    await expect(credentials.compareAndSetManagedSecret({
      credentialReferenceId: reference,
      expectedSecret: undefined,
      secret: "strict-oauth-record",
      displayName: "Native subscription",
      kind: "subscription",
      providerId: "native-backend",
      expiresAt: now + 60_000
    })).resolves.toBe(true);

    expect(credentials.list()).toEqual([]);
    await expect(credentials.replaceSecret(reference, "replacement-secret")).rejects.toThrow(/adapter-owned/iu);
    await expect(credentials.delete(reference)).rejects.toThrow(/adapter-owned/iu);

    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "generic-overwrite");
    await expect(credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: reference,
      displayName: "Generic overwrite",
      kind: "subscription",
      providerId: "native-backend"
    })).rejects.toThrow(/adapter-owned/iu);
    await expect(credentials.deleteManagedSecretIfCurrent(reference, "strict-oauth-record")).resolves.toBe(true);
    store.close();
  });

  it("binds a service-owned credential upload to one exact reserved surface", async () => {
    const { credentials, store } = await fixture();
    const reference = "cred_surface_image_generation";
    credentials.reserveManagedSecret({
      credentialReferenceId: reference,
      kind: "api_key",
      providerId: "provider-one"
    });
    const wrong = credentials.createUploadTicket({
      kind: "api_key",
      providerId: "provider-one",
      connectionId: "connection-one",
      credentialReferenceId: "cred_surface_other"
    });
    credentials.upload(wrong.credentialUploadTicketId, "wrong-surface-value", "connection-one");
    await expect(credentials.commitManagedUpload({
      credentialUploadTicketId: wrong.credentialUploadTicketId,
      credentialReferenceId: reference,
      displayName: "Image generation",
      kind: "api_key",
      providerId: "provider-one",
      connectionId: "connection-one"
    })).rejects.toThrow(/surface/u);

    const ticket = credentials.createUploadTicket({
      kind: "api_key",
      providerId: "provider-one",
      connectionId: "connection-one",
      credentialReferenceId: reference
    });
    credentials.upload(ticket.credentialUploadTicketId, "surface-secret-value", "connection-one");
    await expect(credentials.commitManagedUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: reference,
      displayName: "Image generation",
      kind: "api_key",
      providerId: "provider-one",
      connectionId: "connection-one"
    })).resolves.toMatchObject({ configured: true });
    expect(credentials.list()).toEqual([]);
    expect(credentials.resolve(reference)).toBe("surface-secret-value");
    await expect(credentials.deleteManagedSecret(reference)).resolves.toBe(true);
    store.close();
  });
});

describe("ProviderCatalogManager", () => {
  it("opens subscription account credentials only inside a generation-fenced callback", async () => {
    const { root, credentials, store, now } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, now: () => now });
    providers.initialize();
    await providers.registerNativeAuthProviders([{
      provider: { id: "runtime-subscription", models: [] },
      displayName: "Runtime subscription",
      kind: "subscription",
      accountUsageAvailable: true
    }]);
    await providers.persistNativeAuth({
      providerId: "runtime-subscription",
      credential: {
        type: "oauth",
        access: "access-secret-one",
        refresh: "refresh-secret-one",
        expires: now + 60_000,
        accountId: "account-one"
      },
      expectedCatalogGeneration: providers.generation
    });

    const identity = providers.describeProviderAccountUsage("runtime-subscription");
    expect(identity).toBeDefined();
    await expect(providers.useProviderAccountUsageCredential(identity!, async (credential) => ({ ...credential })))
      .resolves.toEqual({ accessToken: "access-secret-one", accountId: "account-one" });

    const leasedIdentity = providers.describeNativeAuthLease("runtime-subscription");
    const leasedGeneration = providers.generation;
    expect(leasedIdentity).toMatchObject({ authenticated: true, catalogGeneration: leasedGeneration });
    expect(leasedIdentity.accountId).toMatch(/^[a-f0-9]{64}$/u);
    await expect(providers.persistNativeAuth({
      providerId: "runtime-subscription",
      credential: {
        type: "oauth",
        access: "lease-switch-access",
        refresh: "lease-switch-refresh",
        expires: now + 90_000,
        accountId: "account-two"
      },
      expectedCatalogGeneration: leasedGeneration,
      expectedAccountId: leasedIdentity.accountId
    })).rejects.toThrow(/account identity changed/iu);
    expect(providers.generation).toBe(leasedGeneration);
    expect(JSON.parse(providers.readNativeCredential("runtime-subscription")?.serializedCredential ?? "{}"))
      .toMatchObject({ accountId: "account-one", access: "access-secret-one" });

    await providers.persistNativeAuth({
      providerId: "runtime-subscription",
      credential: {
        type: "oauth",
        access: "access-secret-two",
        refresh: "refresh-secret-two",
        expires: now + 120_000,
        accountId: "account-two"
      },
      expectedCatalogGeneration: providers.generation
    });
    await expect(providers.useProviderAccountUsageCredential(identity!, async () => "unreachable"))
      .rejects.toThrow(/generation is stale/u);
    const refreshCredential = vi.fn(async () => undefined);
    providers.attachNativeAuth({
      canHandle: () => true,
      beginLogin: async () => { throw new Error("not used"); },
      refreshCredential,
      logout: async () => undefined
    });
    await providers.recoverProviderAccountUsageAuthorization(identity!);
    expect(refreshCredential).not.toHaveBeenCalled();
    await providers.recoverProviderAccountUsageAuthorization(
      providers.describeProviderAccountUsage("runtime-subscription")!
    );
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(stringify(store.listSettings())).not.toContain("access-secret");
    expect(await readFile(join(root, "credential-records.json"), "utf8")).not.toContain("access-secret");
    store.close();
  });

  it("adds only newly discovered models and keeps them hidden by default", async () => {
    const { credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials });
    providers.initialize();
    await providers.upsert({
      provider: {
        id: "discoverable",
        baseUrl: "https://models.example.test/v1",
        api: "openai-responses",
        apiKeyEnv: "DISCOVERY_API_KEY",
        models: [{ id: "kept", name: "Kept", contextWindow: 32_000, maxTokens: 4_000 }]
      },
      displayName: "Discoverable",
      kind: "custom_endpoint",
      credentialBindings: {},
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "discovery-secret-value");
    await providers.commitCredential({
      providerId: "discoverable",
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_discovery_test",
      displayName: "Discovery key",
      kind: "api_key"
    });
    const request = async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer discovery-secret-value");
      return new Response(JSON.stringify({ data: [
        { id: "kept", name: "Renamed upstream" },
        { id: "new-model", name: "New model", context_window: 1_000_000 }
      ] }), { status: 200 });
    };

    await expect(providers.discoverProviderModels("discoverable", request as typeof fetch)).resolves.toEqual({
      providerId: "discoverable",
      addedModelIds: ["new-model"],
      modelCount: 2
    });
    expect(providers.get("discoverable")).toMatchObject({ supportsModelRefresh: true });
    expect(providers.get("discoverable").provider.models).toEqual([
      { id: "kept", name: "Kept", contextWindow: 32_000, maxTokens: 4_000 },
      { id: "new-model", name: "New model", contextWindow: 1_000_000, maxTokens: 16_384, defaultVisible: false }
    ]);
    await expect(providers.discoverProviderModels("discoverable", request as typeof fetch)).resolves.toMatchObject({
      addedModelIds: [],
      modelCount: 2
    });
    expect(stringify(store.listSettings())).not.toContain("discovery-secret-value");
    store.close();
  });

  it("requires an unambiguous pinned HTTPS embedding route, with loopback HTTP as the only exception", async () => {
    const { credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials });
    providers.initialize();
    const upsertKeyless = async (id: string, baseUrl: string) => providers.upsert({
      provider: {
        id,
        baseUrl,
        api: "openai-completions",
        keyless: true,
        models: [{ id: "voyage/voyage-4", name: "Voyage 4", contextWindow: 32_768, maxTokens: 4_096 }]
      },
      displayName: id,
      kind: "custom_endpoint" as const,
      credentialBindings: {},
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: true
    });

    await upsertKeyless("remote-http", "http://embedding.example/v1");
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4")).toBeUndefined();
    await upsertKeyless("loopback", "http://127.0.0.1:11434/v1");
    const firstLoopbackGeneration = providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4");
    expect(firstLoopbackGeneration).toMatchObject({
      providerId: "loopback",
      endpoint: "http://127.0.0.1:11434/v1/embeddings"
    });
    expect(firstLoopbackGeneration?.generationId).toMatch(/^[a-f0-9]{64}$/u);
    await upsertKeyless("loopback", "http://127.0.0.1:11434/v1");
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4")?.generationId)
      .not.toBe(firstLoopbackGeneration?.generationId);
    await upsertKeyless("secure", "https://embedding.example/v1");
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4")).toBeUndefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", "secure")).toMatchObject({
      providerId: "secure",
      endpoint: "https://embedding.example/v1/embeddings"
    });
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", "remote-http")).toBeUndefined();
    store.close();
  });

  it("applies model access policy to every direct inference route and Pi generation", async () => {
    const { root, credentials, store } = await fixture();
    let providerAllowed = true;
    let modelAllowed = true;
    const providers = new ProviderCatalogManager({
      store,
      credentials,
      providerEnabled: () => providerAllowed,
      modelEnabled: () => modelAllowed
    });
    providers.initialize();
    await providers.upsert({
      provider: {
        id: "policy-route",
        baseUrl: "https://policy.example.test/v1",
        api: "openai-responses",
        keyless: true,
        models: [{ id: "voyage/voyage-4", name: "Policy route" }]
      },
      displayName: "Policy route",
      kind: "custom_endpoint",
      credentialBindings: {},
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });

    expect(providers.resolveInferenceRoute("policy-route", "voyage/voyage-4")).toBeDefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", "policy-route")).toBeDefined();

    providerAllowed = false;
    expect(providers.resolveInferenceRoute("policy-route", "voyage/voyage-4")).toBeUndefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", "policy-route")).toBeUndefined();
    await expect(providers.createPiGenerationSnapshot({
      snapshotsRoot: join(root, "provider-disabled-snapshot")
    })).resolves.toMatchObject({ providers: [] });

    providerAllowed = true;
    modelAllowed = false;
    expect(providers.hasInferenceModel("policy-route", "voyage/voyage-4")).toBe(false);
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", "policy-route")).toBeUndefined();
    await expect(providers.createPiGenerationSnapshot({
      snapshotsRoot: join(root, "model-disabled-snapshot")
    })).resolves.toMatchObject({ providers: [] });

    modelAllowed = true;
    expect(providers.resolveInferenceRoute("policy-route", "voyage/voyage-4")).toBeDefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", "policy-route")).toBeDefined();
    store.close();
  });

  it("joins opaque references only in memory and creates an immutable Pi generation snapshot", async () => {
    const { root, credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials });
    providers.initialize();
    await providers.upsert({
      provider: {
        id: "byom",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKeyEnv: "BYOM_API_KEY",
        models: [{ id: "local-model", name: "Local model", contextWindow: 32_768, maxTokens: 4_096 }]
      },
      displayName: "Local BYOM",
      kind: "custom_endpoint",
      credentialBindings: {},
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: true
    });
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "byom-secret-value");
    await providers.commitCredential({
      providerId: "byom",
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_byom_test",
      displayName: "BYOM key",
      kind: "api_key"
    });

    const snapshot = await providers.createPiGenerationSnapshot({ snapshotsRoot: join(root, "provider-snapshots") });
    const modelsFile = await readFile(join(snapshot.agentHome, "models.json"), "utf8");
    expect(modelsFile).toContain("$BYOM_API_KEY");
    expect(modelsFile).not.toContain("byom-secret-value");
    expect(snapshot.environment).toEqual({ BYOM_API_KEY: "byom-secret-value" });
    expect(providers.get("byom").authenticationState).toBe("authenticated");
    expect(stringify(store.listSettings())).not.toContain("byom-secret-value");
    const reloaded = new ProviderCatalogManager({ store, credentials });
    reloaded.initialize();
    expect(reloaded.get("byom")).toMatchObject({
      authenticationState: "authenticated",
      credentialReferenceIds: ["cred_byom_test"]
    });
    store.close();
  });

  it("logs out without returning secret material", async () => {
    const { credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials });
    providers.initialize();
    await providers.upsert({
      provider: {
        id: "cloud",
        api: "anthropic-messages",
        apiKeyEnv: "CLOUD_API_KEY",
        models: [{ id: "model", contextWindow: 10_000, maxTokens: 1_000 }]
      },
      displayName: "Cloud",
      kind: "api_key",
      credentialBindings: {},
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "initial-secret");
    const committed = await providers.commitCredential({
      providerId: "cloud",
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_cloud_test",
      displayName: "Cloud key",
      kind: "api_key"
    });
    expect(await providers.logout("cloud")).toMatchObject({ authenticationState: "signed_out" });
    expect(credentials.find(committed.credentialReferenceId)).toBeUndefined();
    store.close();
  });
});

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
