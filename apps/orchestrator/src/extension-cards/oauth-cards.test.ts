import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { ExtensionCardService, ExtensionOAuthService, ExtensionAuthorizationPhase as Phase } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialVault } from "../credential-vault.js";
import { CredentialManager } from "../credential-manager.js";
import { ExtensionCatalogManager } from "../extension-catalog.js";
import type { PiResourceDescriptor } from "../resource-manager.js";
import type { ConnectionManager } from "../connection-manager.js";
import type { BridgeToolProvider } from "../mcp-router.js";
import type { ExtensionMainViewManager } from "../extension-main-view-manager.js";
import { parseExtensionRuntime } from "../extension-surface-manifest.js";
import { ExtensionOAuthAccounts } from "./oauth-accounts.js";
import { ExtensionOAuthSettings } from "./oauth-settings.js";
import { ExtensionCardsManager } from "./manager.js";
import { ExtensionCardRuntime } from "./runtime.js";
import { ExtensionOAuthCards, EXTENSION_OAUTH_CARD_ACTION } from "./oauth-cards.js";
import { createExtensionOAuthConnectService } from "./oauth-connect-service.js";
import { createExtensionCardConnectService } from "./connect-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-oauth-card-")), store = new OperationalStore(join(root, "store.db"));
  const vault = await CredentialVault.open(join(root, "vault.key")), credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") }); await credentials.initialize();
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "runtime", displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: "task", backendId: "runtime", targetId: "target", title: "Task", binding: { opaqueRef: "native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const catalog = new ExtensionCatalogManager({ store, credentials }); catalog.initialize();
  const declaration = parseExtensionRuntime({ html: "ui/runtime.html", tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, readOnly: true }], network: {
    hosts: ["auth.example.test", "api.example.test"], secrets: [{ key: "account", label: "Mail account", source: "oauth", inject: { header: "Authorization", format: "Bearer {value}" },
      oauth: { authorizeUrl: "https://auth.example.test/authorize", tokenUrl: "https://auth.example.test/token", clientId: "installed-client", scopes: ["mail.read"] } }] } });
  const resource = { id: "resource", backendId: "runtime", kind: "package", scope: "managed", state: "installed", enabled: true, sourceKind: "local", sourceDisplay: "Account fixture", packageIdentity: "@fixture/account", version: "1.0.0", discoveredRevision: "sha256:fixture-1", versionNumber: 1n,
    resourceDetails: [{ kind: "extension", name: "Account fixture", entryPath: "extensions/main.js", runtime: declaration, compatibility: "supported", compatibilityIssues: [], detectedApis: [] }] } as unknown as PiResourceDescriptor;
  const entry = catalog.reconcile([resource], []).entries[0]!;
  const attempt = catalog.beginSetup(entry.id, entry.revision);
  const confirmed = catalog.submitSetupInteraction({ extensionId: entry.id, attemptId: attempt.setup.attemptId!, fieldId: "permission-confirmation", value: true, expectedRevision: attempt.revision });
  catalog.completeSetup(entry.id, attempt.setup.attemptId!, confirmed.revision);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: "card-private-access", refresh_token: "card-private-refresh", expires_in: 3600 })));
  const accounts = new ExtensionOAuthAccounts({ store, vault, credentials, catalog, fetch: fetchImpl }); await accounts.initialize();
  const settings = new ExtensionOAuthSettings({ accounts, credentials, catalog });
  let installationKey = "installation-one", runtime: ExtensionCardRuntime | undefined, useRuntime = false;
  const authority = () => useRuntime ? runtime?.authority(entry.id) : { key: accounts.identity(entry.id, "account"), installationKey, name: "Mail", runtime: declaration };
  let authorization: ExtensionOAuthCards | undefined;
  const dispatch = vi.fn(async () => {}), continuation = vi.fn(async (_scope: unknown, _text: string, guard: (() => Promise<void>) & { signal: AbortSignal }) => { await guard(); });
  const cards = new ExtensionCardsManager({ store, vault, authority, redact: value => credentials.redactText(value), dispatch, oauthCards: () => authorization });
  authorization = new ExtensionOAuthCards({ cards, store, settings, accounts, catalog, authority, continueTask: continuation });
  const revoked = new Set<string>(), listeners = new Map<string, Set<() => void>>();
  const connections = { authenticate: (header: string) => ({ id: header.slice(7) }), fence: (connection: { id: string }) => { if (revoked.has(connection.id)) throw new Error("revoked"); }, onRevoked: (id: string, listener: () => void) => {
    let set = listeners.get(id); if (!set) { set = new Set(); listeners.set(id, set); } set.add(listener); return () => set!.delete(listener);
  } } as unknown as ConnectionManager;
  const transport = createRouterTransport(({ service }) => { service(ExtensionCardService, createExtensionCardConnectService(cards, connections)); service(ExtensionOAuthService, createExtensionOAuthConnectService(settings, connections, () => {})); });
  const client = createClient(ExtensionCardService, transport), oauth = createClient(ExtensionOAuthService, transport), headers = { authorization: "Bearer original" };
  const requireAccount = async () => {
    const selected = authority()!, callId = cards.registerCall(entry.id, selected.key, "task", "tool"), scope = cards.cards.callInfoOf(callId)!;
    await authorization!.require(callId, scope, authorization!.missing(entry.id)!, () => {}); await cards.finalizeCall(callId); return callId;
  };
  const start = (cardId: string) => client.dispatch({ sessionId: "task", cardId, actionId: EXTENSION_OAUTH_CARD_ACTION }, { headers });
  const ready = async (flowId: string) => {
    let flow = (await oauth.getFlow({ flowId }, { headers })).flow!;
    await vi.waitFor(async () => { flow = (await oauth.getFlow({ flowId }, { headers })).flow!; expect(flow.phase).toBe(Phase.AUTHORIZING); }); return flow;
  };
  const complete = async (flowId: string) => {
    const flow = await ready(flowId), { ticket } = await oauth.beginCallback({ flowId }, { headers });
    credentials.upload(ticket!.ticketId, JSON.stringify({ state: flow.authorization!.state, code: "card-private-code" }), "original");
    return oauth.completeCallback({ flowId, credentialUploadTicketId: ticket!.ticketId }, { headers });
  };
  cleanup.push(async () => { await runtime?.stop(); await cards.dispose(); await settings.dispose(); await accounts.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, credentials, catalog, entry, resource, cards, authorization, settings, accounts, client, oauth, headers, dispatch, continuation, fetchImpl, requireAccount, start, ready, complete,
    replaceInstallation: () => { installationKey = "installation-two"; }, revoke: () => { revoked.add("original"); for (const listener of listeners.get("original") ?? []) listener(); },
    startRuntime: async () => {
      useRuntime = true; let provider: BridgeToolProvider | undefined;
      const launch = vi.fn(async () => { throw new Error("Account setup must precede author code."); });
      runtime = new ExtensionCardRuntime({ catalog, resources: { get: () => resource }, store, vault, cards, oauth: accounts, oauthCards: authorization,
        surfaces: {} as ExtensionMainViewManager, launch, registerProvider: value => { provider = value; return () => {}; }, redact: value => value, continueTask: continuation });
      await runtime.start(); return { provider: provider!, launch };
    } };
}

