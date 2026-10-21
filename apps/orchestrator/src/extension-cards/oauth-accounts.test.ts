import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { toJsonString } from "@bufbuild/protobuf";
import { ExtensionOAuthService, ExtensionOAuthStateSchema, ExtensionAuthorizationPhase as Phase, ExtensionAuthorizationFailure as Failure } from "@joko/contracts";
import { CredentialManager } from "../credential-manager.js";
import { CredentialVault } from "../credential-vault.js";
import { ExtensionCatalogManager } from "../extension-catalog.js";
import type { PiResourceDescriptor } from "../resource-manager.js";
import { parseExtensionRuntime } from "../extension-surface-manifest.js";
import { ExtensionOAuthAccounts } from "./oauth-accounts.js";
import { ExtensionOAuthAccountState, extensionOAuthScope } from "./oauth-account-state.js";
import type { ExtensionOAuthDeclaration } from "./oauth-manifest.js";
import { ExtensionOAuthSettings } from "./oauth-settings.js";
import { createExtensionOAuthConnectService } from "./oauth-connect-service.js";
import type { ConnectionManager } from "../connection-manager.js";
import { ExtensionNetwork } from "./network.js";
import { parseExtensionNetwork } from "./network-manifest.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-oauth-core-")), databasePath = join(root, "store.db"), credentialPath = join(root, "credentials.json");
  const vault = await CredentialVault.open(join(root, "vault.key"));
  let store = new OperationalStore(databasePath), credentials = new CredentialManager({ vault, storagePath: credentialPath }); await credentials.initialize();
  let catalog = new ExtensionCatalogManager({ store, credentials }); catalog.initialize();
  let runtime = parseExtensionRuntime({ html: "ui/runtime.html", tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, readOnly: true }], network: {
    hosts: ["auth.example.test", "api.example.test"], secrets: [{ key: "account", label: "Account", source: "oauth", inject: { header: "Authorization", format: "Bearer {value}" },
      oauth: { authorizeUrl: "https://auth.example.test/authorize", tokenUrl: "https://auth.example.test/token", clientId: "builtin-client", clientSecret: "builtin-installed-public-value", scopes: ["mail.read", "mail.send"],
        identity: { url: "https://api.example.test/me", labelPath: "email", displayTemplate: "{team} · {name}" } } }] } });
  let resource = { id: "resource", backendId: "runtime", kind: "package", scope: "managed", state: "installed", enabled: true, sourceKind: "local", sourceDisplay: "Account fixture", discoveredRevision: "sha256:fixture-1", versionNumber: 1n,
    resourceDetails: [{ kind: "extension", name: "Account fixture", entryPath: "extensions/main.js", runtime, compatibility: "supported", compatibilityIssues: [], detectedApis: [] }] } as unknown as PiResourceDescriptor;
  const entry = catalog.reconcile([resource], []).entries[0]!, codes = new Map<string, string>(), refreshIdentities = new Map<string, string>(), accessIdentities = new Map<string, string>();
  const requests: Array<{ url: string; form: URLSearchParams; headers: Headers }> = [];
  let provider: ((form: URLSearchParams) => Promise<Response>) | undefined, identityAvailable = true;
  const bundle = (identity: string, refresh = true) => {
    const access = `access-private-fixture-${randomUUID()}`, token = `refresh-private-fixture-${randomUUID()}`; accessIdentities.set(access, identity); refreshIdentities.set(token, identity);
    return { access_token: access, ...(refresh ? { refresh_token: token } : {}), expires_in: 3600 };
  };
  const fetchImpl = (async (input, init) => {
    const url = String(input), form = new URLSearchParams(typeof init?.body === "string" ? init.body : ""), headers = new Headers(init?.headers); requests.push({ url, form, headers });
    if (url.endsWith("/me")) { if (!identityAvailable) return new Response(null, { status: 503 }); const identity = accessIdentities.get(headers.get("authorization")?.replace("Bearer ", "") ?? ""); return new Response(JSON.stringify({ email: identity, team: "Team", name: identity })); }
    if (provider) return provider(form);
    const identity = form.get("grant_type") === "authorization_code" ? codes.get(form.get("code") ?? "") : refreshIdentities.get(form.get("refresh_token") ?? "");
    return new Response(JSON.stringify(bundle(identity ?? "unknown@example.test")));
  }) as typeof fetch;
  const sleep = vi.fn(async (_ms: number) => {});
  let manager = new ExtensionOAuthAccounts({ store, vault, credentials, catalog, fetch: fetchImpl, sleep }); await manager.initialize();
  cleanup.push(async () => { await manager.dispose(); store.close(); if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("joko-oauth-core-")) throw new Error("Unsafe fixture cleanup"); await rm(root, { recursive: true, force: true }); });
  const capture = () => manager.capture(entry.id, "account", catalog.get(entry.id).revision);
  const authorize = (identity: string) => async (offer: { state: string }) => { const code = `code-private-fixture-${randomUUID()}`; codes.set(code, identity); return { state: offer.state, code }; };
  const connect = (identity: string, scopes?: readonly string[]) => manager.connect(capture(), { signal: new AbortController().signal, assertCurrent: () => {}, authorize: authorize(identity), ...(scopes ? { scopes } : {}) });
  const update = (patch: Partial<ExtensionOAuthDeclaration>) => {
    const network = runtime.network!, secret = network.secrets![0]!;
    runtime = parseExtensionRuntime({ ...runtime, network: { ...network, secrets: [{ ...secret, oauth: { ...secret.oauth, ...patch } }] } });
    resource = { ...resource, versionNumber: resource.versionNumber + 1n, discoveredRevision: `sha256:fixture-${resource.versionNumber + 1n}`, resourceDetails: [{ ...resource.resourceDetails[0]!, runtime }] };
    catalog.reconcile([resource], []);
  };
  return { root, vault, entry, codes, requests, sleep, bundle, accessIdentities, refreshIdentities, capture, authorize, connect, update,
    provider: (next: typeof provider) => { provider = next; }, identityAvailable: (value: boolean) => { identityAvailable = value; },
    get manager() { return manager; }, get credentials() { return credentials; }, get catalog() { return catalog; }, get store() { return store; },
    declaration: () => runtime.network!.secrets![0]!.oauth!, saved: () => new ExtensionOAuthAccountState({ store, vault }).get(extensionOAuthScope(entry.id, "account")),
    restart: async () => { await manager.dispose(); store.close(); store = new OperationalStore(databasePath); credentials = new CredentialManager({ vault, storagePath: credentialPath }); await credentials.initialize();
      catalog = new ExtensionCatalogManager({ store, credentials }); catalog.initialize(); catalog.reconcile([resource], []);
      manager = new ExtensionOAuthAccounts({ store, vault, credentials, catalog, fetch: fetchImpl, sleep }); await manager.initialize(); }
  };
}

