// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayCallbacks, OrchestratorGateway } from "./gateway.js";
import { emptySnapshot, type AppSnapshot, type ConnectionProfile, type PartnerProfileView, type PartnerSessionView } from "./model.js";
import { PartnerSourceDirectory, parsePartnerSourceCache, partnerSourceKey, partnerSourceRows, validatePartnerSourceSession } from "./partner-sources.js";

beforeEach(() => localStorage.clear());
const first: ConnectionProfile = { id: "connection-a", deviceId: "device-a", serverId: "node-a", name: "Node A", origin: "https://a.example" };
const second: ConnectionProfile = { id: "connection-b", deviceId: "device-b", serverId: "node-b", name: "Node B", origin: "https://b.example" };

describe("independent Partner source directory", () => {
  it("excludes archived remote profiles and rejects incompatible cached archived rows while keeping active and paused display rows", () => {
    const base = profile(first);
    const rows = partnerSourceRows({ directory: { revision: 1n, activeCount: 2, archivedCount: 1, errorCount: 0, updatedAt: 1, templates: [], avatarPresets: [] },
      partners: [base, { ...base, id: "paused", lifecycle: "paused" }, { ...base, id: "archived", lifecycle: "archived" }, { ...base, id: "deleted", lifecycle: "deleted" }] });
    expect(rows.map(row => row.id)).toEqual(["same-partner", "paused"]);
    const key = partnerSourceKey(first), cache = { version: 1, sourceKey: key, rows: rows.map(row => ({ ...row, revision: row.revision.toString() })) };
    expect(parsePartnerSourceCache(JSON.stringify(cache), key).map(row => row.id)).toEqual(["same-partner", "paused"]);
    cache.rows.push({ ...cache.rows[0]!, id: "archived", lifecycle: "archived" });
    expect(parsePartnerSourceCache(JSON.stringify(cache), key)).toEqual([]);
  });
  it("keeps same-ID Partners separate and proves anonymous identity before decrypting each credential", async () => {
    const view = fixture(); view.directory.sync([first, second]); await view.directory.refreshAll();
    expect(view.order).toEqual(["probe:node-a", "probe:node-b", "secret:node-a", "secret:node-b"]);
    expect(view.directory.getSources().map(source => [source.key, source.status, source.rows[0]?.displayName])).toEqual([
      [partnerSourceKey(first), "online", "Partner on Node A"], [partnerSourceKey(second), "online", "Partner on Node B"]
    ]);
    expect(view.connections).toEqual([{ profileId: first.id, options: { snapshotOnly: true } }, { profileId: second.id, options: { snapshotOnly: true } }]);
    const resolved = await view.directory.resolve(partnerSourceKey(second), "same-partner", new AbortController().signal);
    expect(resolved.session.id).toBe("session-node-b");
    view.directory.dispose();
  });
  it("keeps only the failed source's display shard while the other source updates and clears revoked identities", async () => {
    const view = fixture(); view.directory.sync([first, second]); await view.directory.refreshAll();
    view.failedReads.add(first.id); view.names.set(second.id, "Updated B"); await view.directory.refreshAll();
    expect(view.directory.getSources().map(source => [source.status, source.rows[0]?.displayName])).toEqual([["readFailed", "Partner on Node A"], ["online", "Updated B"]]);
    view.revoked.add(first.id); await view.directory.refresh(partnerSourceKey(first));
    expect(view.directory.getSources()[0]).toMatchObject({ status: "accessDenied", rows: [] });
    expect(view.directory.getSources()[1]?.rows[0]?.displayName).toBe("Updated B");
    expect(localStorage.getItem("joko.partner-source.v1." + partnerSourceKey(first))).toBeNull();
    view.directory.dispose();
  });
  it("retires late responses on foreground loss and forget, and never reads a credential after node identity changes", async () => {
    const view = fixture(); view.directory.sync([first]); await view.directory.refreshAll();
    const late = deferred(); view.pendingReads.set(first.id, late.promise);
    const refresh = view.directory.refresh(partnerSourceKey(first)); await settle();
    view.directory.setForeground(false); late.resolve(); await refresh;
    expect(view.directory.getSources()[0]).toMatchObject({ status: "offline", rows: [{ displayName: "Partner on Node A" }] });
    view.pendingReads.delete(first.id); view.directory.setForeground(true); view.identityMismatch.add(first.id);
    view.readAuthKey.mockClear(); await view.directory.refresh(partnerSourceKey(first));
    expect(view.readAuthKey).not.toHaveBeenCalled();
    expect(view.directory.getSources()[0]).toMatchObject({ status: "identityMismatch", rows: [] });
    view.directory.sync([]); expect(view.directory.getSources()).toEqual([]); expect(localStorage.length).toBe(0);
    view.directory.dispose();
  });
  it("stores a strict display-only cache, restores offline cards and rejects foreign or expanded cache shapes", async () => {
    const view = fixture(); view.directory.sync([first]); await view.directory.refreshAll();
    const key = partnerSourceKey(first), raw = localStorage.getItem("joko.partner-source.v1." + key)!;
    expect(raw).not.toContain("canonicalSessionId"); expect(raw).not.toContain("identitySource"); expect(raw).not.toContain("modelChain");
    expect(parsePartnerSourceCache(raw, key)).toHaveLength(1); expect(parsePartnerSourceCache(raw, partnerSourceKey(second))).toEqual([]);
    const expanded = JSON.parse(raw); expanded.rows[0].canonicalSessionId = "injected";
    expect(parsePartnerSourceCache(JSON.stringify(expanded), key)).toEqual([]);
    view.directory.dispose(); const restored = fixture(); restored.directory.sync([first]);
    expect(restored.directory.getSources()[0]).toMatchObject({ status: "loading", rows: [{ displayName: "Partner on Node A" }] });
    restored.directory.dispose();
  });
  it("does not truncate a live directory to the display-cache bound", async () => {
    const view = fixture(); view.large.add(first.id); view.directory.sync([first]); await view.directory.refreshAll();
    expect(view.directory.getSources()[0]?.rows).toHaveLength(201);
    expect(localStorage.getItem("joko.partner-source.v1." + partnerSourceKey(first))).toBeNull(); view.directory.dispose();
  });
  it("fences source avatars by the exact source epoch and revision", async () => {
    const view = fixture(); view.images.add(second.id); view.directory.sync([first, second]); await view.directory.refreshAll();
    const image = { sha256: "a".repeat(64), mimeType: "image/png" as const, byteLength: 8 };
    await expect(view.directory.readAvatar(partnerSourceKey(second), "same-partner", 1n, image, new AbortController().signal)).resolves.toBe("data:node-b");
    expect(view.ownerReads).toEqual([second.id]);
    await expect(view.directory.readAvatar(partnerSourceKey(first), "same-partner", 1n, image, new AbortController().signal)).rejects.toThrow("unavailable");
    view.directory.dispose();
  });
  it.each(["avatar", "canonical", "preparation"] as const)("refreshes and rejects a revoked owner before the formal %s read", async operation => {
    const view = fixture(); view.images.add(first.id); view.directory.sync([first]); await view.directory.refreshAll();
    view.revokedOwners.add(first.id);
    const key = partnerSourceKey(first), signal = new AbortController().signal;
    const read = operation === "avatar" ? view.directory.readAvatar(key, "same-partner", 1n, { sha256: "a".repeat(64), mimeType: "image/png", byteLength: 8 }, signal)
      : operation === "canonical" ? view.directory.resolve(key, "same-partner", signal) : view.directory.resolvePreparationProfile(key, "same-partner", signal);
    await expect(read).rejects.toThrow("no longer authorized");
    expect(view.partnerReads).not.toHaveBeenCalled(); expect(view.avatarReads).not.toHaveBeenCalled();
    expect(view.directory.getSources()[0]).toMatchObject({ status: "accessDenied", rows: [] });
    expect(localStorage.getItem("joko.partner-source.v1." + key)).toBeNull(); view.directory.dispose();
  });
  it("does not dispatch an avatar read when its fresh snapshot fails or its source retires while reading", async () => {
    const view = fixture(); view.images.add(first.id); view.directory.sync([first]); await view.directory.refreshAll();
    const read = () => view.directory.readAvatar(partnerSourceKey(first), "same-partner", 1n, { sha256: "a".repeat(64), mimeType: "image/png", byteLength: 8 }, new AbortController().signal);
    view.failedSnapshots.add(first.id); await expect(read()).rejects.toThrow("snapshot failed");
    view.failedSnapshots.delete(first.id);
    const late = deferred(); view.pendingSnapshots.set(first.id, late.promise);
    const pending = read(), rejected = expect(pending).rejects.toThrow();
    await settle(); view.directory.setForeground(false); late.resolve(); await rejected;
    expect(view.avatarReads).not.toHaveBeenCalled(); expect(view.directory.getSources()[0]?.status).toBe("offline"); view.directory.dispose();
  });
});

