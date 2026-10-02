import { createHash, randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNodeSyncIdentity, NodeSyncLanTransport, type NodeSyncLanTransportOptions } from "@joko/node-sync";
import { OperationalStore, VoiceDictionaryPeerStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialVault } from "./credential-vault.js";
import { VoiceDictionaryPeerManager } from "./voice-dictionary-peer-manager.js";
import { VoiceDictionarySyncRepository } from "./voice-dictionary-sync-repository.js";
import {
  decodeVoiceDictionaryPeerMessage,
  encodeVoiceDictionaryPeerMessage,
  type VoiceDictionaryPeerCodec,
  type VoiceDictionaryPeerMessage
} from "./voice-dictionary-sync-wire.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const inProcessCodec: VoiceDictionaryPeerCodec = {
  encode: async (options) => encodeVoiceDictionaryPeerMessage(options),
  decode: async (options) => decodeVoiceDictionaryPeerMessage(options)
};

describe("Voice dictionary peer authority and exchange", () => {
  it("pins a public invitation and its route atomically, rejects mismatched fingerprints and retires a pending direct probe on client cancellation", async () => {
    const fixture = await localFixture("direct-authority");
    const peer = generateNodeSyncIdentity();
    const probed = deferred<void>();
    const result = deferred<boolean>();
    const send = vi.fn(async () => true);
    let probeDelivery: { readonly signal: AbortSignal; readonly isCurrent: () => boolean } | undefined;
    const manager = new VoiceDictionaryPeerManager({ ...fixture.options, codec: inProcessCodec,
      transportFactory: () => ({ ...emptyTransport(), listenerPort: () => fixture.peers.listener()?.listenPort,
        eligiblePeerIds: () => fixture.peers.peers().map((value) => value.peerId),
        probe: async (_peerId, delivery) => { probeDelivery = delivery; probed.resolve(); return result.promise; }, send }) });
    cleanups.push(() => manager.close());
    await manager.initialize();
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
    const listener = { listenPort: 57500, host: "dictionary.example.test", port: 44380 };
    manager.configureListener(manager.status().configurationRevision, listener);
    const exported = JSON.parse(await manager.invitation());
    expect(exported).toEqual({ version: 1, nodeId: fixture.options.nodeId, displayName: fixture.options.displayName,
      publicKey: fixture.peers.identity()!.publicKey, fingerprint: manager.status().fingerprint, host: listener.host, port: listener.port });
    const invitation = JSON.stringify({ ...exported, nodeId: "node-direct", displayName: "Direct peer",
      publicKey: peer.publicKey, fingerprint: keyFingerprint(peer.publicKey), host: "2001:db8::1", port: 57501 });
    const revision = manager.status().configurationRevision;
    expect(() => manager.grantDirectPeer(revision, invitation, "0".repeat(64))).toThrow(/invalid/u);
    expect(() => manager.grantDirectPeer(revision, JSON.stringify({ ...JSON.parse(invitation), extra: true }), keyFingerprint(peer.publicKey))).toThrow(/invalid/u);
    expect(fixture.peers.peers()).toEqual([]);
    const status = manager.grantDirectPeer(revision, invitation, keyFingerprint(peer.publicKey));
    expect(status.peers[0]).toMatchObject({ route: { host: "2001:db8::1", port: 57501 }, online: false });
    await manager.invitation();
    const abort = new AbortController();
    const syncing = manager.syncNow("node-direct", { signal: abort.signal, isCurrent: () => !abort.signal.aborted });
    const rejected = expect(syncing).rejects.toThrow(/unavailable/u);
    await probed.promise;
    abort.abort(); result.resolve(true); await rejected;
    expect(probeDelivery?.signal.aborted).toBe(true);
    expect(probeDelivery?.isCurrent()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(fixture.peers.peer("node-direct")?.lastSyncAt).toBeUndefined();
    expect(manager.status().errorCode).toBeUndefined();
    await manager.syncNow("node-direct");
    expect(send).toHaveBeenCalled();
    expect(fixture.peers.peer("node-direct")?.lastSyncAt).toBeDefined();
    const grantRevision = fixture.peers.peer("node-direct")!.revision;
    manager.clearPeerRoute(manager.status().configurationRevision, "node-direct");
    expect(fixture.peers.peer("node-direct")?.revision).toBe(grantRevision);
    expect(fixture.peers.peer("node-direct")?.route).toBeUndefined();
  });

  it("retires a cancelled foreground ACK while preserving a coalesced independent exchange and its real failure", async () => {
    const fixture = await localFixture("foreground-exchange");
    const peer = generateNodeSyncIdentity();
    const sent = deferred<void>();
    const ack = deferred<boolean>();
    let online = false;
    let attempts = 0;
    const manager = new VoiceDictionaryPeerManager({ ...fixture.options, codec: inProcessCodec,
      transportFactory: () => ({ ...emptyTransport(), onlinePeerIds: () => online ? ["node-remote"] : [],
        send: async () => { attempts += 1; if (attempts === 1) { sent.resolve(); return ack.promise; } return false; } }) });
    cleanups.push(() => manager.close());
    await manager.initialize();
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
    fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-remote",
      displayName: "Remote", publicKey: peer.publicKey, fingerprint: keyFingerprint(peer.publicKey) });
    online = true;
    const abort = new AbortController();
    const foreground = manager.syncNow("node-remote", { signal: abort.signal, isCurrent: () => !abort.signal.aborted });
    const foregroundRejected = expect(foreground).rejects.toThrow(/unavailable/u);
    await sent.promise;
    const background = manager.syncNow("node-remote");
    const backgroundRejected = expect(background).rejects.toThrow(/reachable/u);
    await Promise.resolve();
    abort.abort(); ack.resolve(true);
    await foregroundRejected; await backgroundRejected;
    expect(attempts).toBe(2);
    expect(fixture.peers.peer("node-remote")?.lastSyncAt).toBeUndefined();
    expect(manager.status().errorCode).toBe("sync_failed");
  });

  it("notifies projection subscribers after durable changes and retires them before its private store closes", async () => {
    const fixture = await localFixture("projection");
    const manager = new VoiceDictionaryPeerManager(fixture.options);
    cleanups.push(() => manager.close());
    await manager.initialize();
    const observed: Array<number | "closed"> = [];
    manager.subscribe(() => {
      try { manager.status(); observed.push(fixture.dictionary.snapshot().revision); }
      catch { observed.push("closed"); }
    });
    fixture.dictionary.addManualTerm(fixture.dictionary.snapshot().revision, "Durable projection");
    expect(observed).toEqual([fixture.dictionary.snapshot().revision]);
    manager.close(); manager.close();
    expect(observed.at(-1)).toBe("closed");
    expect(() => manager.status()).toThrow(/unavailable/u);
    expect(() => manager.subscribe(() => undefined)).toThrow(/unavailable/u);
  });

  it("coalesces concurrent durable exchanges when LAN and direct routes coexist and retains LAN sharing after clearing direct routes", { timeout: 25_000 }, async () => {
    const first = await localFixture("coexisting-first");
    const second = await localFixture("coexisting-second");
    const [firstPort, secondPort] = await temporaryListenerPorts();
    const encoding = new Map<string, { active: number; maximum: number; calls: number }>();
    const release = deferred<void>();
    let holdNextFirstEncode = false;
    let firstEncodeHeld = false;
    const codec: VoiceDictionaryPeerCodec = { ...inProcessCodec, encode: async (options) => {
      const key = `${options.sourceNodeId}->${options.destinationNodeId}`;
      const count = encoding.get(key) ?? { active: 0, maximum: 0, calls: 0 };
      encoding.set(key, count);
      count.active += 1; count.calls += 1;
      count.maximum = Math.max(count.maximum, count.active);
      try {
        if (holdNextFirstEncode && options.sourceNodeId === first.options.nodeId) {
          holdNextFirstEncode = false;
          firstEncodeHeld = true;
          await release.promise;
        }
        return encodeVoiceDictionaryPeerMessage(options);
      } finally { count.active -= 1; }
    } };
    const firstManager = new VoiceDictionaryPeerManager({ ...first.options, codec, enableLan: true, debounceMilliseconds: 30 });
    const secondManager = new VoiceDictionaryPeerManager({ ...second.options, codec, enableLan: true, debounceMilliseconds: 30 });
    cleanups.push(() => firstManager.close(), () => secondManager.close(), () => release.resolve());
    await firstManager.initialize();
    await secondManager.initialize();
    firstManager.configureListener(firstManager.status().configurationRevision, { listenPort: firstPort, host: "127.0.0.1", port: firstPort });
    secondManager.configureListener(secondManager.status().configurationRevision, { listenPort: secondPort, host: "127.0.0.1", port: secondPort });
    first.dictionary.addManualTerm(first.dictionary.snapshot().revision, "Initial shared state");
    await firstManager.setEnabled(first.dictionary.snapshot().revision, true);
    await secondManager.setEnabled(second.dictionary.snapshot().revision, true);
    // Neither owner has an explicit peer route yet, so these candidates come from real default LAN discovery.
    await waitUntil(() => firstManager.status().candidates.some((value) => value.nodeId === second.options.nodeId) &&
      secondManager.status().candidates.some((value) => value.nodeId === first.options.nodeId), 7_000);
    const firstInvitation = await firstManager.invitation();
    const secondInvitation = await secondManager.invitation();
    firstManager.grantDirectPeer(firstManager.status().configurationRevision, secondInvitation, secondManager.status().fingerprint);
    secondManager.grantDirectPeer(secondManager.status().configurationRevision, firstInvitation, firstManager.status().fingerprint);
    await firstManager.invitation();
    await secondManager.invitation();
    expect(firstManager.status().peers[0]?.route).toEqual({ host: "127.0.0.1", port: secondPort });
    expect(secondManager.status().peers[0]?.route).toEqual({ host: "127.0.0.1", port: firstPort });
    await waitUntil(() => second.dictionary.snapshot().dictionary.entries.some((value) => value.text === "Initial shared state"));
    first.dictionary.learn(first.dictionary.snapshot().revision, { text: "Learned across routes", aliases: ["spoken across routes"], stage: "entry" });
    await waitUntil(() => second.dictionary.readOnlySnapshot().entries.some((value) => value.text === "Learned across routes") &&
      firstManager.status().phase !== "syncing" && secondManager.status().phase !== "syncing");

    holdNextFirstEncode = true;
    const firstSync = firstManager.syncNow(second.options.nodeId);
    await waitUntil(() => firstEncodeHeld);
    const coalescedSync = firstManager.syncNow(second.options.nodeId);
    first.dictionary.learn(first.dictionary.snapshot().revision, { text: "Learned across routes", aliases: ["spoken across routes"], stage: "entry" });
    second.dictionary.addManualTerm(second.dictionary.snapshot().revision, "Concurrent shared state");
    const reverseSync = secondManager.syncNow(first.options.nodeId);
    const overlapping = Promise.allSettled([firstSync, coalescedSync, reverseSync]);
    await waitUntil(() => first.dictionary.snapshot().dictionary.entries.some((value) => value.text === "Concurrent shared state"));
    expect(encoding.get(`${first.options.nodeId}->${second.options.nodeId}`)?.active).toBe(1);
    release.resolve();
    expect((await overlapping).map((value) => value.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    await waitUntil(() => JSON.stringify(first.dictionary.stateForSync()) === JSON.stringify(second.dictionary.stateForSync()) &&
      firstManager.status().phase !== "syncing" && secondManager.status().phase !== "syncing");
    expect(first.dictionary.readOnlySnapshot().entries).toContainEqual({ text: "Learned across routes", frequency: 2,
      aliases: [{ text: "spoken across routes", count: 2 }] });
    expect(first.dictionary.stateForSync()).toEqual(second.dictionary.stateForSync());
    expect(first.dictionary.readOnlySnapshot().stateVector).toEqual(second.dictionary.readOnlySnapshot().stateVector);
    const stable = [first.dictionary.readOnlySnapshot(), second.dictionary.readOnlySnapshot()];
    await Promise.all([firstManager.syncNow(second.options.nodeId), secondManager.syncNow(first.options.nodeId)]);
    await waitUntil(() => firstManager.status().phase !== "syncing" && secondManager.status().phase !== "syncing");
    expect([first.dictionary.readOnlySnapshot(), second.dictionary.readOnlySnapshot()]).toEqual(stable);
    expect([...encoding.values()]).toHaveLength(2);
    for (const count of encoding.values()) {
      expect(count.calls).toBeGreaterThan(1);
      expect(count.maximum).toBe(1);
    }

    const authority = (manager: VoiceDictionaryPeerManager) => manager.status().peers.map(({ peerId, revision, fingerprint, grantedAt }) =>
      ({ peerId, revision, fingerprint, grantedAt }));
    const grants = [authority(firstManager), authority(secondManager)];
    firstManager.clearPeerRoute(firstManager.status().configurationRevision, second.options.nodeId);
    secondManager.clearPeerRoute(secondManager.status().configurationRevision, first.options.nodeId);
    await firstManager.invitation();
    await secondManager.invitation();
    expect([authority(firstManager), authority(secondManager)]).toEqual(grants);
    expect(firstManager.status().peers[0]?.route).toBeUndefined();
    expect(secondManager.status().peers[0]?.route).toBeUndefined();
    await waitUntil(() => firstManager.status().peers[0]?.online === true && secondManager.status().peers[0]?.online === true, 7_000);
    first.dictionary.learn(first.dictionary.snapshot().revision, { text: "Learned across routes", aliases: ["spoken across routes"], stage: "entry" });
    second.dictionary.addManualTerm(second.dictionary.snapshot().revision, "LAN remains available");
    await waitUntil(() => first.dictionary.snapshot().dictionary.entries.some((value) => value.text === "LAN remains available") &&
      second.dictionary.readOnlySnapshot().entries.some((value) => value.text === "Learned across routes" && value.frequency === 3));
    expect(first.dictionary.stateForSync()).toEqual(second.dictionary.stateForSync());
    expect(first.dictionary.readOnlySnapshot().entries).toContainEqual({ text: "Learned across routes", frequency: 3,
      aliases: [{ text: "spoken across routes", count: 3 }] });
    await waitUntil(() => firstManager.status().phase !== "syncing" && secondManager.status().phase !== "syncing");
    const lanStable = [first.dictionary.readOnlySnapshot(), second.dictionary.readOnlySnapshot()];
    await Promise.all([firstManager.syncNow(second.options.nodeId), secondManager.syncNow(first.options.nodeId)]);
    await waitUntil(() => firstManager.status().phase !== "syncing" && secondManager.status().phase !== "syncing");
    expect([first.dictionary.readOnlySnapshot(), second.dictionary.readOnlySnapshot()]).toEqual(lanStable);
    expect([authority(firstManager), authority(secondManager)]).toEqual(grants);
    for (const count of encoding.values()) expect(count.maximum).toBe(1);
  });

  it("converges full state through two durable LAN owners, forces reconnect replies, and retains identity across restart", { timeout: 25_000 }, async () => {
    const port = randomInt(54_000, 60_000);
    const first = await lanFixture("first", port);
    const second = await lanFixture("second", port);
    first.dictionary.addManualTerm(first.dictionary.snapshot().revision, "Initial superset");
    await first.manager.setEnabled(first.dictionary.snapshot().revision, true);
    await second.manager.setEnabled(second.dictionary.snapshot().revision, true);
    await waitUntil(() => candidate(first, second) !== undefined && candidate(second, first) !== undefined);
    expect(second.dictionary.snapshot().dictionary.entries).toEqual([]);
    grant(first, second);
    grant(second, first);
    await waitUntil(() => hasTerm(second, "Initial superset"));

    first.dictionary.learn(first.dictionary.snapshot().revision, { text: "Shared candidate", aliases: ["shared spoken"], stage: "candidate" });
    second.dictionary.addManualTerm(second.dictionary.snapshot().revision, "Concurrent manual");
    await waitUntil(() => hasTerm(first, "Concurrent manual") && second.dictionary.snapshot().dictionary.candidates[0]?.evidenceCount === 1);
    expect(first.dictionary.stateForSync()).toEqual(second.dictionary.stateForSync());
    const entry = second.dictionary.snapshot().dictionary.entries.find((value) => value.text === "Initial superset")!;
    second.dictionary.deleteEntry(second.dictionary.snapshot().revision, entry.id);
    await waitUntil(() => !hasTerm(first, "Initial superset"));
    let quietSince = Date.now();
    let previousSends = first.sends + second.sends;
    await waitUntil(() => {
      const sends = first.sends + second.sends;
      if (sends !== previousSends || first.manager.status().phase === "syncing" || second.manager.status().phase === "syncing") quietSince = Date.now();
      previousSends = sends;
      return Date.now() - quietSince >= 200;
    });
    const stableRevision = first.dictionary.snapshot().revision;
    const stableSends = first.sends + second.sends;
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(first.dictionary.snapshot().revision).toBe(stableRevision);
    expect(first.sends + second.sends).toBe(stableSends);

    const fingerprint = second.manager.status().fingerprint;
    const grantRevision = second.manager.status().peers[0]!.revision;
    second.manager.close();
    // A failed attempt against the old route must not suppress a restarted route for a minute.
    first.dictionary.addManualTerm(first.dictionary.snapshot().revision, "First while offline");
    await expect(first.manager.syncNow(second.nodeId)).rejects.toThrow();
    second.dictionary.addManualTerm(second.dictionary.snapshot().revision, "Second while offline");
    await second.restart();
    expect(second.manager.status().fingerprint).toBe(fingerprint);
    expect(second.manager.status().peers[0]!.revision).toBe(grantRevision);
    await waitUntil(() => hasTerm(first, "Second while offline") && hasTerm(second, "First while offline"));
    expect(first.dictionary.stateForSync()).toEqual(second.dictionary.stateForSync());
    expect(first.dictionary.snapshot().dictionary.candidates[0]?.evidenceCount).toBe(1);

    await second.manager.setEnabled(second.dictionary.snapshot().revision, false);
    first.dictionary.addManualTerm(first.dictionary.snapshot().revision, "Retained on first");
    second.dictionary.addManualTerm(second.dictionary.snapshot().revision, "Retained on second");
    const disabled = second.dictionary.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(second.dictionary.snapshot()).toEqual(disabled);
    await second.manager.setEnabled(second.dictionary.snapshot().revision, true);
    await waitUntil(() => hasTerm(first, "Retained on second") && hasTerm(second, "Retained on first")).catch((cause: unknown) => {
      throw new Error(JSON.stringify({ first: first.manager.status(), second: second.manager.status(),
        firstTerms: first.dictionary.snapshot().dictionary, secondTerms: second.dictionary.snapshot().dictionary,
        firstSends: first.sends, secondSends: second.sends }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value), { cause });
    });

    const peer = first.manager.status().peers[0]!;
    first.manager.revokePeer(peer.peerId, peer.revision);
    second.dictionary.addManualTerm(second.dictionary.snapshot().revision, "After revoke");
    await expect(second.manager.syncNow(first.nodeId)).rejects.toThrow();
    expect(hasTerm(first, "After revoke")).toBe(false);
    expect(first.manager.status().peers).toEqual([]);
  });

  it.each(["revoke", "disable", "close"] as const)("rejects an already authenticated late decode after %s without committing or acknowledging success", async (action) => {
    const fixture = await localFixture(`late-${action}`);
    const source = generateNodeSyncIdentity();
    const remoteStore = new OperationalStore(":memory:");
    cleanups.push(() => remoteStore.close());
    const remote = new VoiceDictionarySyncRepository({ store: remoteStore, createReplicaId: () => "replica-remote" });
    // The temporary remote owner is needed only to produce a current-v1 full state.
    remote.addManualTerm(remote.snapshot().revision, "Late private term");
    const decoded = deferred<VoiceDictionaryPeerMessage>();
    const started = deferred<void>();
    let transportOptions: NodeSyncLanTransportOptions | undefined;
    const manager = new VoiceDictionaryPeerManager({ ...fixture.options,
      codec: { ...inProcessCodec, decode: async () => { started.resolve(); return decoded.promise; } },
      transportFactory: (options) => { transportOptions = options; return emptyTransport(); }
    });
    cleanups.push(() => manager.close());
    await manager.initialize();
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
    fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-remote",
      displayName: "Remote", publicKey: source.publicKey, fingerprint: keyFingerprint(source.publicKey) });
    await manager.syncNow();
    const identity = fixture.peers.identity()!;
    const frame = encodeVoiceDictionaryPeerMessage({ message: { frameVersion: 1, state: remote.stateForSync(), requestReply: true },
      ownPrivateKey: source.privateKey, ownPublicKey: source.publicKey, peerPublicKey: identity.publicKey,
      sourceNodeId: "node-remote", destinationNodeId: fixture.options.nodeId })[0]!;
    const delivered = Promise.resolve(transportOptions!.onFrame("node-remote", frame, { signal: new AbortController().signal, isCurrent: () => true }));
    const rejected = expect(delivered).rejects.toThrow();
    await started.promise;
    const before = fixture.dictionary.snapshot();
    if (action === "revoke") manager.revokePeer("node-remote", fixture.peers.peer("node-remote")!.revision);
    else if (action === "disable") fixture.dictionary.setEnabled(before.revision, false);
    else manager.close();
    const retired = fixture.dictionary.snapshot();
    decoded.resolve({ frameVersion: 1, state: remote.stateForSync(), requestReply: true });
    await rejected;
    expect(fixture.dictionary.snapshot()).toEqual(retired);
    expect(fixture.peers.peer("node-remote")?.lastSyncAt).toBeUndefined();
  });

  it("does not count a late outbound ACK after revocation and does not poison a fresh grant generation", async () => {
    const fixture = await localFixture("late-ack");
    const source = generateNodeSyncIdentity();
    const sent = deferred<void>();
    const ack = deferred<boolean>();
    let online = false;
    const manager = new VoiceDictionaryPeerManager({ ...fixture.options, codec: inProcessCodec,
      transportFactory: () => ({ ...emptyTransport(), onlinePeerIds: () => online ? ["node-remote"] : [],
        send: async () => { sent.resolve(); return ack.promise; } })
    });
    cleanups.push(() => manager.close());
    await manager.initialize();
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
    const peer = fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-remote",
      displayName: "Remote", publicKey: source.publicKey, fingerprint: keyFingerprint(source.publicKey) });
    online = true;
    const syncing = manager.syncNow("node-remote");
    const rejected = expect(syncing).rejects.toThrow();
    await sent.promise;
    online = false;
    manager.revokePeer(peer.peerId, peer.revision);
    const replacement = fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-remote",
      displayName: "Remote", publicKey: source.publicKey, fingerprint: keyFingerprint(source.publicKey) });
    ack.resolve(true);
    await rejected;
    expect(fixture.peers.peer(peer.peerId)).toMatchObject({ revision: replacement.revision });
    expect(fixture.peers.peer(peer.peerId)?.lastSyncAt).toBeUndefined();
    expect(manager.status().errorCode).toBeUndefined();
  });

  it.each(["purpose", "vault", "node", "public-key"] as const)("rejects a sealed identity with a changed %s without regeneration or sensitive diagnostics", async (change) => {
    const fixture = await localFixture(`identity-${change}`);
    const identity = generateNodeSyncIdentity();
    const nodeId = change === "node" ? "node-original" : fixture.options.nodeId;
    const purpose = change === "purpose" ? "contacts" : "voice-dictionary";
    const vault = change === "vault" ? await CredentialVault.open(join(fixture.directory, "other.key")) : fixture.options.vault;
    fixture.peers.initializeIdentity({ nodeId, publicKey: change === "public-key" ? generateNodeSyncIdentity().publicKey : identity.publicKey,
      sealedKey: vault.seal(identity.privateKey, `joko:${purpose}-device-sync:x25519-private-key:v1:${nodeId}`) });
    const before = fixture.peers.identity();
    const warn = vi.fn();
    const manager = new VoiceDictionaryPeerManager({ ...fixture.options, codec: inProcessCodec,
      logger: { debug: vi.fn(), warn } });
    cleanups.push(() => manager.close());
    await expect(manager.initialize()).rejects.toThrow("Dictionary peer authority is unavailable.");
    expect(manager.status()).toMatchObject({ available: false, enabled: false, errorCode: "identity_unavailable" });
    expect(fixture.peers.identity()).toEqual(before);
    expect(warn.mock.calls).toEqual([["Dictionary peer operation failed.", { code: "identity_unavailable" }]]);
    expect(fixture.store.listSettings("service", "orchestrator")).not.toContainEqual(expect.objectContaining({ value: expect.objectContaining({ sealedKey: expect.anything() }) }));
  });

  it("isolates a retired startup failure and lets an explicit retry clear the current transport failure", async () => {
    const fixture = await localFixture("startup");
    const late = deferred<void>();
    let rejectStart!: () => void;
    const starting = new Promise<void>((_resolve, reject) => { rejectStart = () => reject(new Error("Controlled late start failure.")); });
    let starts = 0;
    const manager = new VoiceDictionaryPeerManager({ ...fixture.options, codec: inProcessCodec,
      transportFactory: () => ({ ...emptyTransport(), start: async () => {
        starts += 1;
        if (starts === 1) { late.resolve(); return starting; }
        if (starts === 2) throw new Error("Controlled current start failure.");
      } })
    });
    cleanups.push(() => manager.close());
    await manager.initialize();
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
    await late.promise;
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, false);
    rejectStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.status()).toMatchObject({ enabled: false, phase: "off" });
    expect(manager.status().errorCode).toBeUndefined();
    fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
    await waitUntil(() => manager.status().errorCode === "sync_failed");
    await manager.syncNow();
    expect(manager.status()).toMatchObject({ enabled: true, phase: "waiting" });
    expect(manager.status().errorCode).toBeUndefined();
    expect(starts).toBe(3);
  });

  it("debounces local mutations, requests unchanged full state on fallback, and retires both timers when disabled", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await localFixture("timers");
      const source = generateNodeSyncIdentity();
      const messages: VoiceDictionaryPeerMessage[] = [];
      let online = false;
      const manager = new VoiceDictionaryPeerManager({ ...fixture.options, debounceMilliseconds: 8_000, fallbackMilliseconds: 30 * 60_000,
        codec: { ...inProcessCodec, encode: async (options) => { messages.push(options.message); return encodeVoiceDictionaryPeerMessage(options); } },
        transportFactory: () => ({ ...emptyTransport(), onlinePeerIds: () => online ? ["node-remote"] : [], send: async () => true })
      });
      cleanups.push(() => manager.close());
      await manager.initialize();
      await manager.setEnabled(fixture.dictionary.snapshot().revision, true);
      fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-remote",
        displayName: "Remote", publicKey: source.publicKey, fingerprint: keyFingerprint(source.publicKey) });
      await manager.syncNow();
      online = true;
      fixture.dictionary.addManualTerm(fixture.dictionary.snapshot().revision, "First change");
      await vi.advanceTimersByTimeAsync(4_000);
      fixture.dictionary.addManualTerm(fixture.dictionary.snapshot().revision, "Last change");
      await vi.advanceTimersByTimeAsync(7_999);
      expect(messages).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.requestReply).toBeUndefined();
      await vi.advanceTimersByTimeAsync(30 * 60_000 - 12_000);
      expect(messages).toHaveLength(2);
      expect(messages[1]!.requestReply).toBe(true);
      expect(messages[1]!.state).toEqual(messages[0]!.state);
      await manager.setEnabled(fixture.dictionary.snapshot().revision, false);
      fixture.dictionary.addManualTerm(fixture.dictionary.snapshot().revision, "Disabled local change");
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(messages).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it.each((["explicit", "fallback"] as const).flatMap((trigger) =>
    (["complete", "revoke", "disable", "close"] as const).map((retirement) => ({ trigger, retirement }))
  ))("attempts every peer after an earlier failure on $trigger and fences $retirement", async ({ trigger, retirement }) => {
    vi.useFakeTimers();
    try {
      const fixture = await localFixture(`fanout-${trigger}-${retirement}`);
      const failedIdentity = generateNodeSyncIdentity();
      const healthyIdentity = generateNodeSyncIdentity();
      const attempts: string[] = [];
      const messages: Array<{ peerId: string; message: VoiceDictionaryPeerMessage }> = [];
      const started = deferred<void>();
      const ack = deferred<boolean>();
      let online = false;
      let failFirst = true;
      const manager = new VoiceDictionaryPeerManager({ ...fixture.options, fallbackMilliseconds: 30 * 60_000,
        codec: { ...inProcessCodec, encode: async (options) => {
          messages.push({ peerId: options.destinationNodeId, message: options.message });
          return encodeVoiceDictionaryPeerMessage(options);
        } },
        transportFactory: () => ({ ...emptyTransport(), onlinePeerIds: () => online ? ["node-failed", "node-healthy"] : [],
          send: async (peerId) => {
            attempts.push(peerId);
            if (peerId !== "node-failed" || !failFirst) return true;
            started.resolve();
            return retirement === "complete" ? false : ack.promise;
          } })
      });
      cleanups.push(() => manager.close());
      await manager.initialize();
      fixture.dictionary.setEnabled(fixture.dictionary.snapshot().revision, true);
      const failedPeer = fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-failed",
        displayName: "Failed", publicKey: failedIdentity.publicKey, fingerprint: keyFingerprint(failedIdentity.publicKey) });
      fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: "node-healthy",
        displayName: "Healthy", publicKey: healthyIdentity.publicKey, fingerprint: keyFingerprint(healthyIdentity.publicKey) });
      await manager.syncNow();
      online = true;
      const rejected = trigger === "explicit"
        ? expect(manager.syncNow()).rejects.toMatchObject({ code: retirement === "complete" ? "OFFLINE" : "UNAVAILABLE" })
        : undefined;
      if (trigger === "fallback") await vi.advanceTimersByTimeAsync(30 * 60_000);
      await started.promise;

      if (retirement === "complete") {
        await rejected;
        expect(attempts).toEqual(["node-failed", "node-healthy"]);
        expect(messages.map(({ peerId, message }) => ({ peerId, requestReply: message.requestReply }))).toEqual([
          { peerId: "node-failed", requestReply: true }, { peerId: "node-healthy", requestReply: true }
        ]);
        expect(fixture.peers.peer("node-failed")?.lastSyncAt).toBeUndefined();
        expect(fixture.peers.peer("node-healthy")?.lastSyncAt).toBeDefined();
        expect(manager.status()).toMatchObject({ phase: "error", errorCode: "sync_failed" });
        failFirst = false;
        await manager.syncNow();
        expect(manager.status()).toMatchObject({ phase: "up_to_date" });
        expect(manager.status().errorCode).toBeUndefined();
      } else {
        online = false;
        if (retirement === "revoke") {
          manager.revokePeer(failedPeer.peerId, failedPeer.revision);
          fixture.peers.grantPeer({ expectedRevision: fixture.peers.configurationRevision(), peerId: failedPeer.peerId,
            displayName: "Failed", publicKey: failedIdentity.publicKey, fingerprint: keyFingerprint(failedIdentity.publicKey) });
          await manager.syncNow();
        } else if (retirement === "disable") {
          await manager.setEnabled(fixture.dictionary.snapshot().revision, false);
        } else manager.close();
        ack.resolve(false);
        await rejected;
        await vi.advanceTimersByTimeAsync(0);
        expect(attempts).toEqual(["node-failed"]);
        expect(fixture.peers.peer("node-healthy")?.lastSyncAt).toBeUndefined();
        if (retirement === "close") expect(() => manager.status()).toThrow(/unavailable/u);
        else {
          expect(manager.status()).toMatchObject({ phase: retirement === "disable" ? "off" : "waiting" });
          expect(manager.status().errorCode).toBeUndefined();
        }
      }
    } finally { vi.useRealTimers(); }
  });
});

async function localFixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `joko-dictionary-peer-${name}-`));
  const store = new OperationalStore(join(directory, "orchestrator.db"));
  const peers = new VoiceDictionaryPeerStore(join(directory, "dictionary-peers.db"));
  const dictionary = new VoiceDictionarySyncRepository({ store, createReplicaId: () => `replica-${name}` });
  const vault = await CredentialVault.open(join(directory, "master.key"));
  cleanups.push(() => { peers.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, peers, dictionary, options: { store: peers, dictionary, vault, nodeId: `node-${name}`, displayName: `${name} computer` } };
}

async function temporaryListenerPorts(): Promise<readonly [number, number]> {
  const servers = [createServer(), createServer()];
  try {
    const ports = await Promise.all(servers.map((server) => new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (address === null || typeof address === "string") reject(new Error("A temporary TCP listener did not expose its port."));
        else resolve(address.port);
      });
    })));
    return [ports[0]!, ports[1]!];
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => { if (error === undefined) resolve(); else reject(error); });
    })));
  }
}

async function lanFixture(name: string, multicastPort: number) {
  const directory = mkdtempSync(join(tmpdir(), `joko-dictionary-peer-lan-${name}-`));
  let store: OperationalStore;
  let peers: VoiceDictionaryPeerStore;
  let manager: VoiceDictionaryPeerManager;
  let dictionary: VoiceDictionarySyncRepository;
  let sends = 0;
  const nodeId = `node-${name}`;
  const open = async (): Promise<void> => {
    store = new OperationalStore(join(directory, "orchestrator.db"));
    peers = new VoiceDictionaryPeerStore(join(directory, "dictionary-peers.db"));
    dictionary = new VoiceDictionarySyncRepository({ store, createReplicaId: () => `replica-${name}` });
    const vault = await CredentialVault.open(join(directory, "master.key"));
    manager = new VoiceDictionaryPeerManager({ store: peers, dictionary, vault, nodeId, displayName: `${name} computer`,
      debounceMilliseconds: 30, transportFactory: (options) => {
        const transport = new NodeSyncLanTransport({ ...options, multicastPort, beaconIntervalMilliseconds: 150,
          endpointTtlMilliseconds: 2_000, connectTimeoutMilliseconds: 4_000 });
        return { start: () => transport.start(), stop: () => transport.stop(), candidates: () => transport.candidates(),
          onlinePeerIds: () => transport.onlinePeerIds(), send: (peerId, frame) => { sends += 1; return transport.send(peerId, frame); } };
      }
    });
    await manager.initialize();
  };
  await open();
  cleanups.push(() => { manager.close(); peers.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { nodeId, get manager() { return manager; }, get dictionary() { return dictionary; }, get sends() { return sends; },
    restart: async () => { manager.close(); peers.close(); store.close(); await open(); } };
}

function candidate(first: Awaited<ReturnType<typeof lanFixture>>, second: Awaited<ReturnType<typeof lanFixture>>) {
  return first.manager.status().candidates.find((value) => value.nodeId === second.nodeId);
}
function grant(first: Awaited<ReturnType<typeof lanFixture>>, second: Awaited<ReturnType<typeof lanFixture>>): void {
  const peer = candidate(first, second)!;
  first.manager.grantCandidate(first.manager.status().configurationRevision, peer.nodeId, peer.fingerprint);
}
function hasTerm(fixture: Awaited<ReturnType<typeof lanFixture>>, text: string): boolean {
  return fixture.dictionary.snapshot().dictionary.entries.some((value) => value.text === text);
}
function emptyTransport() {
  return { start: async () => undefined, stop: () => undefined, send: async () => false, candidates: () => [], onlinePeerIds: () => [] };
}
async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for dictionary peer convergence.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function keyFingerprint(key: string): string { return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex"); }