it("keeps account identities and defaults through reconnect, protected client changes and restart", async () => {
  const f = await fixture(), id = f.entry.id;
  let state = await f.connect("one@example.test"), first = state.slots[0]!.accounts[0]!;
  const oldReference = f.saved().accounts[0]!.refreshReference!;
  state = await f.connect("two@example.test"); const second = state.slots[0]!.accounts[1]!;
  state = await f.connect("one@example.test"); expect(state.slots[0]!.accounts[0]!.id).toBe(first.id); expect(f.credentials.find(oldReference)).toBeUndefined();
  state = await f.manager.change(f.capture(), second.id, "default", () => {}); expect(state.slots[0]!.accounts[1]!.isDefault).toBe(true);
  const custom = f.capture(); await f.manager.setClient(custom, { clientId: "custom-public-client", clientSecret: "custom-private-client-value" }, () => {});
  expect(f.credentials.redactText("custom-private-client-value")).toBe("[REDACTED]"); expect(f.credentials.list()).toEqual([]);
  await f.manager.setClient(f.capture(), { clientId: "custom-pkce-client" }, () => {}); f.requests.length = 0;
  await f.connect("one@example.test"); expect(f.requests[0]!.form.get("client_id")).toBe("custom-pkce-client"); expect(f.requests[0]!.form.has("client_secret")).toBe(false);
  state = await f.manager.change(f.capture(), second.id, "remove", () => {}); expect(state.slots[0]!.accounts).toMatchObject([{ id: first.id, isDefault: true }]);
  expect(JSON.stringify(f.store.listSettings().map(row => row.value))).not.toContain("private");
  await f.restart(); expect(f.manager.get(id)).toEqual(state); expect(f.credentials.list()).toEqual([]);
  const fresh = await f.manager.fresh(id, "account", f.declaration()); expect(fresh).toMatchObject({ ok: true, accountId: first.id });
});