describe("fresh Partner canonical navigation", () => {
  it.each(["duplicate", "unavailable", "zeroVersion", "futureVersion", "wrongHome", "wrongBackend", "remoteHome", "closed", "differentPartner", "missingBackend"])("fails closed for %s instead of producing an ordinary task", change => {
    const partner = profile(first), snapshot = ownerSnapshot(first), links = [link(first)];
    if (change === "duplicate") links.push(link(first));
    if (change === "unavailable") links[0] = { ...links[0]!, available: false };
    if (change === "zeroVersion") links[0] = { ...links[0]!, profileVersion: 0n };
    if (change === "futureVersion") links[0] = { ...links[0]!, profileVersion: 2n };
    if (change === "differentPartner") links[0] = { ...links[0]!, partnerId: "other" };
    const altered = change === "wrongHome" ? { ...snapshot, sessions: snapshot.sessions.map(session => ({ ...session, targetId: "wrong" })) }
      : change === "wrongBackend" ? { ...snapshot, targets: snapshot.targets.map(target => ({ ...target, backendId: "other" })) }
      : change === "remoteHome" ? { ...snapshot, targets: snapshot.targets.map(target => ({ ...target, remoteWorkspace: { kind: "ssh" as const, hostId: "h", hostTargetId: "t", workspaceRoot: "/home" } })) }
      : change === "closed" ? { ...snapshot, sessions: snapshot.sessions.map(session => ({ ...session, state: "closed" as const })) }
      : change === "missingBackend" ? { ...snapshot, backends: [] } : snapshot;
    expect(() => validatePartnerSourceSession(partner.id, partner, links, altered)).toThrow("canonical task or home changed");
  });
});

