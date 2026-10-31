import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { CredentialKind, CredentialService, ModelInputModality, OperationMutationSchema, OperationState, ProviderApiCompatibility, ProviderConfigurationSchema, ProviderKind } from "@joko/contracts";
import { CredentialManager, CredentialVault, ProviderCatalogManager, ProviderAccountBalanceProvider } from "@joko/orchestrator";
import type { BackendDescriptor } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture } from "./fixture.js";
import { submit } from "./operations.js";

it("reads official account balances through the authenticated Backend API and fences replaced keys", async () => {
  const backendId = PI_LIKE_PROFILE.id; const keys: string[] = [];
  const fixture = await OrchestratorE2eFixture.start({ profiles: [PI_LIKE_PROFILE], createAdapter: profile => new ProviderConfigurationAdapter(profile),
    createAuxiliaryServices: async (store, directory) => {
      const vault = await CredentialVault.open(join(directory, "balance-vault.key")), credentials = new CredentialManager({ vault, storagePath: join(directory, "balance-credentials.json") });
      await credentials.initialize(); const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: backendId }); providers.initialize();
      const ticket = credentials.createUploadTicket({ kind: "api_key" }); credentials.upload(ticket.credentialUploadTicketId, "original-balance-key");
      await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "balance-key", displayName: "Balance key", kind: "api_key" });
      await providers.upsert({ backendId, credentialOrigin: "https://api.deepseek.com", provider: { id: "deepseek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", apiKeyEnv: "BALANCE_KEY", models: [] },
        displayName: "Official account", kind: "api_key", credentialBindings: { BALANCE_KEY: "balance-key" }, enabled: true, supportsLogin: false, supportsLogout: true, supportsRefresh: false });
      const providerAccountBalance = new ProviderAccountBalanceProvider(providers, (async (url, init) => {
        expect(url).toBe("https://api.deepseek.com/user/balance"); expect(init?.redirect).toBe("error"); keys.push(new Headers(init?.headers).get("authorization")!);
        return Response.json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "7.123456789", granted_balance: "1", topped_up_balance: "6.123456789" }] });
      }) as typeof fetch);
      return { credentials, providers, providerAccountBalance };
    } });
  try {
    const connection = await fixture.pair("Account owner"), api = connection.clients.backend;
    const initial = await api.getProvider({ backendId, providerId: "deepseek" });
    expect(initial.provider?.capabilities?.capabilities.some(value => value.name === "provider.account_balance")).toBe(true);
    const result = (await api.getProviderAccountBalance({ backendId, providerId: "deepseek" })).result!;
    expect(result.status).toBe("ready"); expect(result.snapshot.case).toBe("deepseek");
    if (result.snapshot.case === "deepseek") expect(result.snapshot.value.balances[0]?.totalBalance).toBe("7.123456789");
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toContain("balance-key");
    await fixture.application.credentials!.replaceSecret("balance-key", "replacement-balance-key");
    expect((await api.getProvider({ backendId, providerId: "deepseek" })).provider?.accountBalanceRevision).not.toBe(initial.provider?.accountBalanceRevision);
    expect((await api.getProviderAccountBalance({ backendId, providerId: "deepseek" })).result?.status).toBe("ready");
    expect(keys).toEqual(["Bearer original-balance-key", "Bearer replacement-balance-key"]);
    await expect(fixture.anonymous.backend.getProviderAccountBalance({ backendId, providerId: "deepseek" })).rejects.toMatchObject({ code: Code.Unauthenticated });
  } finally { await fixture.close(); }
});

class ProviderConfigurationAdapter extends InstrumentedFakeAdapter {
  override async describe(): Promise<BackendDescriptor> {
    const descriptor = await super.describe();
    return { ...descriptor,
      capabilities: new Map([...descriptor.capabilities, ["provider.managed_catalog", { key: "provider.managed_catalog", supported: true }]]),
      providerRuntimeSupport: { protocols: ["openai-completions"],
        fields: ["auth_header", "keyless", "headers", "model_limits", "model_input_modalities"] }
    };
  }
}