it("coalesces refreshes, persists rotated tokens and rechecks a concurrent rotation before expiring an account", async () => {
  const f = await fixture(); const state = await f.connect("one@example.test"), account = state.slots[0]!.accounts[0]!;
  f.manager.invalidate(f.entry.id, "account", account.id);
  let release!: (response: Response) => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), waiting = new Promise<Response>(resolve => { release = resolve; });
  cleanup.push(async () => release(new Response('{"error":"cancelled"}', { status: 400 })));
  let calls = 0; f.provider(async () => { calls++; started(); return waiting; });
  const one = f.manager.fresh(f.entry.id, "account", f.declaration()), two = f.manager.fresh(f.entry.id, "account", f.declaration()); expect(one).toBe(two); await ready;
  const rotated = f.bundle("one@example.test"); release(new Response(JSON.stringify(rotated)));
  expect(await one).toMatchObject({ ok: true, accessToken: rotated.access_token }); expect(await two).toMatchObject({ ok: true, accessToken: rotated.access_token }); expect(calls).toBe(1);
  const reference = f.saved().accounts[0]!.refreshReference!; expect(f.credentials.resolve(reference)).toBe(rotated.refresh_token);
  f.manager.invalidate(f.entry.id, "account", account.id); let attempt = 0;
  const peer = f.bundle("one@example.test");
  f.sleep.mockImplementationOnce(async milliseconds => { expect(milliseconds).toBe(2000); await f.credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: rotated.refresh_token!, secret: peer.refresh_token!, kind: "oauth", displayName: "Account" }); });
  f.provider(async form => { attempt++; return attempt === 1 ? new Response('{"error":"invalid_grant"}', { status: 400 }) : (expect(form.get("refresh_token")).toBe(peer.refresh_token), new Response(JSON.stringify({ access_token: peer.access_token }))); });
  expect(await f.manager.fresh(f.entry.id, "account", f.declaration())).toMatchObject({ ok: true, accessToken: peer.access_token });
  expect(f.credentials.resolve(reference)).toBe(peer.refresh_token); expect(f.manager.get(f.entry.id).slots[0]!.accounts[0]!.status).toBe("connected");
});

it("marks a confirmed invalid grant expired without exposing provider text or deleting another account", async () => {
  const f = await fixture(); await f.connect("one@example.test"); const state = await f.connect("two@example.test");
  const first = state.slots[0]!.accounts[0]!, secondReference = f.saved().accounts[1]!.refreshReference!, preserved = f.credentials.resolve(secondReference);
  f.manager.invalidate(f.entry.id, "account", first.id); f.provider(async () => new Response('{"error":"invalid_grant","error_description":"provider-private-text"}', { status: 400 }));
  expect(await f.manager.fresh(f.entry.id, "account", f.declaration(), first.id)).toEqual({ ok: false, error: "AUTH_EXPIRED" });
  expect(f.manager.get(f.entry.id).slots[0]!.accounts[0]!.status).toBe("expired"); expect(f.credentials.resolve(secondReference)).toBe(preserved);
});

