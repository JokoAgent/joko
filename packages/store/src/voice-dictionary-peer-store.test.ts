import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { VoiceDictionaryPeerStore, type VoiceDictionaryPeerIdentity } from "./voice-dictionary-peer-store.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("dictionary peer durable authority", () => {
  it("atomically persists explicit listener and pinned routes, fences route CAS and keeps grant lifetime through route changes and restart", () => {
    const fixture = database();
    let store = fixture.open();
    const identity = store.initializeIdentity(storedIdentity());
    const listener = { listenPort: 57480, host: "dictionary.example.test", port: 44380 };
    store.configureListener(store.configurationRevision(), listener);
    const peer = peerInput("direct-peer");
    const route = { host: "2001:db8::1", port: 57481 };
    let publication: unknown;
    store.subscribe(() => {
      const reader = fixture.open();
      publication = { revision: reader.configurationRevision(), peer: reader.peer(peer.peerId), listener: reader.listener() };
      reader.close();
    });
    const before = store.configurationRevision();
    const granted = store.grantDirectPeer({ ...peer, route, expectedRevision: before });
    expect(granted).toMatchObject({ route, revision: before + 1n });
    expect(publication).toEqual({ revision: before + 1n, peer: granted, listener });
    store.recordSuccess(peer.peerId, granted.revision, 2_000);
    expect(() => store.grantDirectPeer({ ...peer, route: { ...route, port: 57482 }, expectedRevision: before })).toThrow(/concurrently/iu);
    expect(() => store.grantDirectPeer({ ...peerInput(peer.peerId), route, expectedRevision: store.configurationRevision() })).toThrow(/concurrently/iu);
    for (const host of ["http://host", " host", "host/path", "host@other", "127.1", "2130706433", "host..test", "fe80::1%eth0"]) {
      expect(() => store.grantDirectPeer({ ...peer, route: { host, port: 57482 }, expectedRevision: store.configurationRevision() })).toThrow(/invalid/iu);
    }
    const stable = store.configurationRevision();
    store.configureListener(stable, listener);
    store.grantDirectPeer({ ...peer, route, expectedRevision: stable });
    expect(store.configurationRevision()).toBe(stable);
    const changed = store.grantDirectPeer({ ...peer, route: { host: "192.168.1.2", port: 57482 }, expectedRevision: stable });
    expect(changed).toMatchObject({ revision: granted.revision, lastSyncAt: 2_000 });
    expect(store.configurationRevision()).toBe(stable + 1n);
    const configuration = store.configurationRevision();
    store.close(); store = fixture.open();
    expect(store.identity()).toEqual(identity);
    expect(store.listener()).toEqual(listener);
    expect(store.peer(peer.peerId)).toEqual(changed);
    expect(() => store.configureListener(configuration - 1n, undefined)).toThrow(/concurrently/iu);
    store.clearPeerRoute(configuration, peer.peerId);
    expect(store.peer(peer.peerId)).toMatchObject({ revision: granted.revision, lastSyncAt: 2_000 });
    expect(store.peer(peer.peerId)?.route).toBeUndefined();
    store.grantDirectPeer({ ...peer, route, expectedRevision: store.configurationRevision() });
    store.revokePeer(peer.peerId, granted.revision);
    expect(store.peer(peer.peerId)).toBeUndefined();
    store.configureListener(store.configurationRevision(), undefined);
    expect(store.listener()).toBeUndefined();
  });

  it("publishes grants only after the real SQLite commit and preserves identity, grant lifetime and success across reopen", () => {
    const fixture = database();
    const identity = storedIdentity();
    let store = fixture.open();
    store.initializeIdentity(identity);
    const peer = peerInput("peer-one");
    let observed = 0;
    store.subscribe(() => {
      const reader = new DatabaseSync(fixture.path, { readOnly: true });
      try { observed = (reader.prepare("SELECT count(*) AS count FROM dictionary_peer_grants").get() as { count: number }).count; }
      finally { reader.close(); }
    });
    const granted = store.grantPeer({ ...peer, expectedRevision: store.configurationRevision() });
    expect(observed).toBe(1);
    const authority = store.configurationRevision();
    expect(store.recordSuccess(peer.peerId, granted.revision, 2_000)).toBe(true);
    expect(store.configurationRevision()).toBe(authority);
    expect(store.peer(peer.peerId)?.revision).toBe(granted.revision);
    store.close();
    store = fixture.open();
    expect(store.identity()).toEqual(identity);
    expect(store.peers()).toEqual([{ ...granted, lastSyncAt: 2_000 }]);
    expect(store.configurationRevision()).toBe(authority);
    expect(() => store.initializeIdentity(storedIdentity())).toThrow(/concurrently/iu);
  });

  it("rejects stale grants, silent key replacement and late success or revoke from an earlier grant lifetime", () => {
    const store = database().open();
    store.initializeIdentity(storedIdentity());
    const peer = peerInput("peer-one");
    const revision = store.configurationRevision();
    const first = store.grantPeer({ ...peer, expectedRevision: revision });
    expect(() => store.grantPeer({ ...peerInput("peer-two"), expectedRevision: revision })).toThrow(/concurrently/iu);
    expect(() => store.grantPeer({ ...peerInput(peer.peerId), expectedRevision: store.configurationRevision() })).toThrow(/concurrently/iu);
    store.revokePeer(peer.peerId, first.revision);
    expect(store.recordSuccess(peer.peerId, first.revision, 2_000)).toBe(false);
    const second = store.grantPeer({ ...peerInput(peer.peerId), expectedRevision: store.configurationRevision() });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(store.recordSuccess(peer.peerId, first.revision, 3_000)).toBe(false);
    expect(() => store.revokePeer(peer.peerId, first.revision)).toThrow(/concurrently/iu);
    expect(store.peer(peer.peerId)).toEqual(second);
  });

  it("keeps invalid, self, unpinned and over-capacity inputs out of the committed authority", () => {
    const store = database().open();
    const identity = storedIdentity();
    store.initializeIdentity(identity);
    const peer = peerInput("peer-one");
    const revision = store.configurationRevision();
    for (const input of [{ ...peer, fingerprint: "0".repeat(64) }, { ...peer, displayName: " bad " },
      { ...peer, peerId: identity.nodeId }, { ...peer, publicKey: identity.publicKey, fingerprint: keyFingerprint(identity.publicKey) }]) {
      expect(() => store.grantPeer({ ...input, expectedRevision: revision })).toThrow(/invalid/iu);
    }
    expect(store.configurationRevision()).toBe(revision);
    expect(store.peers()).toEqual([]);
    for (let index = 0; index < 128; index += 1) store.grantPeer({ ...peerInput(`peer-${index}`), expectedRevision: store.configurationRevision() });
    const full = store.configurationRevision();
    expect(() => store.grantPeer({ ...peerInput("peer-over"), expectedRevision: full })).toThrow(/invalid/iu);
    expect(store.configurationRevision()).toBe(full);
    expect(store.peers()).toHaveLength(128);
  });

  it.each(["baseline", "catalog", "sealed-shape", "self-grant"] as const)("refuses a changed %s on startup without repairing or overwriting it", (corruption) => {
    const fixture = database();
    const store = fixture.open();
    const identity = store.initializeIdentity(storedIdentity());
    const peer = store.grantPeer({ ...peerInput("peer-one"), expectedRevision: store.configurationRevision() });
    store.close();
    const writer = new DatabaseSync(fixture.path);
    if (corruption === "baseline") writer.prepare("UPDATE dictionary_peer_schema SET baseline_id = ?").run("0".repeat(64));
    if (corruption === "catalog") writer.exec("CREATE TABLE unowned_payload(value TEXT) STRICT;");
    if (corruption === "sealed-shape") writer.prepare("UPDATE dictionary_peer_identity SET sealed_key_json = ?")
      .run(JSON.stringify({ ...identity.sealedKey, extra: true }));
    if (corruption === "self-grant") writer.prepare("UPDATE dictionary_peer_grants SET peer_id = ? WHERE peer_id = ?").run(identity.nodeId, peer.peerId);
    const before = writer.prepare("SELECT * FROM dictionary_peer_identity").all();
    writer.close();
    expect(() => fixture.open()).toThrow(/current valid v1 baseline/iu);
    const reader = new DatabaseSync(fixture.path, { readOnly: true });
    expect(reader.prepare("SELECT * FROM dictionary_peer_identity").all()).toEqual(before);
    reader.close();
  });

  it("does not reinterpret an empty database carrying another schema version", () => {
    const fixture = database();
    const writer = new DatabaseSync(fixture.path);
    writer.exec("PRAGMA user_version = 9;");
    writer.close();
    expect(() => fixture.open()).toThrow(/v1 baseline/iu);
    const reader = new DatabaseSync(fixture.path);
    expect(reader.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 9 });
    expect(reader.prepare("SELECT * FROM sqlite_schema").all()).toEqual([]);
    reader.close();
  });
});

function storedIdentity(): VoiceDictionaryPeerIdentity {
  return { nodeId: "node-self", publicKey: publicKey(), sealedKey: { algorithm: "aes-256-gcm",
    nonce: Buffer.alloc(12, 1).toString("base64"), tag: Buffer.alloc(16, 2).toString("base64"), ciphertext: Buffer.alloc(48, 3).toString("base64") } };
}
function peerInput(peerId: string) {
  const key = publicKey();
  return { peerId, displayName: "Peer computer", publicKey: key, fingerprint: keyFingerprint(key) };
}
function publicKey(): string { return generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).toString("base64"); }
function keyFingerprint(key: string): string { return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex"); }
function database() {
  const directory = mkdtempSync(join(tmpdir(), "joko-dictionary-peers-"));
  const instances: VoiceDictionaryPeerStore[] = [];
  cleanups.push(() => { for (const instance of instances) instance.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, "peers.db");
  return { path, open: () => { const instance = new VoiceDictionaryPeerStore(path, { now: () => 1_000 }); instances.push(instance); return instance; } };
}