it("assesses missing accounts before opening author code and publishes a host authorization card", async () => {
  const f = await fixture(), { provider, launch } = await f.startRuntime();
  const result = await provider.callTool("lookup", {}, undefined, { sessionId: "task", targetId: "target", generation: 1 });
  expect(result.structuredContent).toMatchObject({ setup_required: true, joko_card_id: expect.any(String) }); expect(launch).not.toHaveBeenCalled();
  const response = await f.client.get({ sessionId: "task", cardId: result.structuredContent!.joko_card_id as string }, { headers: f.headers });
  expect(response).toMatchObject({ hostAuthorization: true, interactive: true }); expect(response.card!.html).toContain("Connect account");
});
it("keeps the original Connection, host callback and card occurrence private, then resumes the original task once", async () => {
  const f = await fixture(), id = await f.requireAccount(), started = await f.start(id), flowId = started.authorizationFlowId;
  expect(started.accepted).toBe(true); expect(flowId).toBeTruthy(); expect(JSON.stringify(started)).not.toContain("authorizeUrl"); expect(f.dispatch).not.toHaveBeenCalled();
  await expect(f.oauth.getFlow({ flowId }, { headers: { authorization: "Bearer another" } })).rejects.toThrow();
  await f.complete(flowId);
  await vi.waitFor(() => expect(f.continuation).toHaveBeenCalledOnce());
  expect(f.accounts.get(f.entry.id).slots[0]!.accounts).toHaveLength(1);
  expect(f.cards.get("task", id)).toMatchObject({ hostAuthorization: true, authorizationPhase: Phase.COMPLETE, interactive: false });
  await expect(f.start(id)).rejects.toThrow(); expect(f.continuation).toHaveBeenCalledOnce();
  const persisted = JSON.stringify(f.store.listEvents({ sessionId: "task" }).map(event => event.payload));
  for (const secret of ["card-private-code", "card-private-access", "card-private-refresh"]) expect(persisted + JSON.stringify(f.continuation.mock.calls)).not.toContain(secret);
});
it.each(["connection", "installation", "generation", "occurrence"] as const)("discards a late callback after the original %s changes", async change => {
  const f = await fixture(), id = await f.requireAccount(), { authorizationFlowId: flowId } = await f.start(id);
  const flow = await f.ready(flowId), { ticket } = await f.oauth.beginCallback({ flowId }, { headers: f.headers });
  f.credentials.upload(ticket!.ticketId, JSON.stringify({ state: flow.authorization!.state, code: "card-private-code" }), "original");
  if (change === "connection") f.revoke();
  else if (change === "installation") f.replaceInstallation();
  else if (change === "generation") f.store.updateSession("task", { binding: { opaqueRef: "new", generation: 2 } });
  else await f.cards.publishHostAuthorization(id, f.cards.cards.callInfoOf(id)!, "<p>Replacement occurrence</p>", () => {});
  await expect(f.oauth.completeCallback({ flowId, credentialUploadTicketId: ticket!.ticketId }, { headers: f.headers })).rejects.toThrow();
  expect(f.fetchImpl).not.toHaveBeenCalled(); expect(f.accounts.get(f.entry.id).slots[0]!.accounts).toHaveLength(0); expect(f.continuation).not.toHaveBeenCalled();
});
it("does not grant author HTML a host transaction, and never restores a host card action after restart", async () => {
  const f = await fixture(), source = f.accounts.identity(f.entry.id, "account"), forged = f.cards.registerCall(f.entry.id, source, "task", null);
  // No ordinary card capability is declared: the author cannot even publish it.
  expect(await f.cards.cards.handleCardUpdate(f.entry.id, source, { type: "card-update", version: 1, callId: forged, html: `<section data-joko-host-authorization="true"><button data-joko-action="${EXTENSION_OAUTH_CARD_ACTION}">Connect</button></section>` }, () => {})).toMatchObject({ accepted: false });
  await expect(f.start(forged)).rejects.toThrow(); expect(f.fetchImpl).not.toHaveBeenCalled();
  const actual = await f.requireAccount(); f.authorization.dispose();
  expect(f.cards.get("task", actual)).toMatchObject({ hostAuthorization: true, interactive: false }); expect(await f.start(actual)).toMatchObject({ accepted: false }); expect(f.dispatch).not.toHaveBeenCalled();
});