it("tracks new full scopes and real evidence while preserving intentionally reduced authorization", async () => {
  const f = await fixture(); const first = (await f.connect("one@example.test")).slots[0]!.accounts[0]!;
  const second = (await f.connect("two@example.test", ["mail.read"])).slots[0]!.accounts[1]!;
  f.update({ scopes: ["mail.read", "mail.send", "mail.manage"] });
  let state = f.manager.get(f.entry.id); expect(state.slots[0]!.accounts).toMatchObject([{ id: first.id, scopeStale: true, missingScopes: ["mail.manage"] }, { id: second.id, scopeStale: false }]);
  await f.manager.change(f.capture(), second.id, "default", () => {});
  expect(await f.manager.reportInsufficientScopes(f.capture(), ["mail.send"])).toBe(true); state = f.manager.get(f.entry.id);
  expect(state.slots[0]!.accounts[1]).toMatchObject({ scopeStale: true, missingScopes: ["mail.send"] });
  await expect(f.manager.reportInsufficientScopes(f.capture(), ["undeclared"])).rejects.toThrow("INVALID_CONFIG");
});

it("retires a changed builtin client without sending its old refresh token to the new client", async () => {
  const f = await fixture(); await f.connect("one@example.test"); const reference = f.saved().accounts[0]!.refreshReference!, old = f.credentials.resolve(reference);
  f.update({ clientId: "different-builtin-client" }); f.requests.length = 0;
  expect(await f.manager.fresh(f.entry.id, "account", f.declaration())).toEqual({ ok: false, error: "AUTH_EXPIRED" });
  expect(f.manager.get(f.entry.id).slots[0]!.accounts[0]).toMatchObject({ status: "expired", clientChanged: true }); expect(f.requests).toHaveLength(0); expect(f.credentials.resolve(reference)).toBe(old);
});

it("rejects forged captures and late grants after the original caller is revoked", async () => {
  const f = await fixture(), capture = f.capture();
  await expect(f.manager.setClient({ ...capture }, { clientId: "other" }, () => {})).rejects.toThrow("INVALID_CONFIG");
  let current = true, arrived!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; }); cleanup.push(async () => release());
  const provider = f.authorize("one@example.test");
  const pending = f.manager.connect(capture, { signal: new AbortController().signal, assertCurrent: () => { if (!current) throw new Error("Revoked"); }, authorize: async offer => { arrived(); await waiting; return provider(offer); } });
  const rejected = expect(pending).rejects.toThrow("Revoked"); await ready; current = false; release(); await rejected;
  expect(f.manager.get(f.entry.id).slots[0]!.accounts).toEqual([]); expect(f.credentials.list()).toEqual([]);
});

it("keeps callback inputs ephemeral, connection bound and consumable only by the original service purpose", async () => {
  const f = await fixture(); const ticket = f.credentials.createUploadTicket({ kind: "oauth", connectionId: "owner", servicePurpose: "authorization-callback" });
  f.credentials.upload(ticket.credentialUploadTicketId, '{"code":"callback-private-fixture"}', "owner");
  await expect(f.credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, displayName: "Public", kind: "oauth", connectionId: "owner" })).rejects.toThrow("Ephemeral");
  expect(() => f.credentials.consumeServiceInput({ credentialUploadTicketId: ticket.credentialUploadTicketId, servicePurpose: "other", connectionId: "owner", kind: "oauth" })).toThrow();
  expect(() => f.credentials.consumeServiceInput({ credentialUploadTicketId: ticket.credentialUploadTicketId, servicePurpose: "authorization-callback", connectionId: "other", kind: "oauth" })).toThrow();
  expect(f.credentials.consumeServiceInput({ credentialUploadTicketId: ticket.credentialUploadTicketId, servicePurpose: "authorization-callback", connectionId: "owner", kind: "oauth" })).toContain("callback-private-fixture");
  expect(() => f.credentials.consumeServiceInput({ credentialUploadTicketId: ticket.credentialUploadTicketId, servicePurpose: "authorization-callback", connectionId: "owner", kind: "oauth" })).toThrow(); expect(f.credentials.list()).toEqual([]);
});

