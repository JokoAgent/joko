import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { ExtensionNetworkService, ExtensionNetworkStateSchema } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionManager } from "../connection-manager.js";
import { CredentialManager } from "../credential-manager.js";
import { CredentialVault } from "../credential-vault.js";
import { ExtensionCatalogManager } from "../extension-catalog.js";
import type { PiResourceDescriptor } from "../resource-manager.js";
import { mkdtemp } from "../test-paths.js";
import { parseExtensionRuntime } from "../extension-surface-manifest.js";
import { ExtensionNetworkConnections } from "./network-connections.js";
import { ExtensionNetworkSettings } from "./network-settings.js";
import { createExtensionNetworkConnectService } from "./network-connect-service.js";
import { ExtensionNetwork } from "./network.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-network-settings-")), store = new OperationalStore(join(root, "store.db"));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await CredentialVault.open(join(root, "vault.key")), storagePath = join(root, "credentials.json");
  const credentials = new CredentialManager({ vault, storagePath }); await credentials.initialize();
  const catalog = new ExtensionCatalogManager({ store, credentials }); catalog.initialize();
  const runtime = parseExtensionRuntime({ html: "ui/runtime.html", tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" }, readOnly: true }],
    network: { connections: [{ key: "service", label: "Service", maxConnections: 2, inject: { header: "Authorization", format: "Bearer {value}" } }] } });
  const resource = { id: "resource", backendId: "runtime", kind: "package", scope: "managed", state: "installed", enabled: true, sourceKind: "local",
    sourceDisplay: "Fixture service", discoveredRevision: "sha256:fixture", versionNumber: 1n,
    resourceDetails: [{ kind: "extension", name: "Fixture service", entryPath: "extensions/main.js", runtime, compatibility: "supported", compatibilityIssues: [], detectedApis: [] }] } as unknown as PiResourceDescriptor;
  const entry = catalog.reconcile([resource], []).entries[0]!, connections = new ExtensionNetworkConnections({ store, credentials });
  const settings = new ExtensionNetworkSettings({ catalog, connections, credentials }); await settings.initialize(); cleanup.push(() => settings.dispose());
  const pairedConnections = new ConnectionManager(store), challenge = pairedConnections.issuePairing("Settings");
  const paired = pairedConnections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Settings browser" });
  const secondChallenge = pairedConnections.issuePairing("Other browser");
  const other = pairedConnections.completePairing({ challengeId: secondChallenge.id, code: secondChallenge.code, connectionName: "Other browser" });
  const headers = { authorization: `Bearer ${paired.authKey}` }, otherHeaders = { authorization: `Bearer ${other.authKey}` };
  const client = createClient(ExtensionNetworkService, createRouterTransport(router => router.service(ExtensionNetworkService, createExtensionNetworkConnectService(settings, pairedConnections, () => {}))));
  const get = async () => (await client.get({ extensionId: entry.id }, { headers })).state!;
  const begin = async (host: string, label?: string) => {
    const state = await get(); return (await client.beginCredential({ extensionId: entry.id, expectedRevision: state.revision, slotKey: "service", host, ...(label === undefined ? {} : { label }) }, { headers })).ticket!;
  };
  const save = async (host: string, token: string, label?: string) => {
    const ticket = await begin(host, label); credentials.upload(ticket.ticketId, token, paired.connection.id);
    return (await client.commitCredential({ extensionId: entry.id, credentialUploadTicketId: ticket.ticketId }, { headers })).state!;
  };
  return { root, store, vault, storagePath, credentials, catalog, resource, runtime, entry, connections, settings, client, pairedConnections, paired, other, headers, otherHeaders, get, begin, save };
}

