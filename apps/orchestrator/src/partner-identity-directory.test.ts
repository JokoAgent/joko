import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialVault } from "./credential-vault.js";
import { TaskSharingHost, type TaskSharingRuntimePort } from "./task-sharing-host.js";
import { TaskSharingHome, type TaskSharingHomeAuthority } from "./task-sharing-home.js";
import { createTaskSharingGuestConnectService } from "./task-sharing-connect-service.js";
import { PartnerIdentityDirectory, type PartnerIdentityProfile } from "./partner-identity-directory.js";
import { createPartnerIdentityService, createPartnerIdentityGuestService } from "./partner-identity-connect-service.js";
import type { ConnectionManager } from "./connection-manager.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
const auth = (): TaskSharingHomeAuthority => {
  const life = new AbortController(); return { deviceId: "home-device", signal: life.signal, assertCurrent: () => life.signal.throwIfAborted() };
};
async function fixture(origin: string | (() => string) = "http://127.0.0.1:4327") {
  const root = mkdtempSync(join(tmpdir(), "joko-partner-identity-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const sourceStore = new OperationalStore(join(root, "source.sqlite")), homeStore = new OperationalStore(join(root, "home.sqlite"));
  cleanup.push(() => { homeStore.close(); sourceStore.close(); });
  sourceStore.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  sourceStore.upsertTarget({ id: "target", backendId: "backend", displayName: "Target", workspaceRoot: root, managed: false, trusted: true });
  for (const id of ["canonical-one", "canonical-two"]) sourceStore.createSession({ id, backendId: "backend", targetId: "target", title: "Partner", binding: { opaqueRef: id, generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  let profile: PartnerIdentityProfile = { id: "partner-one", name: "Partner", description: "Shared public description", canonicalSessionId: "canonical-one", revision: 1n }, available = true;
  const vault = await CredentialVault.open(join(root, "source.key")), homeVault = await CredentialVault.open(join(root, "home.key"));
  const sourceHome = new TaskSharingHome({ directory: join(root, "source-home"), vault, serverId: "source" }); await sourceHome.initialize();
  const directory = new PartnerIdentityDirectory({ store: sourceStore, serverId: "source", origin, endpointPublicKey: `ed25519:${"a".repeat(64)}`, vault, home: sourceHome,
    partner: id => { if (!available || id !== profile.id) throw new Error("Not current"); return profile; } });
  const executed: string[] = [];
  const runtime: TaskSharingRuntimePort = { canShare: id => ["canonical-one", "canonical-two"].includes(id),
    snapshot: async lease => create(contract.SnapshotSchema, { scope: { kind: { case: "session", value: { sessionId: lease.scope.sessionId } } }, sessions: [{ sessionId: lease.scope.sessionId }] }),
    read: async () => new Uint8Array(), projectEvent: () => undefined,
    prepareOperation: lease => ({ kind: "transactional", commit: () => { executed.push(lease.scope.sessionId); return Uint8Array.of(1); } }) };
  const host = new TaskSharingHost({ store: sourceStore, serverId: "source", origin, endpointPublicKey: `ed25519:${"a".repeat(64)}`, generation: () => 1n, runtime,
    authorizeShare: (shareId, sessionId) => directory.authorizeScope(shareId, sessionId) }); directory.attachHost(host);
  cleanup.push(() => { host.close(); });
  const guest = createTaskSharingGuestConnectService(host), accept = vi.fn(guest.acceptTaskShareJoin!);
  const sharingTransport = createRouterTransport(router => router.service(contract.TaskSharingGuestService, { ...guest, acceptTaskShareJoin: accept }));
  const sharingRemote = { guest: createClient(contract.TaskSharingGuestService, sharingTransport), verify: vi.fn(async (id: string) => { expect(id).toBe("source"); }) };
  const home = new TaskSharingHome({ directory: join(root, "home"), vault: homeVault, serverId: "home", connect: (_origin, pin) => { expect(pin).toBe(`ed25519:${"a".repeat(64)}`); return sharingRemote; } }); await home.initialize();
  cleanup.push(() => home.dispose()); cleanup.push(() => sourceHome.dispose());
  const remote = { client: createClient(contract.PartnerIdentityGuestService, createRouterTransport(router => router.service(contract.PartnerIdentityGuestService, createPartnerIdentityGuestService(directory)))),
    verify: vi.fn(async (id: string) => { expect(id).toBe("source"); }) };
  const createHome = () => new PartnerIdentityDirectory({ store: homeStore, serverId: "home", origin: "http://127.0.0.1:4328", endpointPublicKey: `ed25519:${"b".repeat(64)}`, vault: homeVault, home,
    partner: () => { throw new Error("No duplicate Partner profile"); }, connect: (_origin, pin) => { expect(pin).toBe(`ed25519:${"a".repeat(64)}`); return remote; } });
  const links = createHome(); let revoked = false;
  const connections = { authenticate: vi.fn((header?: string) => { if (revoked || header !== "Bearer local-owner") throw new ConnectError("Owner required", Code.Unauthenticated); return { id: "owner", deviceId: "home-device" }; }),
    fence: vi.fn(() => { if (revoked) throw new ConnectError("Revoked", Code.PermissionDenied); }), onRevoked: () => () => undefined } as unknown as ConnectionManager;
  const rpc = createClient(contract.PartnerIdentityService, createRouterTransport(router => router.service(contract.PartnerIdentityService, createPartnerIdentityService(links, connections))));
  const call = { headers: { authorization: "Bearer local-owner" } };
  const issue = (operationId = "issue") => directory.issue(create(contract.IssuePartnerIdentityRequestSchema, { operationId, partnerId: profile.id, expectedRevision: profile.revision }));
  return { root, directory, links, createHome, home, homeStore, sourceStore, homeVault, host, remote, guest: remote.client, issue, executed, accept, rpc, call,
    move: () => { profile = { ...profile, canonicalSessionId: "canonical-two", revision: profile.revision + 1n }; }, offline: () => { available = false; }, revokeOwner: () => { revoked = true; } };
}

it("uses the live invitation entrance but keeps imported aliases and sealed task routes on their captured locator", async () => {
  let origin = "http://127.0.0.1:4327";
  const f = await fixture(() => origin);
  origin = "https://current.trycloudflare.com";
  const issued = f.issue("public-identity");
  expect(contract.parsePartnerIdentityInvitation(issued.invitation).origin).toBe(origin);
  const link = await f.links.import(issued.invitation, "Public Partner", auth());
  origin = "http://127.0.0.1:4327";
  const retained = f.issue("public-identity");
  expect(retained.invitation).toBe(issued.invitation);
  expect(contract.parsePartnerIdentityInvitation(f.issue("fallback-identity").invitation).origin).toBe(origin);
  const opened = await f.links.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "open-published", linkId: link.linkId, displayName: "Guest" }), auth());
  expect(opened.joined?.share?.hostOrigin).toBe("https://current.trycloudflare.com");
  await f.home.refreshDirectory(auth());
  expect(f.home.list().joined[0]?.share?.hostOrigin).toBe("https://current.trycloudflare.com");
  await expect(f.home.snapshot(opened.joined!.joinId, auth())).resolves.toMatchObject({ share: { hostOrigin: "https://current.trycloudflare.com" } });
  expect((await f.createHome().open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "open-after-withdrawal", linkId: link.linkId, displayName: "Guest" }), auth())).joined?.joinId).toBe(opened.joined!.joinId);
});

