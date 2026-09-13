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
  it("claims new service credentials privately and leaves mismatched tickets with their original owner", async () => {
    const { credentials, store } = await fixture();
    try {
      const ticket = credentials.createUploadTicket({ kind: "api_key", connectionId: "owner" });
      credentials.upload(ticket.credentialUploadTicketId, "private-service-key", "owner");
      const input = { credentialUploadTicketId: ticket.credentialUploadTicketId, displayName: "Voice input key",
        kind: "api_key" as const, connectionId: "owner", onReserved: vi.fn() };
      await expect(credentials.commitNewManagedUpload({ ...input, connectionId: "other" })).rejects.toThrow("does not authorize");
      await expect(credentials.commitNewManagedUpload({ ...input, displayName: "" })).rejects.toThrow();
      expect(input.onReserved).not.toHaveBeenCalled();
      const committing = credentials.commitNewManagedUpload(input);
      await expect(credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId,
        displayName: "Other surface", kind: "api_key", connectionId: "owner" })).rejects.toThrow("invalid, expired, or already consumed");
      expect(credentials.list()).toEqual([]);
      const credential = await committing;
      expect(input.onReserved).toHaveBeenCalledExactlyOnceWith(credential.credentialReferenceId);
      expect(credentials.resolve(credential.credentialReferenceId)).toBe("private-service-key");
      await expect(credentials.delete(credential.credentialReferenceId)).rejects.toThrow("Adapter-owned");
      await expect(credentials.retireManagedCredential(credential.credentialReferenceId, "different-generation")).resolves.toBe(false);
      expect(credentials.find(credential.credentialReferenceId)).toBeDefined();
      await expect(credentials.retireManagedCredential(credential.credentialReferenceId, credential.generation)).resolves.toBe(true);
      expect(credentials.find(credential.credentialReferenceId)).toBeUndefined();
      const other = credentials.createUploadTicket({ kind: "api_key", providerId: "provider-owner", connectionId: "owner" });
      credentials.upload(other.credentialUploadTicketId, "provider-key", "owner");
      await expect(credentials.commitNewManagedUpload({ ...input, credentialUploadTicketId: other.credentialUploadTicketId })).rejects.toThrow("does not authorize");
      await expect(credentials.commitUpload({ credentialUploadTicketId: other.credentialUploadTicketId,
        kind: "api_key", providerId: "provider-owner", displayName: "Provider", connectionId: "owner" })).resolves.toMatchObject({ configured: true });
    } finally { store.close(); }
  });

  it("consumes SSH passphrases only once for the exact connection, purpose and key without a durable credential", async () => {
    const { credentials, store } = await fixture();
    const binding = { connectionId: "connection-a", purpose: "agent_add" as const, keyId: "id_joko", expectedFingerprint: "SHA256:identity" };
    const ticket = credentials.createSshKeyPassphraseTicket(binding);
    credentials.upload(ticket.credentialUploadTicketId, "ephemeral SSH passphrase", binding.connectionId);
    const input = { ...binding, credentialUploadTicketId: ticket.credentialUploadTicketId };
    for (const changed of [{ connectionId: "connection-b" }, { purpose: "generate" as const }, { keyId: "other" }, { expectedFingerprint: "SHA256:replacement" }]) {
      expect(() => credentials.consumeSshKeyPassphrase({ ...input, ...changed })).toThrow("does not match");
    }
    await expect(credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, displayName: "SSH", kind: "api_key", connectionId: binding.connectionId })).rejects.toThrow("cannot be committed");
    expect(credentials.consumeSshKeyPassphrase(input)).toBe("ephemeral SSH passphrase");
    expect(() => credentials.consumeSshKeyPassphrase(input)).toThrow("invalid, expired, or already consumed");
    expect(credentials.list()).toEqual([]);
    const ordinary = credentials.createUploadTicket({ connectionId: binding.connectionId });
    credentials.upload(ordinary.credentialUploadTicketId, "ordinary value", binding.connectionId);
    expect(() => credentials.consumeSshKeyPassphrase({ ...input, credentialUploadTicketId: ordinary.credentialUploadTicketId })).toThrow("does not match");
    store.close();
  });

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
  it("describes managed inference readiness without opening secrets and fences every credential replacement", async () => {
    const { credentials, store, now } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    const upload = async (reference: string, value: string) => {
      const ticket = credentials.createUploadTicket();
      credentials.upload(ticket.credentialUploadTicketId, value);
      await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId,
        credentialReferenceId: reference, displayName: "Inference credential", kind: "api_key", providerId: "inference" });
    };
    await upload("cred_inference_key", "first-key-value");
    await upload("cred_inference_header", "first-header-value");
    const entry = {
      backendId: "pi", credentialOrigin: "https://provider.invalid",
      provider: { id: "inference", baseUrl: "https://provider.invalid/v1", api: "openai-completions" as const,
        apiKeyEnv: "INFERENCE_API_KEY", headers: { "x-private-header": { env: "INFERENCE_HEADER" } },
        models: [{ id: "text-model", input: ["text"] as const }] },
      displayName: "Inference", kind: "custom_endpoint" as const, enabled: true,
      credentialBindings: { INFERENCE_API_KEY: "cred_inference_key", INFERENCE_HEADER: "cred_inference_header" },
      supportsLogin: false, supportsLogout: true, supportsRefresh: false
    };
    await providers.upsert(entry);
    const resolve = vi.spyOn(credentials, "resolve");
    const first = providers.describeInferenceRoute("pi", "inference", "text-model");
    expect(first).toBeDefined();
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toContain("first-key-value");
    expect(JSON.stringify(first)).not.toContain("cred_inference");
    const catalogGeneration = providers.generation;
    await credentials.replaceSecret("cred_inference_key", "second-key-value");
    const second = providers.describeInferenceRoute("pi", "inference", "text-model");
    expect(second).not.toEqual(first);
    expect(providers.generation).toBe(catalogGeneration);
    await credentials.replaceSecret("cred_inference_header", "second-header-value");
    const third = providers.describeInferenceRoute("pi", "inference", "text-model");
    expect(third).not.toEqual(second);
    await credentials.delete("cred_inference_header");
    expect(providers.describeInferenceRoute("pi", "inference", "text-model")).toBeUndefined();
    await upload("cred_inference_header", "second-header-value");
    expect(providers.describeInferenceRoute("pi", "inference", "text-model")).not.toEqual(third);
    await credentials.replaceSecret("cred_inference_header", "expired-header-value", { expiresAt: now - 1, refreshedAt: now - 1_000 });
    expect(providers.describeInferenceRoute("pi", "inference", "text-model")).toBeUndefined();
    await credentials.replaceSecret("cred_inference_header", "current-header-value", { expiresAt: now + 60_000 });
    const beforeDelete = providers.describeInferenceRoute("pi", "inference", "text-model");
    await providers.delete("inference");
    expect(providers.describeInferenceRoute("pi", "inference", "text-model")).toBeUndefined();
    await providers.upsert(entry);
    expect(providers.describeInferenceRoute("pi", "inference", "text-model")).not.toEqual(beforeDelete);
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockRestore();
    store.close();
  });

  it("opens subscription account credentials only inside a generation-fenced callback", async () => {
    const { root, credentials, store, now } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi", now: () => now });
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
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "discovery-secret-value");
    await credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_discovery_test",
      displayName: "Discovery key",
      kind: "api_key"
    });
    await providers.upsert({
      backendId: "pi", credentialOrigin: "https://models.example.test",
      provider: {
        id: "discoverable",
        baseUrl: "https://models.example.test/v1",
        api: "openai-responses",
        apiKeyEnv: "DISCOVERY_API_KEY",
        models: [{ id: "kept", name: "Kept", contextWindow: 32_000, maxTokens: 4_000 }]
      },
      displayName: "Discoverable",
      kind: "custom_endpoint",
      credentialBindings: { DISCOVERY_API_KEY: "cred_discovery_test" },
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });
    const request = async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer discovery-secret-value");
      return new Response(JSON.stringify({ data: [
        { id: "kept", name: "Renamed upstream" },
        { id: "new-model", name: "New model", context_window: 1_000_000 }
      ] }), { status: 200 });
    };

    await expect(providers.discoverProviderModels("pi", "discoverable", request as typeof fetch)).resolves.toEqual({
      providerId: "discoverable",
      addedModelIds: ["new-model"],
      modelCount: 2
    });
    expect(providers.get("pi", "discoverable")).toMatchObject({ supportsModelRefresh: true });
    expect(providers.get("pi", "discoverable").provider.models).toEqual([
      { id: "kept", name: "Kept", contextWindow: 32_000, maxTokens: 4_000 },
      { id: "new-model", name: "New model", contextWindow: 1_000_000, maxTokens: 16_384, defaultVisible: false }
    ]);
    await expect(providers.discoverProviderModels("pi", "discoverable", request as typeof fetch)).resolves.toMatchObject({
      addedModelIds: [],
      modelCount: 2
    });
    expect(stringify(store.listSettings())).not.toContain("discovery-secret-value");
    store.close();
  });

  it("requires an unambiguous pinned HTTPS embedding route, with loopback HTTP as the only exception", async () => {
    const { root, credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "backend-a" });
    providers.initialize();
    const upsertKeyless = async (backendId: string, id: string, baseUrl: string) => providers.upsert({
      backendId,
      credentialOrigin: "",
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

    await upsertKeyless("backend-a", "remote-http", "http://embedding.example/v1");
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4")).toBeUndefined();
    await upsertKeyless("backend-a", "loopback", "http://127.0.0.1:11434/v1");
    const firstLoopbackGeneration = providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4");
    expect(firstLoopbackGeneration).toMatchObject({
      backendId: "backend-a",
      providerId: "loopback",
      endpoint: "http://127.0.0.1:11434/v1/embeddings"
    });
    expect(firstLoopbackGeneration?.generationId).toMatch(/^[a-f0-9]{64}$/u);
    await upsertKeyless("backend-a", "loopback", "http://127.0.0.1:11434/v1");
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4")?.generationId)
      .not.toBe(firstLoopbackGeneration?.generationId);
    await upsertKeyless("backend-a", "secure", "https://embedding.example/v1");
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4")).toBeUndefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "backend-a", providerId: "secure" })).toMatchObject({
      providerId: "secure",
      endpoint: "https://embedding.example/v1/embeddings"
    });
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "backend-a", providerId: "remote-http" })).toBeUndefined();
    await upsertKeyless("backend-b", "secure", "https://embedding.example/v1");
    const first = providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "backend-a", providerId: "secure" });
    const second = providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "backend-b", providerId: "secure" });
    expect(first?.backendId).toBe("backend-a");
    expect(second?.backendId).toBe("backend-b");
    expect(first?.generationId).not.toBe(second?.generationId);
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "removed-backend", providerId: "secure" })).toBeUndefined();
    const originalRevision = providers.get("backend-a", "secure").version;
    const foreignRuntime = providers.get("backend-b", "secure");
    await expect(providers.deleteRuntime("backend-a", "secure", { expectedVersion: originalRevision + 1n }))
      .rejects.toThrow("changed concurrently");
    expect(providers.get("backend-a", "secure").version).toBe(originalRevision);
    await expect(providers.deleteRuntime("backend-a", "secure", { expectedVersion: originalRevision })).resolves.toBe(true);
    expect(providers.listConfigurations().find((value) => value.providerId === "secure")?.runtimes.map((value) => value.backendId))
      .toEqual(["backend-b"]);
    expect(providers.get("backend-b", "secure").provider).toEqual(foreignRuntime.provider);
    expect(providers.get("backend-b", "secure").version).toBeGreaterThan(foreignRuntime.version);
    store.close();
    const reopenedStore = new OperationalStore(join(root, "orchestrator.db"));
    try {
      const reopened = new ProviderCatalogManager({ store: reopenedStore, credentials, nativeBackendId: "backend-a" });
      reopened.initialize();
      expect(reopened.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "backend-a", providerId: "secure" })).toBeUndefined();
      expect(reopened.get("backend-b", "secure").provider).toEqual(foreignRuntime.provider);
      expect(reopened.get("backend-b", "secure").version).toBeGreaterThan(foreignRuntime.version);
    } finally { reopenedStore.close(); }
  });

  it("applies model access policy to every direct inference route and Pi generation", async () => {
    const { root, credentials, store } = await fixture();
    let providerAllowed = true;
    let modelAllowed = true;
    const providers = new ProviderCatalogManager({
      store,
      credentials,
      nativeBackendId: "pi",
      providerEnabled: () => providerAllowed,
      modelEnabled: () => modelAllowed
    });
    providers.initialize();
    await providers.upsert({
      backendId: "pi", credentialOrigin: "",
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

    expect(providers.resolveInferenceRoute("pi", "policy-route", "voyage/voyage-4")).toBeDefined();
    expect(providers.describeInferenceRoute("pi", "policy-route", "voyage/voyage-4")).toBeDefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "pi", providerId: "policy-route" })).toBeDefined();

    providerAllowed = false;
    expect(providers.describeInferenceRoute("pi", "policy-route", "voyage/voyage-4")).toBeUndefined();
    expect(providers.resolveInferenceRoute("pi", "policy-route", "voyage/voyage-4")).toBeUndefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "pi", providerId: "policy-route" })).toBeUndefined();
    await expect(providers.createPiGenerationSnapshot({
      snapshotsRoot: join(root, "provider-disabled-snapshot")
    })).resolves.toMatchObject({ providers: [] });

    providerAllowed = true;
    modelAllowed = false;
    expect(providers.describeInferenceRoute("pi", "policy-route", "voyage/voyage-4")).toBeUndefined();
    expect(providers.hasInferenceModel("pi", "policy-route", "voyage/voyage-4")).toBe(false);
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "pi", providerId: "policy-route" })).toBeUndefined();
    await expect(providers.createPiGenerationSnapshot({
      snapshotsRoot: join(root, "model-disabled-snapshot")
    })).resolves.toMatchObject({ providers: [] });

    modelAllowed = true;
    expect(providers.resolveInferenceRoute("pi", "policy-route", "voyage/voyage-4")).toBeDefined();
    expect(providers.resolveOpenAiEmbeddingRoute("voyage/voyage-4", { backendId: "pi", providerId: "policy-route" })).toBeDefined();
    store.close();
  });

  it("joins opaque references only in memory and creates an immutable Pi generation snapshot", async () => {
    const { root, credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "byom-secret-value");
    await credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_byom_test",
      displayName: "BYOM key",
      kind: "api_key"
    });
    await providers.upsert({
      backendId: "pi", credentialOrigin: "http://127.0.0.1:11434",
      provider: {
        id: "byom",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKeyEnv: "BYOM_API_KEY",
        models: [{ id: "local-model", name: "Local model", contextWindow: 32_768, maxTokens: 4_096 }]
      },
      displayName: "Local BYOM",
      kind: "custom_endpoint",
      credentialBindings: { BYOM_API_KEY: "cred_byom_test" },
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: true
    });

    const snapshot = await providers.createPiGenerationSnapshot({ snapshotsRoot: join(root, "provider-snapshots") });
    const modelsFile = await readFile(join(snapshot.agentHome, "models.json"), "utf8");
    expect(modelsFile).toContain("$BYOM_API_KEY");
    expect(modelsFile).not.toContain("byom-secret-value");
    expect(snapshot.environment).toEqual({ BYOM_API_KEY: "byom-secret-value" });
    expect(providers.get("pi", "byom").authenticationState).toBe("authenticated");
    expect(stringify(store.listSettings())).not.toContain("byom-secret-value");
    const reloaded = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    reloaded.initialize();
    expect(reloaded.get("pi", "byom")).toMatchObject({
      authenticationState: "authenticated",
      credentialReferenceIds: ["cred_byom_test"]
    });
    store.close();
  });

  it("unlinks the native Provider at logout without deleting independently owned credentials", async () => {
    const { credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "initial-secret");
    const committed = await credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_cloud_test",
      displayName: "Cloud key",
      kind: "api_key"
    });
    await providers.upsert({
      backendId: "pi", credentialOrigin: "https://cloud.example",
      provider: {
        id: "cloud",
        baseUrl: "https://cloud.example/v1",
        api: "anthropic-messages",
        apiKeyEnv: "CLOUD_API_KEY",
        models: [{ id: "model", contextWindow: 10_000, maxTokens: 1_000 }]
      },
      displayName: "Cloud",
      kind: "api_key",
      credentialBindings: { CLOUD_API_KEY: "cred_cloud_test" },
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });
    const result = await providers.logout("cloud");
    expect(result).toMatchObject({ authenticationState: "signed_out", credentialReferenceIds: [] });
    expect(stringify(result)).not.toContain("initial-secret");
    expect(credentials.find(committed.credentialReferenceId)).toMatchObject({ configured: true });
    expect(credentials.resolve(committed.credentialReferenceId)).toBe("initial-secret");
    store.close();
  });
});

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