it("manages exact-host connections through the public settings contract, network owner and restart", async () => {
  const f = await fixture(), id = f.entry.id, declaration = f.runtime.network!.connections![0]!;
  await expect(f.client.get({ extensionId: id })).rejects.toThrow();
  await expect(f.begin("https://one.example.test")).rejects.toThrow();
  const first = await f.save("One.Example.Test", "first-settings-private-token", "One"), firstId = first.slots[0]!.connections[0]!.connectionId;
  const originalReference = [...f.connections.references()][0]!;
  const second = await f.save("two.example.test", "second-settings-private-token", "Two"), secondId = second.slots[0]!.connections[1]!.connectionId;
  await expect(f.begin("third.example.test")).rejects.toThrow();
  const updated = await f.save("one.example.test", "updated-settings-private-token", "");
  expect(updated.slots[0]!.connections[0]).toMatchObject({ connectionId: firstId, host: "one.example.test", isDefault: true, configured: true });
  expect(updated.slots[0]!.connections[0]!.label).toBeUndefined(); expect(f.credentials.find(originalReference)).toBeUndefined(); expect(f.credentials.list()).toEqual([]);
  const attempt = f.catalog.beginSetup(id, updated.revision!.value), confirmed = f.catalog.submitSetupInteraction({ extensionId: id, attemptId: attempt.setup.attemptId!, fieldId: "permission-confirmation", value: true, expectedRevision: attempt.revision });
  f.catalog.completeSetup(id, attempt.setup.attemptId!, confirmed.revision);
  let state = await f.get();
  state = (await f.client.change({ extensionId: id, expectedRevision: state.revision, slotKey: "service", action: { case: "defaultConnectionId", value: secondId } }, { headers: f.headers })).state!;
  expect(state.slots[0]!.connections[1]!.isDefault).toBe(true);
  const sent: string[] = [], network = new ExtensionNetwork({ connections: f.connections, resolveCredential: reference => f.credentials.resolve(reference), redact: value => f.credentials.redactText(value),
    fetch: (async (_url, options) => { sent.push(new Headers(options?.headers).get("authorization") ?? ""); return new Response("updated-settings-private-token"); }) as typeof fetch });
  const authority = f.connections.identity(id, declaration);
  const response = await network.request({ extensionId: id, authorityKey: authority, declaration: f.runtime.network!, signal: new AbortController().signal, readOnly: false,
    assertCurrent: () => { if (f.connections.identity(id, declaration) !== authority) throw new Error("Changed"); } }, { url: "https://one.example.test/messages" });
  expect(sent).toEqual(["Bearer updated-settings-private-token"]); expect(JSON.stringify(response)).not.toContain("updated-settings-private-token");
  state = (await f.client.change({ extensionId: id, expectedRevision: state.revision, slotKey: "service", action: { case: "removeConnectionId", value: secondId } }, { headers: f.headers })).state!;
  expect(state.slots[0]!.connections).toMatchObject([{ connectionId: firstId, isDefault: true }]);
  await f.settings.dispose();
  const credentials = new CredentialManager({ vault: f.vault, storagePath: f.storagePath }); await credentials.initialize();
  const connections = new ExtensionNetworkConnections({ store: f.store, credentials });
  const restarted = new ExtensionNetworkSettings({ catalog: f.catalog, connections, credentials }); await restarted.initialize(); cleanup.push(() => restarted.dispose());
  expect(create(ExtensionNetworkStateSchema, restarted.get(id))).toEqual(state); expect(connections.token(id, declaration, "one.example.test")).toBe("updated-settings-private-token"); expect(credentials.list()).toEqual([]);
  expect(JSON.stringify(f.store.listSettings().map(row => row.value))).not.toContain("settings-private-token");
  const liveReference = [...connections.references()][0]!; f.catalog.reconcile([], []);
  await vi.waitFor(() => { expect([...connections.references()]).toEqual([]); expect(credentials.find(liveReference)).toBeUndefined(); });
});