function fixture() {
  const order: string[] = [], names = new Map<string, string>(), failedReads = new Set<string>(), revoked = new Set<string>(), identityMismatch = new Set<string>(), large = new Set<string>(), images = new Set<string>(), pendingReads = new Map<string, Promise<void>>();
  const revokedOwners = new Set<string>(), failedSnapshots = new Set<string>(), pendingSnapshots = new Map<string, Promise<void>>(), ownerReads: string[] = [];
  const connections: { profileId: string; options: unknown }[] = [], partnerReads = vi.fn(), avatarReads = vi.fn();
  const readAuthKey = vi.fn(async (profile: ConnectionProfile) => { order.push("secret:" + profile.serverId); return "private-auth-key"; });
  const directory = new PartnerSourceDirectory({ storage: localStorage, publish: vi.fn(), readAuthKey,
    probe: async origin => { const owner = origin === first.origin ? first : second; order.push("probe:" + owner.serverId); return { serverId: identityMismatch.has(owner.id) ? "changed" : owner.serverId }; },
    createGateway: (owner, _secret, callbacks: GatewayCallbacks) => {
      const snapshot = ownerSnapshot(owner);
      const partner = () => ({ ...profile(owner), displayName: names.get(owner.id) ?? "Partner on " + owner.name,
        ...(images.has(owner.id) ? { avatar: { sha256: "a".repeat(64), mimeType: "image/png" as const, byteLength: 8 } } : {}) });
      return { connect: async (options: unknown) => { connections.push({ profileId: owner.id, options }); if (revoked.has(owner.id)) { await callbacks.onAuthenticationInvalidated?.(new Error("revoked") as never); throw new Error("revoked"); } callbacks.onSnapshot?.(snapshot); },
        disconnect: vi.fn(), refresh: async () => { ownerReads.push(owner.id); await pendingSnapshots.get(owner.id); if (failedSnapshots.has(owner.id)) throw new Error("snapshot failed"); callbacks.onSnapshot?.({ ...snapshot, devices: snapshot.devices.map(device => ({ ...device, revoked: revokedOwners.has(owner.id) })) }); },
        getPartner: async () => { partnerReads(owner.id); return partner(); }, listPartnerSessions: async () => [link(owner)],
        readPartnerAvatar: async () => { avatarReads(owner.id); return "data:" + owner.serverId; },
        listPartners: async () => { await pendingReads.get(owner.id); if (failedReads.has(owner.id)) throw new Error("read failed");
          return { partners: large.has(owner.id) ? Array.from({ length: 201 }, (_, index) => ({ ...partner(), id: "partner-" + index })) : [partner()], directory: {} }; }
      } as unknown as OrchestratorGateway;
    } });
  return { directory, order, readAuthKey, names, failedReads, revoked, identityMismatch, large, images, pendingReads, connections, ownerReads, revokedOwners, failedSnapshots, pendingSnapshots, partnerReads, avatarReads };
}
function profile(owner: ConnectionProfile): PartnerProfileView { return { id: "same-partner", revision: 1n, profileVersion: 1n, displayName: "Partner", description: "", avatar: "orbit", identitySource: "private identity", templateId: "general", lifecycle: "active", initializationState: "ready", invitationStage: "ready", homeTargetId: "home-" + owner.serverId, canonicalSessionId: "session-" + owner.serverId,
  capabilities: { permissionMode: "ask", planMode: false, modelChain: [] }, usesDirectoryDefaults: true, createdAt: 1, updatedAt: 1,
  activity: { partnerId: "same-partner", unreadReplyCount: 0, artifactCount: 0, activeDelegationCount: 0, readThroughCursor: 0n, readUpdatedAt: 1 } }; }