it("opens the current canonical over generated services, seals aliases, and re-resolves one identity after a primary move", async () => {
  const f = await fixture(), issued = f.issue(), secret = contract.parsePartnerIdentityInvitation(issued.invitation).secret;
  await expect(f.rpc.listPartnerIdentities({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  const imported = await f.rpc.importPartnerIdentity({ invitation: issued.invitation, alias: "My alias" }, f.call);
  expect(imported.link?.identity).toMatchObject({ authorityServerId: "source", partnerId: "partner-one" });
  expect(f.host.list()).toHaveLength(0);
  const opened = await f.rpc.openPartnerIdentity({ operationId: "open-one", linkId: imported.link!.linkId, displayName: "Guest" }, f.call);
  expect(opened.joined?.share?.sessionId).toBe("canonical-one");
  const body = toBinary(contract.SubmitOperationRequestSchema, create(contract.SubmitOperationRequestSchema, { operationId: "input-one", mutation: { payload: { case: "resumeSession", value: { sessionId: "canonical-one" } } } }));
  await f.home.invoke(opened.joined!.joinId, contract.TaskShareMethod.SUBMIT_OPERATION, body, auth()); expect(f.executed).toEqual(["canonical-one"]);
  const previousShare = opened.joined!.share!.shareId;
  f.move();
  await expect(f.home.snapshot(opened.joined!.joinId, auth())).rejects.toMatchObject({ code: Code.PermissionDenied });
  const reopened = await f.rpc.openPartnerIdentity({ operationId: "open-two", linkId: imported.link!.linkId, displayName: "Guest" }, f.call);
  expect(reopened.joined?.share?.sessionId).toBe("canonical-two"); expect(f.host.get(previousShare).status).toBe("ended");
  expect(reopened.link?.linkId).toBe(imported.link!.linkId); expect(reopened.link?.alias).toBe("My alias");
  expect(f.homeStore.listSessions()).toHaveLength(0); expect(f.sourceStore.listSessions()).toHaveLength(2);
  expect(JSON.stringify(f.links.list())).not.toContain(secret);
  const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item);
  expect(json(f.homeStore.listSettings())).not.toContain(secret); expect(json(f.sourceStore.listSettings())).not.toContain(secret);
  const restarted = f.createHome(); expect(restarted.list().links).toHaveLength(1);
  const same = await restarted.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "open-three", linkId: imported.link!.linkId, displayName: "Guest" }), auth());
  expect(same.joined?.joinId).toBe(reopened.joined!.joinId); expect(f.accept).toHaveBeenCalledTimes(2);
  f.directory.revoke(create(contract.RevokePartnerIdentityRequestSchema, { operationId: "revoke", grantId: issued.grant!.grantId }));
  await expect(f.home.snapshot(reopened.joined!.joinId, auth())).rejects.toThrow();
  await expect(restarted.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "open-four", linkId: imported.link!.linkId, displayName: "Guest" }), auth())).rejects.toThrow();
  expect(f.executed).toEqual(["canonical-one"]);
});