it("binds uploads to the original paired owner and catalog revision and rolls back staged tokens", async () => {
  const f = await fixture(), id = f.entry.id;
  const ticket = await f.begin("one.example.test");
  expect(() => f.credentials.upload(ticket.ticketId, "other-browser-private-token", f.other.connection.id)).toThrow();
  f.credentials.upload(ticket.ticketId, "staged-settings-private-token", f.paired.connection.id);
  await expect(f.client.commitCredential({ extensionId: id, credentialUploadTicketId: ticket.ticketId }, { headers: f.otherHeaders })).rejects.toThrow();
  let staged!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { staged = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const commit = f.credentials.commitManagedUpload.bind(f.credentials);
  vi.spyOn(f.credentials, "commitManagedUpload").mockImplementationOnce(async input => { const value = await commit(input); staged(); await gate; return value; });
  const pending = f.client.commitCredential({ extensionId: id, credentialUploadTicketId: ticket.ticketId }, { headers: f.headers });
  const rejected = expect(pending).rejects.toThrow(); await ready;
  f.pairedConnections.revoke(f.paired.connection.id); release(); await rejected;
  expect(f.connections.hosts(id, f.runtime.network!.connections![0]!)).toEqual([]); expect(f.credentials.list()).toEqual([]);
  const references = [...f.connections.references()]; expect(references).toEqual([]);
  const otherTicket = f.settings.begin({ extensionId: id, revision: f.catalog.get(id).revision, slotKey: "service", host: "two.example.test", connectionId: f.other.connection.id });
  f.credentials.upload(otherTicket.credentialUploadTicketId, "stale-catalog-private-token", f.other.connection.id);
  f.catalog.updateNetworkConfiguration(id, f.catalog.get(id).revision, () => {});
  await expect(f.client.commitCredential({ extensionId: id, credentialUploadTicketId: otherTicket.credentialUploadTicketId }, { headers: f.otherHeaders })).rejects.toThrow();
  const revision = f.catalog.get(id).revision;
  expect(() => f.catalog.updateNetworkConfiguration(id, revision, () => { f.store.setSetting("service", "test", "rollback", true); throw new Error("Rejected"); })).toThrow("Rejected");
  expect(f.catalog.get(id).revision).toBe(revision); expect(f.store.findSetting("service", "test", "rollback")).toBeUndefined();
});

it("retires an interrupted staged credential on startup while preserving user credentials", async () => {
  const f = await fixture(); await f.settings.dispose();
  const reservation = f.connections.reserve(f.entry.id, f.runtime.network!.connections![0]!, { host: "one.example.test" });
  f.credentials.reserveManagedSecret({ credentialReferenceId: reservation.reference, kind: "header_secret" });
  const staged = f.credentials.createUploadTicket({ credentialReferenceId: reservation.reference, kind: "header_secret" });
  f.credentials.upload(staged.credentialUploadTicketId, "interrupted-connection-private-token");
  await f.credentials.commitManagedUpload({ credentialUploadTicketId: staged.credentialUploadTicketId, credentialReferenceId: reservation.reference, kind: "header_secret", displayName: "Interrupted" });
  const user = f.credentials.createUploadTicket(); f.credentials.upload(user.credentialUploadTicketId, "existing-user-private-token");
  await f.credentials.commitUpload({ credentialUploadTicketId: user.credentialUploadTicketId, credentialReferenceId: "user-owned-key", kind: "api_key", displayName: "Existing" });
  const credentials = new CredentialManager({ vault: f.vault, storagePath: f.storagePath }); await credentials.initialize();
  const restarted = new ExtensionNetworkSettings({ catalog: f.catalog, connections: new ExtensionNetworkConnections({ store: f.store, credentials }), credentials });
  await restarted.initialize(); cleanup.push(() => restarted.dispose());
  expect(credentials.find(reservation.reference)).toBeUndefined(); expect(credentials.list().map(row => row.credentialReferenceId)).toEqual(["user-owned-key"]);
  expect(credentials.resolve("user-owned-key")).toBe("existing-user-private-token");
});
