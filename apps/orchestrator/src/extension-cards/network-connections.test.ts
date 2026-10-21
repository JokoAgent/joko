import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OperationalStore } from "@joko/store";
import { CredentialManager } from "../credential-manager.js";
import { CredentialVault } from "../credential-vault.js";
import { mkdtemp } from "../test-paths.js";
import { parseExtensionNetwork, normalizeExtensionConnectionHost } from "./network-manifest.js";
import { ExtensionNetworkConnections } from "./network-connections.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
const declaration = parseExtensionNetwork({ connections: [{ key: "service", label: "Service", maxConnections: 2, inject: { header: "X-Service-Key", format: "Bearer {value}" } }] }).connections![0]!;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-connections-")), store = new OperationalStore(join(root, "store.db"));
  close.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await CredentialVault.open(join(root, "vault.key")), credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const manager = new ExtensionNetworkConnections({ store, credentials });
  const save = async (host: string, value: string, label?: string) => {
    const reservation = manager.reserve("extension-one", declaration, { host, ...(label ? { label } : {}) });
    const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, value);
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: reservation.reference, displayName: "Service", kind: "header_secret" });
    manager.install(reservation); return reservation;
  };
  return { store, credentials, manager, save };
}

it("retains stable host identities through credential replacement, restart and default changes", async () => {
  const f = await fixture();
  const first = await f.save(" One.Example.Test ", "first-private-token", "First");
  await f.save("two.example.test", "second-private-token");
  const originalAuthorization = f.manager.authorization("extension-one", declaration);
  expect(f.manager.reserve("extension-one", declaration, { host: "one.example.test" }).row.id).toBe(first.row.id);
  await f.save("one.example.test", "replaced-private-token", "Updated");
  const restarted = new ExtensionNetworkConnections({ store: f.store, credentials: f.credentials });
  expect(restarted.list("extension-one", declaration)).toMatchObject([{ id: first.row.id, host: "one.example.test", label: "Updated", isDefault: true, configured: true }, { host: "two.example.test", isDefault: false }]);
  expect(restarted.token("extension-one", declaration, "one.example.test")).toBe("replaced-private-token");
  expect(restarted.authorization("extension-one", declaration)).not.toBe(originalAuthorization);
  expect(() => restarted.reserve("extension-one", declaration, { host: "three.example.test" })).toThrow("limit");
  const second = restarted.list("extension-one", declaration)[1]!; restarted.setDefault("extension-one", declaration, second.id);
  expect(restarted.list("extension-one", declaration)[1]!.isDefault).toBe(true);
  const reference = restarted.remove("extension-one", declaration, second.id)!; await f.credentials.delete(reference);
  expect(restarted.list("extension-one", declaration)).toMatchObject([{ id: first.row.id, isDefault: true }]);
  expect(JSON.stringify(f.store.listSettings().map(value => value.value))).not.toContain("private-token");
});

it("isolates declarations and rejects stale reservations and wildcard or URL hosts", async () => {
  const f = await fixture(); const stale = f.manager.reserve("extension-one", declaration, { host: "one.example.test" });
  await f.save("two.example.test", "second-private-token");
  const ticket = f.credentials.createUploadTicket(); f.credentials.upload(ticket.credentialUploadTicketId, "stale-private-token");
  await f.credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: stale.reference, displayName: "Stale", kind: "header_secret" });
  expect(() => f.manager.install(stale)).toThrow();
  expect(f.manager.list("extension-other", declaration)).toEqual([]);
  expect(f.manager.list("extension-one", { ...declaration, inject: { ...declaration.inject, format: "Token {value}" } })).toEqual([]);
  expect(f.manager.token("extension-one", declaration, "other.example.test")).toBeUndefined();
  for (const host of ["*.example.test", "https://example.test", "localhost", "127.0.0.1", "example.test:443"]) expect(() => normalizeExtensionConnectionHost(host)).toThrow();
});