it("recovers an unknown join receipt without a second join, verifies authority before decrypting, and fences the owner", async () => {
  const f = await fixture(), issued = f.issue(), link = await f.links.import(issued.invitation, "Alias", auth());
  const original = f.accept.getMockImplementation()!;
  f.accept.mockImplementationOnce(async (...args) => { await original(...args); throw new ConnectError("Lost reply", Code.Unavailable); });
  const first = await f.links.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "unknown-one", linkId: link.linkId, displayName: "Guest" }), auth());
  expect(first.joined).toBeUndefined(); expect(first.intent?.status).toBe("unknown"); expect(f.accept).toHaveBeenCalledOnce();
  const recovered = await f.createHome().open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "check-original", linkId: link.linkId, displayName: "Guest" }), auth());
  expect(recovered.joined?.share?.sessionId).toBe("canonical-one"); expect(f.accept).toHaveBeenCalledOnce();
  const decrypt = vi.spyOn(f.homeVault, "open"); f.remote.verify.mockRejectedValueOnce(new ConnectError("Wrong server", Code.PermissionDenied));
  await expect(f.links.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "wrong-node", linkId: link.linkId, displayName: "Guest" }), auth())).rejects.toThrow();
  expect(decrypt).not.toHaveBeenCalled(); f.revokeOwner();
  await expect(f.rpc.listPartnerIdentities({}, f.call)).rejects.toMatchObject({ code: Code.Unauthenticated });
});

it("keeps identity proof outside ordinary auth and other Partner grants, and persists revocation after restart", async () => {
  const f = await fixture(), issued = f.issue(), parsed = contract.parsePartnerIdentityInvitation(issued.invitation);
  await expect(f.guest.inspectPartnerIdentity({ grantId: parsed.grantId, partnerId: parsed.partnerId })).rejects.toMatchObject({ code: Code.Unauthenticated });
  await expect(f.guest.inspectPartnerIdentity({ grantId: parsed.grantId, partnerId: "other" }, { headers: { authorization: `PartnerIdentity ${parsed.secret}` } })).rejects.toMatchObject({ code: Code.PermissionDenied });
  const link = await f.links.import(issued.invitation, "Alias", auth());
  const renamed = f.links.rename(link.linkId, "Renamed"); expect(renamed.alias).toBe("Renamed");
  await f.links.forget("forget", link.linkId, auth()); expect(f.createHome().list().links).toHaveLength(0);
  f.offline();
  await expect(f.links.import(issued.invitation, "Alias", auth())).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("replaces an uncertain old canonical scope after a primary move without replaying its join or input", async () => {
  const f = await fixture(), issued = f.issue(), link = await f.links.import(issued.invitation, "Alias", auth());
  const original = f.accept.getMockImplementation()!;
  f.accept.mockImplementationOnce(async (...args) => { await original(...args); throw new ConnectError("Lost reply", Code.Unavailable); });
  const first = await f.links.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "unknown-old", linkId: link.linkId, displayName: "Guest" }), auth());
  expect(first.intent?.status).toBe("unknown"); f.move();
  const next = await f.links.open(create(contract.OpenPartnerIdentityRequestSchema, { operationId: "new-main", linkId: link.linkId, displayName: "Guest" }), auth());
  expect(next.joined?.share?.sessionId).toBe("canonical-two"); expect(f.accept).toHaveBeenCalledTimes(2);
  expect(f.host.list().filter(share => share.status === "active").map(share => share.sessionId)).toEqual(["canonical-two"]); expect(f.executed).toEqual([]);
});