async function settingsFixture() {
  const f = await fixture(), settings = new ExtensionOAuthSettings({ accounts: f.manager, credentials: f.credentials, catalog: f.catalog });
  cleanup.push(() => settings.dispose());
  let active = true, connectionId = "controller";
  const revoked = new Set<() => void>(), original = { id: "controller", authKeyDigest: "digest" };
  const connections = { authenticate: () => ({ id: connectionId, authKeyDigest: "digest" }),
    fence: (connection: { id: string }) => { if (connection.id === original.id && !active) throw new Error("Revoked"); return connection; },
    onRevoked: (_id: string, listener: () => void) => { revoked.add(listener); return () => revoked.delete(listener); }
  } as unknown as ConnectionManager;
  const client = createClient(ExtensionOAuthService, createRouterTransport(router => router.service(ExtensionOAuthService, createExtensionOAuthConnectService(settings, connections, () => {}))));
  const start = (signal?: AbortSignal) => client.start({ extensionId: f.entry.id, slotKey: "account", expectedRevision: { value: f.catalog.get(f.entry.id).revision } }, { signal });
  return { ...f, settings, client, start, otherConnection: () => { connectionId = "other"; }, revoke: () => { active = false; for (const listener of [...revoked]) listener(); } };
}
it("completes the formal protected callback after Start finishes without exposing credentials in account state", async () => {
  const f = await settingsFixture(), request = new AbortController(), { flow } = await f.start(request.signal); request.abort();
  let offer!: NonNullable<typeof flow>["authorization"];
  await vi.waitFor(async () => { const result = (await f.client.getFlow({ flowId: flow!.flowId })).flow!; expect(result.phase).toBe(Phase.AUTHORIZING); offer = result.authorization; });
  const callback = await f.authorize("formal@example.test")(offer!);
  const { ticket } = await f.client.beginCallback({ flowId: flow!.flowId });
  f.credentials.upload(ticket!.ticketId, JSON.stringify(callback), "controller");
  await f.client.completeCallback({ flowId: flow!.flowId, credentialUploadTicketId: ticket!.ticketId });
  await vi.waitFor(async () => expect((await f.client.getFlow({ flowId: flow!.flowId })).flow!.phase).toBe(Phase.COMPLETE));
  const state = (await f.client.get({ extensionId: f.entry.id })).state!;
  expect(state.slots[0]!.accounts[0]).toMatchObject({ label: "Team · formal@example.test", isDefault: true, expired: false });
  const publicState = toJsonString(ExtensionOAuthStateSchema, state);
  for (const value of [callback.code, "builtin-installed-public-value", "access-private-fixture-", "refresh-private-fixture-", "extension-oauth:"]) expect(publicState).not.toContain(value);
  await expect(f.client.completeCallback({ flowId: flow!.flowId, credentialUploadTicketId: ticket!.ticketId })).rejects.toThrow();
  f.otherConnection(); await expect(f.client.getFlow({ flowId: flow!.flowId })).rejects.toThrow();
});
it("retires an offered authorization when its client is changed through protected settings", async () => {
  const f = await settingsFixture(), { flow } = await f.start();
  await vi.waitFor(async () => expect((await f.client.getFlow({ flowId: flow!.flowId })).flow!.phase).toBe(Phase.AUTHORIZING));
  const begun = await f.client.beginClient({ extensionId: f.entry.id, slotKey: "account", expectedRevision: { value: f.catalog.get(f.entry.id).revision } });
  f.credentials.upload(begun.ticket!.ticketId, JSON.stringify({ clientId: "custom-client", clientSecret: "private-client-settings-fixture" }), "controller");
  const result = await f.client.commitClient({ extensionId: f.entry.id, credentialUploadTicketId: begun.ticket!.ticketId });
  expect(result.state!.slots[0]).toMatchObject({ clientCustomized: true, clientConfigured: true, accounts: [] });
  await vi.waitFor(async () => { const current = (await f.client.getFlow({ flowId: flow!.flowId })).flow!;
    expect(current).toMatchObject({ phase: Phase.FAILED, failure: Failure.INVALID_CONFIG }); expect(current.authorization).toBeUndefined(); });
  expect(f.requests).toHaveLength(0);
});
it("discards a late token response after its original controller connection is revoked", async () => {
  const f = await settingsFixture(); let arrived!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { arrived = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  f.provider(async () => { arrived(); await pending; return new Response(JSON.stringify(f.bundle("revoked@example.test"))); });
  cleanup.push(async () => release());
  const { flow } = await f.start(); let offer!: NonNullable<typeof flow>["authorization"];
  await vi.waitFor(async () => { const result = (await f.client.getFlow({ flowId: flow!.flowId })).flow!; expect(result.phase).toBe(Phase.AUTHORIZING); offer = result.authorization; });
  const callback = await f.authorize("revoked@example.test")(offer!), { ticket } = await f.client.beginCallback({ flowId: flow!.flowId });
  f.credentials.upload(ticket!.ticketId, JSON.stringify(callback), "controller");
  await f.client.completeCallback({ flowId: flow!.flowId, credentialUploadTicketId: ticket!.ticketId }); await ready;
  f.revoke(); release(); await f.settings.dispose();
  expect(f.manager.get(f.entry.id).slots[0]!.accounts).toEqual([]); expect(f.credentials.list()).toEqual([]);
});

it("injects the selected account, refreshes it once on 401 and keeps token bytes out of the plugin result", async () => {
  const f = await fixture(); await f.connect("default@example.test"); await f.connect("selected@example.test");
  const accounts = f.manager.get(f.entry.id).slots[0]!.accounts, selected = accounts[1]!.id; f.requests.length = 0;
  const injected: string[] = [], fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const authorization = new Headers(init?.headers).get("authorization")!; injected.push(authorization);
    return new Response(JSON.stringify({ authorization }), { status: injected.length === 1 ? 401 : 200, headers: { "content-type": "application/json" } });
  });
  const network = new ExtensionNetwork({ fetch: fetcher, resolveCredential: () => { throw new Error("OAuth must not use a public credential reference"); }, oauth: f.manager, redact: value => f.credentials.redactText(value) });
  const declaration = parseExtensionNetwork({ hosts: ["auth.example.test", "api.example.test"], secrets: [{ key: "account", label: "Account", source: "oauth", oauth: f.declaration(), inject: { header: "Authorization", hosts: ["api.example.test"], format: "Bearer {value}" } }] });
  const scope = { extensionId: f.entry.id, authorityKey: "original-runtime", declaration, readOnly: false, signal: new AbortController().signal, assertCurrent: () => {} };
  const result = await network.request(scope, { url: "https://api.example.test/data", authAccount: selected });
  expect(result).toMatchObject({ ok: true, status: 200 }); expect(injected).toHaveLength(2); expect(injected[0]).not.toBe(injected[1]);
  for (const header of injected) expect(JSON.stringify(result)).not.toContain(header.replace("Bearer ", ""));
  expect(f.requests.filter(request => request.form.get("grant_type") === "refresh_token")).toHaveLength(1);
  expect(f.manager.get(f.entry.id).slots[0]!.accounts[0]!.isDefault).toBe(true);
  expect((await f.manager.fresh(f.entry.id, "account", f.declaration(), accounts[0]!.id)).ok).toBe(true);
  expect(f.requests.filter(request => request.form.get("grant_type") === "refresh_token")).toHaveLength(1);
  await expect(network.request(scope, { url: "https://api.example.test/data", authAccount: "unknown-account" })).resolves.toMatchObject({ ok: false, error: "NO_ACCOUNT" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("backfills an unavailable identity on refresh without replacing the stable account", async () => {
  const f = await fixture(); f.identityAvailable(false); await f.connect("eventual@example.test");
  const row = f.manager.get(f.entry.id).slots[0]!.accounts[0]!; expect(row.label).toBeUndefined();
  f.identityAvailable(true); f.manager.invalidate(f.entry.id, "account", row.id);
  expect(await f.manager.fresh(f.entry.id, "account", f.declaration())).toMatchObject({ ok: true, accountId: row.id });
  await vi.waitFor(() => expect(f.manager.get(f.entry.id).slots[0]!.accounts).toMatchObject([{ id: row.id, label: "Team · eventual@example.test", isDefault: true }]));
});