it("saves a new provider with an independent uploaded credential and leaves its active binding unchanged until replacement is saved", async () => {
  const backendId = PI_LIKE_PROFILE.id;
  const secondaryBackendId = "secondary-runtime";
  const fixture = await OrchestratorE2eFixture.start({
    profiles: [PI_LIKE_PROFILE, { ...PI_LIKE_PROFILE, id: secondaryBackendId }],
    createAdapter: profile => new ProviderConfigurationAdapter(profile),
    createAuxiliaryServices: async (store, directory) => {
    const vault = await CredentialVault.open(join(directory, "provider-vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(directory, "provider-credentials.json") });
    await credentials.initialize();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: backendId }); providers.initialize();
    return { credentials, providers };
  } });
  try {
    const connection = await fixture.pair("Provider editor");
    const credentialApi = createClient(CredentialService, createConnectTransport({ baseUrl: fixture.baseUrl, httpVersion: "1.1",
      interceptors: [next => request => { request.header.set("authorization", `Bearer ${connection.authKey}`); return next(request); }] }));
    const upload = async (id: string, secret: string): Promise<void> => {
      const ticket = (await credentialApi.beginCredentialUpload({ kind: CredentialKind.API_KEY, providerId: "" })).ticket!;
      expect((await fetch(new URL(ticket.relativeEndpoint, fixture.baseUrl), { method: "PUT", headers: {
        authorization: `Bearer ${connection.authKey}`, "content-type": "application/octet-stream"
      }, body: Buffer.from(secret) })).ok).toBe(true);
      const operation = await submit(connection.clients.operation, connection.connectionId, create(OperationMutationSchema, { payload: { case: "commitCredential", value: {
        credentialUploadTicketId: ticket.ticketId, credentialReferenceId: id, displayName: "Provider key", kind: CredentialKind.API_KEY, providerId: ""
      } } }));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      expect(JSON.stringify(operation, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(secret);
    };
    await upload("credential-first", "first-provider-fixture-secret");
    expect(fixture.application.providers!.list()).toEqual([]);
    const provider = create(ProviderConfigurationSchema, {
      providerId: "private-provider", displayName: "Private provider", kind: ProviderKind.CUSTOM_ENDPOINT,
      enabled: true, version: { revision: { value: 0n } }, runtimes: [{
        backendId, apiCompatibility: ProviderApiCompatibility.OPENAI_COMPLETIONS, endpoint: "https://provider.example.test/v1",
        credentialReferenceId: "credential-first", apiKeyEnvironment: "JOKO_PROVIDER_TEST_KEY", credentialOrigin: "https://provider.example.test", authHeader: true,
        models: [{ modelId: "model", displayName: "Model", inputModalities: [ModelInputModality.TEXT], contextWindowTokens: 32_000n, maximumOutputTokens: 4_000n }]
      }, {
        backendId: secondaryBackendId, apiCompatibility: ProviderApiCompatibility.OPENAI_COMPLETIONS,
        endpoint: "http://127.0.0.1:9182/v1", keyless: true,
        models: [{ modelId: "model", displayName: "Other runtime model", inputModalities: [ModelInputModality.TEXT], contextWindowTokens: 16_000n, maximumOutputTokens: 2_000n }]
      }]
    });
    const save = async (candidate = provider) => submit(connection.clients.operation, connection.connectionId, create(OperationMutationSchema, { payload: { case: "upsertProvider", value: { provider: candidate } } }));
    expect((await save()).state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.providers!.resolveInferenceRoute(backendId, "private-provider", "model")?.authorization).toBe("Bearer first-provider-fixture-secret");
    const secondaryRoute = fixture.application.providers!.resolveInferenceRoute(secondaryBackendId, "private-provider", "model");
    expect(secondaryRoute?.authorization).toBeUndefined();
    expect(secondaryRoute?.baseUrl).toBe("http://127.0.0.1:9182/v1");
    expect(fixture.application.providers!.resolveInferenceRoute("absent-runtime", "private-provider", "model")).toBeUndefined();
    await upload("credential-second", "second-provider-fixture-secret");
    expect(fixture.application.providers!.resolveInferenceRoute(backendId, "private-provider", "model")?.authorization).toBe("Bearer first-provider-fixture-secret");
    provider.runtimes[0]!.credentialReferenceId = "credential-second";
    expect((await save()).state).toBe(OperationState.FAILED);
    expect(fixture.application.providers!.resolveInferenceRoute(backendId, "private-provider", "model")?.authorization).toBe("Bearer first-provider-fixture-secret");
    provider.version = (await connection.clients.settings.getSettings({})).settings!.providers[0]!.version;
    expect((await save()).state).toBe(OperationState.SUCCEEDED);
    expect(fixture.application.providers!.resolveInferenceRoute(backendId, "private-provider", "model")?.authorization).toBe("Bearer second-provider-fixture-secret");
    const savedSecondaryRoute = fixture.application.providers!.resolveInferenceRoute(secondaryBackendId, "private-provider", "model");
    expect(savedSecondaryRoute?.baseUrl).toBe(secondaryRoute?.baseUrl);
    expect(savedSecondaryRoute?.authorization).toBeUndefined();
    const settings = (await connection.clients.settings.getSettings({})).settings!;
    expect(settings.providers[0]?.runtimes.find(runtime => runtime.backendId === backendId)?.credentialReferenceId).toBe("credential-second");
    const unsupported = clone(ProviderConfigurationSchema, settings.providers[0]!);
    unsupported.runtimes[0]!.apiCompatibility = ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS;
    await expect(save(unsupported)).rejects.toMatchObject({ code: Code.InvalidArgument });
    for (const environmentName of ["JOKO_PROVIDER_TEST_KEY", "joko_provider_test_key"]) {
      const collision = clone(ProviderConfigurationSchema, settings.providers[0]!);
      collision.runtimes.find(runtime => runtime.backendId === backendId)!.headers = [{ $typeName: "joko.v1.ProviderHeaderConfiguration",
        headerName: "X-Route-Key", environmentName, credentialReferenceId: "credential-first" }];
      await expect(save(collision)).rejects.toMatchObject({ code: Code.InvalidArgument });
      expect(fixture.application.providers!.resolveInferenceRoute(backendId, "private-provider", "model")?.authorization).toBe("Bearer second-provider-fixture-secret");
    }
    const serialized = JSON.stringify(fixture.application.store.listSettings(), (_key, value) => typeof value === "bigint" ? value.toString() : value);
    expect(serialized).not.toContain("first-provider-fixture-secret");
    expect(serialized).not.toContain("second-provider-fixture-secret");
  } finally { await fixture.close(); }
});