function link(owner: ConnectionProfile): PartnerSessionView { return { partnerId: "same-partner", sessionId: "session-" + owner.serverId, role: "canonical", profileVersion: 1n, available: true, readOnly: false, archived: false, deleted: false, createdAt: 1, displayName: "Task" }; }
function ownerSnapshot(owner: ConnectionProfile): AppSnapshot { return { ...emptySnapshot(), generation: 1n,
  remoteConnections: [{ id: owner.id, deviceId: owner.deviceId, name: owner.name, state: "connected" }],
  devices: [{ id: owner.deviceId, name: "Device", defaultDisplayName: "Device", revision: 1n, kind: "web", platform: "web", appVersion: "1", revoked: false, remoteControlEnabled: false, presence: "online" }],
  backends: [{ id: "backend", name: "Backend", version: "1", health: "healthy", capabilities: new Map() }],
  targets: [{ id: "home-" + owner.serverId, revision: 1n, backendId: "backend", name: "Home", workspaceId: "workspace", workspaceName: "Home", trusted: true, archived: false, pinned: false }],
  sessions: [{ id: "session-" + owner.serverId, targetId: "home-" + owner.serverId, backendId: "backend", name: "Task", state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, planMode: false, permissionMode: "ask", updatedAt: 1 }] }; }
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve }; }
async function settle() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }
