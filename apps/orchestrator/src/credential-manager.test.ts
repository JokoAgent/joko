import { mkdir, readFile, rename, rmdir } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { GEMINI_CHAT_ENDPOINT } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { provisionManagedCatalog, type PiManagedModel } from "@joko/adapter-pi";
import { describe, expect, it, vi } from "vitest";

import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

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
  it("opens only the exact official account's key and retires a late balance after credential replacement", async () => {
    const { credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); providers.initialize();
    try {
      const ticket = credentials.createUploadTicket({ kind: "api_key" }); credentials.upload(ticket.credentialUploadTicketId, "first-account-key");
      await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "balance-key", displayName: "Key", kind: "api_key" });
      const entry = { backendId: "pi", credentialOrigin: "https://api.deepseek.com", provider: { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions" as const,
        apiKeyEnv: "DEEPSEEK_KEY", models: [{ id: "balance-fixture", defaultVisible: false }] }, credentialBindings: { DEEPSEEK_KEY: "balance-key" }, enabled: true, displayName: "DeepSeek", kind: "api_key" as const, supportsLogin: false, supportsLogout: true, supportsRefresh: false };
      await providers.upsert(entry);
      const resolve = vi.spyOn(credentials, "resolve"), first = providers.describeAccountBalance("pi", "deepseek")!;
      const originalRevision = providers.get("pi", "deepseek").accountBalanceRevision;
      expect(originalRevision).toBeTruthy(); expect(resolve).not.toHaveBeenCalled();
      await expect(providers.useAccountBalanceCredential(first, async key => key)).resolves.toBe("first-account-key");
      let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
      const pending = providers.useAccountBalanceCredential(first, async () => { await gate; return "old-account-result"; });
      await credentials.replaceSecret("balance-key", "replacement-key"); finish();
      await expect(pending).rejects.toThrow("original Provider credential changed");
      expect(providers.get("pi", "deepseek").accountBalanceRevision).not.toBe(originalRevision);
      await expect(providers.useAccountBalanceCredential(first, async () => "never")).rejects.toThrow();
      expect(providers.describeAccountBalance("other", "deepseek")).toBeUndefined();
      await providers.upsert({ ...entry, provider: { ...entry.provider, baseUrl: "https://proxy.example/v1" }, credentialBindings: {}, credentialOrigin: "https://proxy.example" });
      expect(providers.describeAccountBalance("pi", "deepseek")).toBeUndefined();
      resolve.mockRestore();
    } finally { store.close(); }
  });
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

  it.each([false, true])("claims a %s managed upload before its persistence await", async (managed) => {
    const { credentials, store } = await fixture();
    const reference = managed ? "cred_surface_concurrent" : "cred_user_concurrent";
    if (managed) credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "api_key" });
    const ticket = credentials.createUploadTicket({ kind: "api_key", connectionId: "owner",
      ...(managed ? { credentialReferenceId: reference } : {}) });
    credentials.upload(ticket.credentialUploadTicketId, "one-time-value", "owner");
    const input = { credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: reference,
      displayName: "Concurrent upload", kind: "api_key" as const, connectionId: "owner" };
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      started();
      await waiting;
      await actual.rename(source, destination);
    });
    const commit = () => managed ? credentials.commitManagedUpload(input) : credentials.commitUpload(input);
    const committing = commit();
    try {
      await entered;
      await expect(managed ? commit() : credentials.commitUpload({ ...input, credentialReferenceId: "cred_other" }))
        .rejects.toThrow("invalid, expired, or already consumed");
    } finally {
      release();
      await committing;
      store.close();
    }
    expect(credentials.find("cred_other")).toBeUndefined();
    await expect(commit()).rejects.toThrow("invalid, expired, or already consumed");
  });

  it.each([false, true])("restores a %s managed upload to its original owner after persistence failure", async (managed) => {
    const { root, credentials, store } = await fixture();
    const reference = managed ? "cred_surface_retry" : "cred_user_retry";
    if (managed) credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: "api_key" });
    const ticket = credentials.createUploadTicket({ kind: "api_key", connectionId: "owner",
      ...(managed ? { credentialReferenceId: reference } : {}) });
    credentials.upload(ticket.credentialUploadTicketId, "retry-value", "owner");
    const input = { credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: reference,
      displayName: "Retry upload", kind: "api_key" as const, connectionId: "owner" };
    const commit = () => managed ? credentials.commitManagedUpload(input) : credentials.commitUpload(input);
    const path = join(root, "credential-records.json");
    await mkdir(path);
    try {
      await expect(commit()).rejects.toThrow("persistence failed");
      expect(credentials.find(reference)).toBeUndefined();
      await rmdir(path);
      await expect(commit()).resolves.toMatchObject({ configured: true, credentialReferenceId: reference });
      expect(credentials.resolve(reference)).toBe("retry-value");
    } finally { store.close(); }
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
    await expect(credentials.commitUpload({
      credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_user_redirected",
      displayName: "Redirected surface",
      kind: "api_key",
      providerId: "provider-one",
      connectionId: "connection-one"
    })).rejects.toThrow(/surface/u);
    expect(credentials.find("cred_user_redirected")).toBeUndefined();
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
  it("retains the exact Gemini image credential through rename and restart and retires it on replacement or deletion", async () => {
    const { credentials, store } = await fixture();
    const open = () => {
      const catalog = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
      catalog.initialize();
      return catalog;
    };
    const reference = "gemini-connection-key";
    const ticket = credentials.createUploadTicket({ kind: "api_key" });
    credentials.upload(ticket.credentialUploadTicketId, "first-google-studio-key");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: reference,
      displayName: "Google AI Studio", kind: "api_key" });
    const input = (providerId: string, endpoint = GEMINI_CHAT_ENDPOINT, catalogPresetId?: string) => ({
      providerId, displayName: "Google AI Studio", kind: "custom_endpoint" as const, enabled: true, expectedVersion: 0n,
      runtimes: [{ backendId: "pi", credentialOrigin: new URL(endpoint).origin, credentialBindings: { GOOGLE_KEY: reference },
        provider: { id: providerId, ...(catalogPresetId === undefined ? {} : { catalogPresetId }), baseUrl: endpoint,
          api: "openai-completions" as const, apiKeyEnv: "GOOGLE_KEY", models: [{ id: "gemini-chat" }] } }]
    });
    try {
      let catalog = open();
      expect(catalog.geminiImageChatCredential()).toBeUndefined();
      await expect(catalog.upsertConfiguration({ ...input("proxy", "https://provider.example.test/v1beta/openai"), geminiImageBackendId: "pi" }))
        .rejects.toThrow("Google AI Studio API key");
      await catalog.upsertConfiguration({ ...input("first-account", GEMINI_CHAT_ENDPOINT, "google-gemini-api"), geminiImageBackendId: "pi" });
      const selected = catalog.geminiImageChatCredential();
      expect(selected).toMatchObject({ backendId: "pi", providerId: "first-account", credential: { credentialReferenceId: reference } });
      await catalog.upsertConfiguration(input("second-account"));
      await catalog.upsertConfiguration({ ...input("first-account"), displayName: "Renamed account", expectedVersion: catalog.get("pi", "first-account").version });
      catalog = open();
      expect(catalog.geminiImageChatCredential()).toEqual(selected);
      expect(catalog.get("pi", "first-account").provider.catalogPresetId).toBe("google-gemini-api");
      expect(catalog.get("pi", "second-account").provider.catalogPresetId).toBeUndefined();

      await credentials.replaceSecret(reference, "replacement-google-studio-key");
      expect(catalog.geminiImageChatCredential()).toBeNull();
      await catalog.upsertConfiguration({ ...input("first-account"), geminiImageBackendId: "pi", expectedVersion: catalog.get("pi", "first-account").version });
      expect(catalog.geminiImageChatCredential()?.credential.generation).not.toBe(selected?.credential.generation);
      await catalog.delete("first-account");
      await catalog.upsertConfiguration(input("first-account"));
      catalog = open();
      expect(catalog.get("pi", "first-account").provider.catalogPresetId).toBeUndefined();
      expect(catalog.geminiImageChatCredential()).toBeNull();
      await catalog.useStandaloneGeminiImageCredential(() => {});
      expect(open().geminiImageChatCredential()).toBeUndefined();
    } finally { store.close(); }
  });

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

  it("reads the xAI subscription access token without requiring a ChatGPT account ID", async () => {
    const { credentials, store, now } = await fixture();
    try {
      const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi", now: () => now });
      providers.initialize();
      await providers.registerNativeAuthProviders([{ provider: { id: "xai", api: "openai-responses", models: [] },
        displayName: "xAI", kind: "subscription", accountUsageAvailable: true }]);
      await providers.persistNativeAuth({ providerId: "xai", expectedCatalogGeneration: providers.generation,
        credential: { type: "oauth", access: "fixture-xai-access", refresh: "fixture-xai-refresh", expires: now + 60_000 } });
      const identity = providers.describeProviderAccountUsage("xai");
      expect(identity).toBeDefined();
      await expect(providers.useProviderAccountUsageCredential(identity!, async credential => ({ ...credential })))
        .resolves.toEqual({ accessToken: "fixture-xai-access" });
    } finally { store.close(); }
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

  it.each(["openai-responses", "google-generative-ai", "anthropic-messages"] as const)("shows newly discovered direct Pi text models from %s by default", async api => {
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
    const google = api === "google-generative-ai";
    const origin = google ? "https://generativelanguage.googleapis.com" : "https://models.example.test";
    const baseUrl = `${origin}/${google ? "v1beta" : "v1"}`;
    await providers.upsert({
      backendId: "pi", credentialOrigin: origin,
      provider: {
        id: "discoverable",
        baseUrl,
        api,
        apiKeyEnv: "DISCOVERY_API_KEY",
        models: [{ id: "kept", name: "Kept", contextWindow: 32_000, maxTokens: 4_000, defaultVisible: false }]
      },
      displayName: "Discoverable",
      kind: "custom_endpoint",
      credentialBindings: { DISCOVERY_API_KEY: "cred_discovery_test" },
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false
    });
    let rejectNextPage = api === "anthropic-messages";
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      if (google) {
        expect(url).toBe(`${baseUrl}/models`);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("x-goog-api-key")).toBe("discovery-secret-value");
        return Response.json({ models: [
          { name: "models/kept", displayName: "Renamed upstream", supportedGenerationMethods: ["generateContent"] },
          { name: "models/new-model", displayName: "New model", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1_000_000 }
        ] });
      }
      expect(headers.get("authorization")).toBe("Bearer discovery-secret-value");
      if (api === "anthropic-messages") {
        expect(headers.get("x-api-key")).toBe("discovery-secret-value");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        if (url === `${baseUrl}/models`) return Response.json({ data: [{ id: "kept", name: "Renamed upstream" }], has_more: true, last_id: "kept" });
        expect(url).toBe(`${baseUrl}/models?after_id=kept`);
        if (rejectNextPage) return new Response(null, { status: 503 });
        return Response.json({ data: [{ id: "new-model", name: "New model", context_window: 1_000_000 }], has_more: false, last_id: "new-model" });
      }
      expect(url).toBe(`${baseUrl}/models`);
      return new Response(JSON.stringify({ data: [
        { id: "kept", name: "Renamed upstream" },
        { id: "new-model", name: "New model", context_window: 1_000_000 }
      ] }), { status: 200 });
    };

    if (rejectNextPage) {
      await expect(providers.discoverProviderModels("pi", "discoverable", request as typeof fetch, undefined, "discovery-test")).resolves.toEqual({
        providerId: "discoverable", addedModelIds: [], updatedModelIds: ["kept"], modelCount: 1
      });
      expect(providers.get("pi", "discoverable").provider.models.map(model => model.id)).toEqual(["kept"]);
      rejectNextPage = false;
    }

    await expect(providers.discoverProviderModels("pi", "discoverable", request as typeof fetch)).resolves.toEqual({
      providerId: "discoverable",
      addedModelIds: ["new-model"],
      updatedModelIds: api === "anthropic-messages" ? [] : ["kept"],
      modelCount: 2
    });
    expect(providers.get("pi", "discoverable")).toMatchObject({ supportsModelRefresh: true });
    expect(providers.get("pi", "discoverable").provider.models).toMatchObject([
      { id: "new-model", name: "New model", contextWindow: 1_000_000, maxTokens: 16_384, defaultVisible: true,
        contextWindowSource: "declared", maxOutputTokensSource: "estimated", metadataOverrides: [] },
      { id: "kept", name: "Kept", contextWindow: 32_000, maxTokens: 4_000, defaultVisible: false,
        metadataOverrides: ["name", "contextWindow", "maxTokens"], discoveredMetadata: { name: "Renamed upstream" } }
    ]);
    await expect(providers.discoverProviderModels("pi", "discoverable", request as typeof fetch)).resolves.toMatchObject({
      addedModelIds: [],
      modelCount: 2
    });
    expect(stringify(store.listSettings())).not.toContain("discovery-secret-value");
    store.close();
  });

  it("keeps the new official OpenRouter text quotes for the original Codex Provider across restart", async () => {
    const { root, store, credentials } = await fixture();
    const backendId = "custom-codex-instance", providerId = "custom-openrouter";
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    store.upsertBackend({ id: backendId, adapterKind: "codex", instanceGeneration: 1, displayName: "Codex discovery", version: "fixture",
      health: "healthy", installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    const ticket = credentials.createUploadTicket({ kind: "api_key" });
    credentials.upload(ticket.credentialUploadTicketId, "owned-openrouter-fixture-key");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "openrouter-fixture-key",
      displayName: "Fixture key", kind: "api_key" });
    const kept = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    await providers.upsert({ backendId, credentialOrigin: "https://openrouter.ai", kind: "api_key", displayName: "Owned OpenRouter", enabled: true,
      supportsLogin: false, supportsLogout: false, supportsRefresh: false, credentialBindings: { OPENROUTER_FIXTURE_KEY: "openrouter-fixture-key" },
      modelsEndpoint: "https://openrouter.ai/api/v1/models", provider: { id: providerId, baseUrl: "https://openrouter.ai/api/v1", api: "openai-responses",
        apiKeyEnv: "OPENROUTER_FIXTURE_KEY", models: [{ id: "kept", cost: kept }] } });
    const architecture = { input_modalities: ["text"], output_modalities: ["text"] };
    const pricing = { prompt: "0.00001", completion: "0.00002", input_cache_read: "0", input_cache_write: "0" };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const endpoint = new URL(String(input));
      expect(endpoint.origin).toBe("https://openrouter.ai");
      expect(endpoint.pathname).toBe("/api/v1/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owned-openrouter-fixture-key");
      return Response.json({ data: endpoint.search === "" ? [
        { id: "kept", architecture, pricing }, { id: "priced", architecture, pricing },
        { id: "free", architecture, pricing: { ...pricing, prompt: "0", completion: "0" } }
      ] : [] });
    });
    try {
      expect(await providers.discoverProviderModels(backendId, providerId, fetcher)).toMatchObject({ addedModelIds: ["priced", "free"], modelCount: 3 });
      const partialSpeech = async (request: string | URL | Request) => new URL(String(request)).search
        ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ id: "priced", architecture }, { id: "kept", architecture }] });
      const refresh = await providers.discoverProviderModels(backendId, providerId, partialSpeech, () => undefined, "openrouter-reviewer");
      expect(refresh.withdrawalReview).toBeUndefined();
      expect(providers.get(backendId, providerId).provider.models.map(model => model.id)).toEqual(["priced", "free", "kept"]);
      const completeSpeech = async (request: string | URL | Request) => new URL(String(request)).search
        ? Response.json({ data: [] }) : Response.json({ data: [{ id: "priced", architecture }, { id: "kept", architecture }] });
      const complete = await providers.discoverProviderModels(backendId, providerId, completeSpeech, () => undefined, "openrouter-reviewer");
      expect(complete.withdrawalReview).toMatchObject({ providerId, backendId, models: [{ modelId: "free" }] });
      store.close();
      const reopened = new OperationalStore(join(root, "orchestrator.db"));
      try {
        const catalog = new ProviderCatalogManager({ store: reopened, credentials, nativeBackendId: "pi" });
        catalog.initialize();
        expect(catalog.get(backendId, providerId).provider.models.map(({ id, cost }) => ({ id, cost }))).toEqual([
          { id: "priced", cost: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } },
          { id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: "kept", cost: kept }
        ]);
      } finally { reopened.close(); }
    } finally { store.close(); }
  });

  it("persists newly discovered capabilities through restart and the actual native generation without changing declared models", async () => {
    const { root, store, credentials } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); providers.initialize();
    await providers.upsert({ backendId: "pi", credentialOrigin: "http://127.0.0.1:11434", displayName: "Local", enabled: true,
      kind: "local_keyless", credentialBindings: {}, supportsLogin: false, supportsLogout: false, supportsRefresh: false,
      provider: { id: "local", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", keyless: true,
        models: [{ id: "kept", contextWindow: 32_000, maxTokens: 4_000, input: ["text"], supportsFastMode: false }] } });
    const refresh = () => providers.discoverProviderModels("pi", "local", (async () => new Response(JSON.stringify({ data: [
      { id: "kept", context_window: 128_000, capabilities: { vision: true } },
      { id: "new", max_context_window: 64_000, max_output_tokens: 8_000, native_api: "anthropic-messages",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        supported_parameters: ["tools", "reasoning"], reasoning: { supportedEfforts: ["high", "max"], defaultEffort: "max" }, supports_fast_mode: false }
    ] }))) as typeof fetch);
    try {
      await refresh();
      const kept = providers.get("pi", "local").provider.models.find(model => model.id === "kept");
      expect(kept).toMatchObject({ id: "kept", contextWindow: 32_000, maxTokens: 4_000, input: ["text"], supportsFastMode: false,
        discoveredMetadata: { contextWindow: 128_000, supportsImages: true }, metadataOverrides: ["contextWindow", "maxTokens", "input", "supportsFastMode"] });
      const restored = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); restored.initialize();
      expect(restored.get("pi", "local").provider.models.find(model => model.id === "new")).toMatchObject({ id: "new", contextWindow: 64_000, contextWindowMax: 64_000, contextWindowSource: "estimated",
        maxTokens: 8_000, maxOutputTokensSource: "declared", reasoning: true, defaultEffort: "max", input: ["text", "image"],
        supportsTools: true, referenceApi: "anthropic-messages", supportsFastMode: false, defaultVisible: false });
      const snapshot = await restored.createPiGenerationSnapshot({ snapshotsRoot: join(root, "snapshots") });
      const native = JSON.parse(await readFile(join(snapshot.agentHome, "models.json"), "utf8")).providers.local;
      expect(native.api).toBe("openai-completions");
      const nativeNew = native.models.find((model: { id: string }) => model.id === "new");
      expect(nativeNew).toMatchObject({ id: "new", contextWindow: 64_000, maxTokens: 8_000,
        input: ["text", "image"], thinkingLevelMap: { off: null, low: null, high: "high", max: "max" } });
      for (const key of ["referenceApi", "defaultEffort", "contextWindowSource", "maxOutputTokensSource", "supportsFastMode", "supportsTools", "defaultVisible", "discoveredMetadata", "metadataOverrides", "contextWindowMax", "declaredInputModalities"]) expect(nativeNew).not.toHaveProperty(key);
      await refresh(); expect(providers.get("pi", "local").provider.models.find(model => model.id === "kept")).toEqual(kept);
    } finally { store.close(); }
  });

  it("projects public metadata into discovery and Pi's models.json while retaining live declarations and owner overrides", async () => {
    const { root, store, credentials } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    const ticket = credentials.createUploadTicket({ kind: "api_key" });
    credentials.upload(ticket.credentialUploadTicketId, "official-model-test-key");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "openai-fixture-key",
      displayName: "Fixture key", kind: "api_key" });
    const credentialBindings = { JOKO_OPENAI_TEST_KEY: "openai-fixture-key" };
    const providerId = "my-openai-key", credentialOrigin = "https://api.openai.com";
    await providers.upsert({ backendId: "pi", credentialOrigin, kind: "api_key", displayName: "OpenAI API", enabled: true,
      supportsLogin: false, supportsLogout: false, supportsRefresh: false, credentialBindings,
      provider: { id: providerId, baseUrl: `${credentialOrigin}/v1`, api: "openai-responses", apiKeyEnv: "JOKO_OPENAI_TEST_KEY",
        models: [{ id: "owner-model", contextWindow: 32_000 }] } });
    try {
      await providers.discoverProviderModels("pi", providerId, async (request, init) => {
        expect(String(request)).toBe(`${credentialOrigin}/v1/models`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer official-model-test-key");
        return Response.json({ data: [
          { id: "gpt-6.2-sol" },
          { id: "gpt-6.1-sol", context_window: 240_000, input_modalities: ["text"], max_output_tokens: 9_000,
            reasoning: { supportedEfforts: ["low", "high"] }, supports_fast_mode: false },
          { id: "gpt-5.6-sol" },
          { id: "unlisted-model" }
        ] });
      });
      const discovered = providers.get("pi", providerId);
      const modelById = (id: string) => discovered.provider.models.find(model => model.id === id);
      expect(modelById("gpt-6.2-sol")).toMatchObject({ name: "GPT-6.2 Sol", contextWindow: 1_050_000,
        contextWindowSource: "estimated", maxTokens: 128_000, reasoning: true, defaultEffort: "medium", input: ["text", "image"] });
      expect(modelById("gpt-6.2-sol")?.discoveredMetadata).not.toHaveProperty("contextWindow");
      expect(modelById("gpt-6.1-sol")).toMatchObject({ contextWindow: 240_000, contextWindowSource: "declared",
        maxTokens: 9_000, defaultEffort: "low", input: ["text"], supportsFastMode: false });
      expect(modelById("gpt-5.6-sol")).toMatchObject({ name: "GPT-5.6-Sol", contextWindow: 1_050_000, maxTokens: 128_000 });
      expect(modelById("unlisted-model")).toMatchObject({ name: "unlisted-model", contextWindow: 128_000 });
      const models = discovered.provider.models.map(model => model.id === "gpt-6.2-sol"
        ? { ...model, contextWindow: 720_000, defaultEffort: undefined, metadataOverrides: ["contextWindow"] as const }
        : model.id === "gpt-5.6-sol" ? { ...model, maxTokens: 96_000, metadataOverrides: ["maxTokens"] as const } : model);
      await providers.upsertConfiguration({ providerId, displayName: "OpenAI API", kind: "api_key", enabled: true, expectedVersion: discovered.version,
        runtimes: [{ backendId: "pi", credentialOrigin, credentialBindings, provider: { ...discovered.provider, models } }] });
      const generation = await providers.createPiGenerationSnapshot({ snapshotsRoot: join(root, "snapshots") });
      const native = JSON.parse(await readFile(join(generation.agentHome, "models.json"), "utf8")).providers[providerId].models;
      const nativeModel = (id: string) => native.find((entry: { id: string }) => entry.id === id);
      expect(nativeModel("gpt-6.2-sol")).toMatchObject({ contextWindow: 720_000, maxTokens: 128_000, reasoning: true });
      expect(nativeModel("gpt-6.2-sol")).not.toHaveProperty("discoveredMetadata");
      expect(nativeModel("gpt-5.6-sol")).toMatchObject({ contextWindow: 1_050_000, maxTokens: 96_000 });
    } finally { store.close(); }
  });

  it("refreshes known discovery facts through owner edits, sparse denials, restart and the native catalog", async () => {
    const { root, store, credentials } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); providers.initialize();
    await providers.upsert({ backendId: "pi", credentialOrigin: "", displayName: "Local", enabled: true,
      kind: "local_keyless", credentialBindings: {}, supportsLogin: false, supportsLogout: false, supportsRefresh: false,
      provider: { id: "local", baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", keyless: true,
        models: [{ id: "manual", name: "Owner model", contextWindow: 32_000, maxTokens: 4_000, input: ["text"],
          reasoning: false, supportsFastMode: false, supportsTools: false }] } });
    const refresh = (data: unknown[]) => providers.discoverProviderModels("pi", "local", (async () => Response.json({ data })) as typeof fetch);
    const first = [
      { id: "same", name: "Upstream", context_window: 128_000, max_context_window: 256_000, max_output_tokens: 8_000,
        input_modalities: ["text", "image"], supports_image_input: true, architecture: { output_modalities: ["text"] },
        reasoning: { supportedEfforts: ["high"], defaultEffort: "high" }, supports_fast_mode: true },
      { id: "wide", context_window: 128_000, max_context_window: 1_000_000 },
      { id: "small", max_context_window: 16_000 },
      { id: "manual", name: "Upstream manual", context_window: 256_000, max_output_tokens: 32_000, input_modalities: ["text", "image"],
        reasoning: { supportedEfforts: ["high"] }, supports_fast_mode: true, capabilities: { trained_for_tool_use: true } }
    ];
    try {
      expect(await refresh(first)).toMatchObject({ addedModelIds: ["same", "wide", "small"], updatedModelIds: ["manual"] });
      const initial = providers.get("pi", "local");
      expect(initial.provider.models.map(model => model.id)).toEqual(["same", "wide", "small", "manual"]);
      expect(initial.provider.models[0]).toMatchObject({ contextWindow: 128_000, contextWindowMax: 256_000, contextWindowSource: "declared", input: ["text", "image"], defaultEffort: "high" });
      expect(initial.provider.models[1]).toMatchObject({ contextWindow: 128_000, contextWindowMax: 1_000_000 });
      expect(initial.provider.models[2]).toMatchObject({ contextWindow: 16_000, contextWindowMax: 16_000, contextWindowSource: "estimated" });
      expect(initial.provider.models[3]).toMatchObject({ name: "Owner model", contextWindow: 32_000, maxTokens: 4_000,
        input: ["text"], reasoning: false, supportsFastMode: false, supportsTools: false });
      await providers.upsertConfiguration({ providerId: "local", displayName: "Local renamed", kind: "local_keyless", enabled: true,
        expectedVersion: initial.version, runtimes: [{ backendId: "pi", credentialOrigin: "", credentialBindings: {},
          provider: { ...initial.provider, models: initial.provider.models.map(model => model.id !== "same" ? model : {
            id: model.id, name: "Owner label", contextWindow: 128_000, maxTokens: 8_000, input: ["text", "image"],
            reasoning: true, supportsFastMode: true, metadataOverrides: ["name"]
          }) } }] });
      const sparse = [{ id: "same", name: "New upstream label", context_window: 256_000, supports_image_input: false,
        reasoning: { supportedEfforts: [], defaultEffort: null }, architecture: { output_modalities: [] },
        supports_fast_mode: false, capabilities: { trained_for_tool_use: false } }];
      expect(await refresh(sparse)).toEqual({ providerId: "local", addedModelIds: [], updatedModelIds: ["same"], modelCount: 4 });
      const current = providers.get("pi", "local");
      expect(current.provider.models[0]).toMatchObject({ name: "Owner label", contextWindow: 256_000, contextWindowMax: 256_000,
        maxTokens: 8_000, input: ["text"], reasoning: false, declaredOutputModalities: [], supportsTools: false, supportsFastMode: false,
        metadataOverrides: ["name"], discoveredMetadata: { inputModalities: ["text"], efforts: [], defaultEffort: null, outputModalities: [] } });
      expect(current.provider.models[0]).not.toHaveProperty("defaultEffort");
      const before = current.version;
      expect(await refresh(sparse)).toMatchObject({ addedModelIds: [], updatedModelIds: [] });
      expect(providers.get("pi", "local").version).toBe(before);
      const restored = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); restored.initialize();
      expect(restored.get("pi", "local").provider.models).toEqual(current.provider.models);
      const generation = await restored.createPiGenerationSnapshot({ snapshotsRoot: join(root, "snapshots") });
      const native = JSON.parse(await readFile(join(generation.agentHome, "models.json"), "utf8")).providers.local.models;
      expect(native[0]).toMatchObject({ id: "same", name: "Owner label", contextWindow: 256_000, input: ["text"], reasoning: false });
      for (const model of native) for (const key of ["discoveredMetadata", "metadataOverrides", "contextWindowMax", "declaredInputModalities"]) expect(model).not.toHaveProperty(key);
      const catalog = await provisionManagedCatalog(join(root, "projected"), [restored.get("pi", "local").provider]);
      expect(catalog.models[0]).toMatchObject({ contextWindow: 256_000, contextWindowMax: 256_000, declaredInputModalities: ["text"],
        declaredOutputModalities: [], supportsImages: false, thinkingLevels: [], supportsFastMode: false });
      expect(catalog.models[1]).toMatchObject({ contextWindow: 128_000, contextWindowMax: 1_000_000 });
      expect(catalog.models[2]).toMatchObject({ contextWindow: 16_000, contextWindowMax: 16_000, contextWindowSource: "estimated" });
      expect(await refresh([{ id: "same", context_window: 512_000 }])).toMatchObject({ updatedModelIds: ["same"] });
      expect(providers.get("pi", "local").provider.models[0]).not.toHaveProperty("contextWindowMax");
      expect(providers.get("pi", "local").provider.models[0]!.discoveredMetadata).not.toHaveProperty("contextWindowMax");
      const latest = providers.get("pi", "local");
      await providers.upsertConfiguration({ providerId: "local", displayName: "Local renamed", kind: "local_keyless", enabled: true,
        expectedVersion: latest.version, runtimes: [{ backendId: "pi", credentialOrigin: "", credentialBindings: {}, provider: {
          ...latest.provider, models: latest.provider.models.map(model => model.id !== "small" ? model : {
            ...model, contextWindow: 8_000, metadataOverrides: ["contextWindow"]
          }) } }] });
      expect(providers.get("pi", "local").provider.models.find(model => model.id === "small"))
        .toMatchObject({ contextWindow: 8_000, contextWindowMax: 16_000, contextWindowSource: "declared" });
    } finally { store.close(); }
  });

  it("reviews only models observed on the original authenticated catalog and commits just the selected rows", async () => {
    const { store, credentials } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    try {
      const ticket = credentials.createUploadTicket();
      credentials.upload(ticket.credentialUploadTicketId, "first-catalog-key");
      await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId,
        credentialReferenceId: "review-key", displayName: "Key", kind: "api_key" });
      const entry = { backendId: "pi", credentialOrigin: "https://catalog.example.test", displayName: "Same name", enabled: true,
        kind: "custom_endpoint" as const, credentialBindings: { CATALOG_KEY: "review-key" }, supportsLogin: false, supportsLogout: false, supportsRefresh: false,
        provider: { id: "catalog", baseUrl: "https://catalog.example.test/v1", api: "openai-responses" as const, apiKeyEnv: "CATALOG_KEY",
          models: [{ id: "manual", name: "Custom route" }] } };
      await providers.upsert(entry);
      await providers.upsert({ ...entry, provider: { ...entry.provider, id: "other-catalog", models: [{ id: "a", name: "Another account model" }] } });
      const refresh = (ids: string[], extra = {}) => providers.discoverProviderModels("pi", "catalog",
        (async () => Response.json({ data: ids.map(id => ({ id })), ...extra })) as typeof fetch, () => undefined, "review-device");
      const current = () => providers.get("pi", "catalog").provider.models.map(model => model.id);
      const confirm = (reviewId: string, modelIds: string[], owner = "review-device") =>
        providers.confirmModelWithdrawals({ backendId: "pi", providerId: "catalog", reviewId, modelIds }, owner, () => undefined);

      await refresh(["a", "b", "manual"]);
      await providers.upsert({ ...entry, modelsEndpoint: "https://catalog.example.test/v1/models?before_id=anchor",
        provider: { ...entry.provider, id: "reverse-catalog", api: "anthropic-messages" } });
      const refreshWindow = (ids: string[]) => providers.discoverProviderModels("pi", "reverse-catalog",
        async () => Response.json({ data: ids.map(id => ({ id })), has_more: false, first_id: ids[0], last_id: ids.at(-1) }),
        () => undefined, "review-device");
      await refreshWindow(["a", "b"]);
      expect((await refreshWindow(["b"])).withdrawalReview).toBeUndefined();
      expect(providers.get("pi", "reverse-catalog").provider.models.map(model => model.id)).toContain("a");
      expect((await refresh(["b"], { next_cursor: "page-two" })).withdrawalReview).toBeUndefined();
      expect((await refresh(["b", "manual"], { pagination: { totalPages: 2 } })).withdrawalReview).toBeUndefined();
      expect(current()).toEqual(["a", "b", "manual"]);
      const paged = await providers.discoverProviderModels("pi", "catalog", async url => {
        const after = new URL(String(url)).searchParams.get("cursor");
        return after === "page-two" ? Response.json({ data: [{ id: "a" }, { id: "manual" }] })
          : Response.json({ data: [{ id: "b" }], next_cursor: "page-two" });
      }, () => undefined, "review-device");
      expect(paged.withdrawalReview).toBeUndefined();
      const first = (await refresh(["b"])).withdrawalReview!;
      expect(first).toMatchObject({ providerId: "catalog", backendId: "pi", suspicious: true, models: [{ modelId: "a" }] });
      expect(current()).toEqual(["a", "b", "manual"]);
      await expect(confirm(first.reviewId, ["a"], "another-device")).rejects.toThrow(/changed/);
      await expect(confirm(first.reviewId, ["manual"])).rejects.toThrow(/current withdrawal review/);
      await refresh(["a", "b"]);
      await expect(confirm(first.reviewId, ["a"])).rejects.toThrow(/changed/);

      const empty = (await refresh([])).withdrawalReview!;
      expect(empty).toMatchObject({ suspicious: true, models: [{ modelId: "a" }, { modelId: "b" }] });
      await credentials.replaceSecret("review-key", "replacement-catalog-key");
      await expect(confirm(empty.reviewId, ["a"])).rejects.toThrow(/changed/);
      expect((await refresh(["b"])).withdrawalReview).toBeUndefined();
      await refresh(["a", "b"]);
      const next = (await refresh([])).withdrawalReview!;
      await confirm(next.reviewId, ["a"]);
      expect(current()).toEqual(["b", "manual"]);
      expect(providers.get("pi", "other-catalog").provider.models.map(model => model.id)).toEqual(["a"]);
      await expect(confirm(next.reviewId, ["b"])).rejects.toThrow(/changed/);
      const reopened = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
      reopened.initialize();
      expect(reopened.get("pi", "catalog").provider.models.map(model => model.id)).toEqual(["b", "manual"]);
    } finally { store.close(); }
  });

  it.each(["configuration", "credential", "connection"] as const)("rejects a late model refresh after the original %s changes", async change => {
    const { store, credentials } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); providers.initialize();
    const saveKey = async (secret: string) => {
      const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, secret);
      await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "catalog-key", displayName: "Key", kind: "api_key" });
    };
    await saveKey("initial-key-value");
    await providers.upsert({ backendId: "pi", credentialOrigin: "https://catalog.example.test", displayName: "Catalog", enabled: true,
      kind: "custom_endpoint", credentialBindings: { CATALOG_KEY: "catalog-key" }, supportsLogin: false, supportsLogout: false, supportsRefresh: false,
      provider: { id: "catalog", baseUrl: "https://catalog.example.test/v1", api: "openai-responses", apiKeyEnv: "CATALOG_KEY", models: [{ id: "manual" }] } });
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    let authorityCurrent = true;
    const assertCurrent = () => { if (!authorityCurrent) throw new Error("Provider refresh connection changed."); };
    const pending = providers.discoverProviderModels("pi", "catalog", (async () => { entered(); await held; return Response.json({ data: [{ id: "late-model" }] }); }) as typeof fetch, assertCurrent);
    try {
      await started;
      const original = providers.get("pi", "catalog");
      if (change === "credential") await saveKey("replacement-key-value");
      else if (change === "connection") authorityCurrent = false;
      else await providers.upsertConfiguration({ providerId: "catalog", displayName: "Changed", kind: "custom_endpoint", enabled: true,
        expectedVersion: original.version, runtimes: [{ backendId: "pi", credentialOrigin: "https://catalog.example.test",
          credentialBindings: { CATALOG_KEY: "catalog-key" }, provider: original.provider }] });
      finish();
      await expect(pending).rejects.toThrow(change === "connection" ? "Provider refresh connection changed." : /changed during model catalog refresh/u);
      expect(providers.get("pi", "catalog").provider.models.map(model => model.id)).toEqual(["manual"]);
      const restored = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" }); restored.initialize();
      expect(restored.get("pi", "catalog").provider.models.map(model => model.id)).toEqual(["manual"]);
    } finally { finish(); await pending.catch(() => undefined); store.close(); }
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

  it("materializes the exact custom OpenCode Go model APIs in the local Pi generation", async () => {
    const { root, credentials, store } = await fixture();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
    providers.initialize();
    const ticket = credentials.createUploadTicket();
    credentials.upload(ticket.credentialUploadTicketId, "go-route-test-secret");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId,
      credentialReferenceId: "cred_go_route_test", displayName: "Go fixture key", kind: "api_key" });
    const go = "https://opencode.ai/zen/go/v1", luna = "gpt-5.6-luna", deepseek = "deepseek-v4-flash";
    const models: readonly PiManagedModel[] = [{ id: deepseek }, { id: luna }];
    const variants: { readonly id: string; readonly baseUrl: string; readonly models: readonly PiManagedModel[]; readonly requestPath?: string }[] = [
      { id: "custom-go", baseUrl: go, models },
      { id: "explicit-model", baseUrl: go, models: [{ id: deepseek }, { id: luna, api: "openai-completions" as const }] },
      { id: "explicit-path", baseUrl: go, models, requestPath: "/zen/go/v1/chat/completions" },
      { id: "other-path", baseUrl: "https://opencode.ai/zen/v1", models },
      { id: "explicit-model-endpoint", baseUrl: go, models: [{ id: luna, baseUrl: "https://opencode.ai/zen/v1" }] },
      { id: "single-model", baseUrl: go, models: [{ id: luna }] }
    ];
    try {
      for (const [position, variant] of variants.entries()) {
        const { requestPath, ...configured } = variant;
        const apiKeyEnv = `GO_ROUTE_TEST_${position}`;
        await providers.upsert({ backendId: "pi", credentialOrigin: "https://opencode.ai", kind: "custom_endpoint",
          displayName: configured.id, enabled: true, supportsLogin: false, supportsLogout: true, supportsRefresh: false,
          provider: { ...configured, api: "openai-completions", apiKeyEnv },
          credentialBindings: { [apiKeyEnv]: "cred_go_route_test" }, ...(requestPath === undefined ? {} : { requestPath }) });
      }
      const snapshotsRoot = join(root, "go-snapshots");
      const previous = await providers.createPiGenerationSnapshot({ snapshotsRoot, hosted: true });
      const previousFile = join(previous.agentHome, "models.json");
      const originalModels = await readFile(previousFile, "utf8");
      expect(previous.providers.find(item => item.id === "custom-go")?.models.find(model => model.id === luna)?.api).toBeUndefined();

      const restored = new ProviderCatalogManager({ store, credentials, nativeBackendId: "pi" });
      restored.initialize();
      const current = await restored.createPiGenerationSnapshot({ snapshotsRoot });
      expect(current.catalogGeneration).toBe(previous.catalogGeneration);
      expect(current.agentHome).not.toBe(previous.agentHome);
      expect(await readFile(previousFile, "utf8")).toBe(originalModels);
      expect(restored.get("pi", "custom-go").provider.models.find(model => model.id === luna)?.api).toBeUndefined();
      expect(await readFile(join(current.agentHome, "models.json"), "utf8")).not.toContain("go-route-test-secret");
      const runtime = await ModelRuntime.create({ modelsPath: join(current.agentHome, "models.json"), modelsStorePath: join(root, "pi-model-library"),
        allowModelNetwork: false, refreshOnCreate: false,
        credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} } });
      const requests: { readonly url: string; readonly method: string; readonly model: unknown }[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const body = await request.json() as { readonly model?: unknown };
        requests.push({ url: request.url, method: request.method, model: body.model });
        return Response.json({ error: { message: "Fixture captured the model request" } }, { status: 400 });
      };
      for (const [modelId, api] of [[luna, "openai-responses"], [deepseek, "openai-completions"]] as const) {
        const model = runtime.getModel("custom-go", modelId);
        expect(model).toMatchObject({ api, baseUrl: go, provider: "custom-go" });
        await runtime.complete(model!, { messages: [{ role: "user", content: "Read the test input", timestamp: 1 }] },
          { env: current.environment, fetch });
      }
      const modelEndpoint = runtime.getModel("explicit-model-endpoint", luna);
      expect(modelEndpoint).toMatchObject({ baseUrl: "https://opencode.ai/zen/v1", api: "openai-completions" });
      await runtime.complete(modelEndpoint!, { messages: [{ role: "user", content: "Read the test input", timestamp: 1 }] },
        { env: current.environment, fetch });
      expect(requests).toEqual([
        { url: `${go}/responses`, method: "POST", model: luna },
        { url: `${go}/chat/completions`, method: "POST", model: deepseek },
        { url: "https://opencode.ai/zen/v1/chat/completions", method: "POST", model: luna }
      ]);
      for (const variant of variants.slice(1)) {
        expect(runtime.getModel(variant.id, luna)).toMatchObject({ api: "openai-completions", baseUrl: variant.models.find(model => model.id === luna)?.baseUrl ?? variant.baseUrl });
      }
    } finally { store.close(); }
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
