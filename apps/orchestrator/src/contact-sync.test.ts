import { randomBytes, randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContactStore,
  contactSyncPublicKeyFingerprint,
  captureContactSnapshot,
  createEmptyContactSnapshot,
  createEmptyContactSyncState,
  type ContactDataSnapshot
} from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContactSyncWorkerCodec } from "./contact-sync-codec.js";
import { generateNodeSyncIdentity, NodeSyncLanTransport, NodeSyncTcpTransport,
  type NodeSyncCipherChunkFrame, type NodeSyncDeliveryContext, type NodeSyncLanTransportOptions } from "@joko/node-sync";
import { ContactSyncManager } from "./contact-sync-manager.js";
import {
  ContactSyncWireDecoder,
  encodeContactSyncMessageInProcess,
  inProcessContactSyncCodec
} from "./contact-sync-wire.js";
import { CredentialVault } from "./credential-vault.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Contacts sync authenticated codec", () => {
  it("assembles out-of-order chunks once and rejects changed transfer metadata", async () => {
    const first = generateNodeSyncIdentity();
    const second = generateNodeSyncIdentity();
    const state = multiChunkState();
    const frames = encodeContactSyncMessageInProcess({
      message: { version: 1, type: "state", state, requestReply: true },
      ownPrivateKey: first.privateKey,
      ownPublicKey: first.publicKey,
      peerPublicKey: second.publicKey,
      sourceNodeId: "node-first",
      destinationNodeId: "node-second"
    });
    const decoder = new ContactSyncWireDecoder(inProcessContactSyncCodec);
    let result = null;
    for (const frame of [...frames].reverse()) {
      result = await decoder.accept({
        sourceNodeId: "node-first",
        destinationNodeId: "node-second",
        frame,
        ownPrivateKey: second.privateKey,
        expectedPeerPublicKey: first.publicKey
      });
    }
    expect(result).toEqual({ version: 1, type: "state", state, requestReply: true });

    const firstFrame = frames[0]!;
    const changed = new ContactSyncWireDecoder(inProcessContactSyncCodec);
    await expect(changed.accept({
      sourceNodeId: "node-first",
      destinationNodeId: "node-second",
      frame: firstFrame,
      ownPrivateKey: second.privateKey,
      expectedPeerPublicKey: first.publicKey
    })).resolves.toBe(frames.length === 1 ? expect.anything() : null);
    if (frames.length > 1) {
      await expect(changed.accept({
        sourceNodeId: "node-first",
        destinationNodeId: "node-second",
        frame: { ...frames[1]!, iv: Buffer.alloc(12, 1).toString("base64") },
        ownPrivateKey: second.privateKey,
        expectedPeerPublicKey: first.publicKey
      })).rejects.toThrow(/metadata changed/iu);
    }
  });

  it("executes gzip and cryptography in the bounded worker", async () => {
    const first = generateNodeSyncIdentity();
    const second = generateNodeSyncIdentity();
    const codec = new ContactSyncWorkerCodec({ timeoutMilliseconds: 10_000 });
    cleanups.push(() => codec.close());
    const state = populatedState(2_048);
    const frames = await codec.encode({
      message: { version: 1, type: "state", state },
      ownPrivateKey: first.privateKey,
      ownPublicKey: first.publicKey,
      peerPublicKey: second.publicKey,
      sourceNodeId: "node-first",
      destinationNodeId: "node-second"
    });
    const decoder = new ContactSyncWireDecoder(codec);
    let message = null;
    for (const frame of frames) {
      message = await decoder.accept({
        sourceNodeId: "node-first",
        destinationNodeId: "node-second",
        frame,
        ownPrivateKey: second.privateKey,
        expectedPeerPublicKey: first.publicKey
      });
    }
    expect(message?.state).toEqual(state);
  });
});

describe("Contacts sync node lifecycle", () => {
  it("keeps a sealed-identity failure visible through structured status without exposing key material", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-contact-sync-identity-"));
    const store = new ContactStore(join(directory, "contacts.db"));
    const vault = await CredentialVault.open(join(directory, "master.key"));
    const identity = generateNodeSyncIdentity();
    store.initializeContactSyncConfiguration({
      nodeId: "node-identity",
      publicKey: identity.publicKey,
      sealedPrivateKey: "{}"
    });
    const manager = new ContactSyncManager({
      store,
      vault,
      nodeId: "node-identity",
      displayName: "Identity computer",
      codec: inProcessContactSyncCodec
    });
    cleanups.push(() => {
      manager.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    await expect(manager.initialize()).rejects.toThrow("Contacts sync identity is unavailable.");
    expect(manager.status()).toMatchObject({
      available: false,
      nodeId: "node-identity",
      enabled: false,
      phase: "off",
      errorCode: "identity_unavailable",
      peers: [],
      candidates: []
    });
  });

  it("lets an explicit retry rebuild a failed LAN transport before any peer is reachable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-contact-sync-retry-"));
    const store = new ContactStore(join(directory, "contacts.db"));
    const vault = await CredentialVault.open(join(directory, "master.key"));
    let starts = 0;
    const manager = new ContactSyncManager({
      store,
      vault,
      nodeId: "node-retry",
      displayName: "Retry computer",
      codec: inProcessContactSyncCodec,
      transportFactory: () => ({
        start: async () => {
          starts += 1;
          if (starts === 1) throw new Error("fixture listener failure");
        },
        stop: () => undefined,
        send: async () => false,
        candidates: () => [],
        onlinePeerIds: () => []
      })
    });
    await manager.initialize();
    cleanups.push(() => {
      manager.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const failed = await manager.setEnabled(manager.status().configurationRevision, true);
    expect(failed).toMatchObject({ enabled: true, phase: "error", errorCode: "sync_failed" });
    const retried = await manager.syncNow();
    expect(retried).toMatchObject({ enabled: true, phase: "waiting" });
    expect(retried.errorCode).toBeUndefined();
    expect(starts).toBe(2);
  });

  it("does not postpone a granted peer's scheduled sync on each more frequent LAN beacon", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-contact-sync-beacons-"));
    const store = new ContactStore(join(directory, "contacts.db"));
    const vault = await CredentialVault.open(join(directory, "master.key"));
    const identity = generateNodeSyncIdentity();
    const candidate = { nodeId: "node-peer", displayName: "Peer", publicKey: identity.publicKey,
      fingerprint: contactSyncPublicKeyFingerprint(identity.publicKey), address: "127.0.0.1", port: 4318, seenAt: Date.now() };
    let transportOptions: NodeSyncLanTransportOptions | undefined;
    const send = vi.fn(async (_peerId: string, _frame: NodeSyncCipherChunkFrame) => true);
    const manager = new ContactSyncManager({ store, vault, nodeId: "node-beacons", displayName: "Beacon receiver",
      codec: inProcessContactSyncCodec, now: () => Date.now(), transportFactory: (options) => {
        transportOptions = options;
        return { start: async () => undefined, stop: () => undefined, send, candidates: () => [candidate], onlinePeerIds: () => [candidate.nodeId] };
      } });
    await manager.initialize();
    cleanups.push(() => { manager.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    vi.useFakeTimers();
    try {
      await manager.setEnabled(manager.status().configurationRevision, true);
      await manager.grantCandidate(candidate.nodeId, candidate.fingerprint);
      await vi.advanceTimersByTimeAsync(50);
      for (let beacon = 0; beacon < 8; beacon++) {
        // NodeSyncLanTransport reports both callbacks for every 150 ms beacon.
        transportOptions!.onCandidate(candidate);
        transportOptions!.onPresenceChanged?.();
        await vi.advanceTimersByTimeAsync(150);
      }
      expect(send).toHaveBeenCalled();
      expect(send.mock.calls.every(call => call[0] === candidate.nodeId)).toBe(true);
      expect(manager.status().peers).toHaveLength(1);
    } finally { manager.close(); vi.useRealTimers(); }
  });

  it("restores missing contacts on explicit sync while automatic sync uses known clocks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-contact-sync-calibration-"));
    const store = new ContactStore(join(directory, "sender.db"));
    const original = new ContactStore(join(directory, "recipient.db"));
    const restored = new ContactStore(join(directory, "recipient-before-sync.db"));
    const vault = await CredentialVault.open(join(directory, "master.key"));
    const identity = generateNodeSyncIdentity();
    const senderId = "node-sender", recipientId = "node-recipient";
    const candidate = { nodeId: recipientId, displayName: "Recipient", publicKey: identity.publicKey,
      fingerprint: contactSyncPublicKeyFingerprint(identity.publicKey), address: "127.0.0.1", port: 4318, seenAt: Date.now() };
    const decoder = new ContactSyncWireDecoder(inProcessContactSyncCodec);
    let recipient = original;
    let recipientOnline = true;
    const delivered: string[][] = [];
    const manager = new ContactSyncManager({ store, vault, nodeId: senderId, displayName: "Sender",
      now: () => Date.now(),
      codec: inProcessContactSyncCodec, transportFactory: () => ({
        start: async () => undefined, stop: () => undefined,
        candidates: () => [candidate], onlinePeerIds: () => recipientOnline ? [recipientId] : [],
        send: async (peerId, frame) => {
          expect(peerId).toBe(recipientId);
          const message = await decoder.accept({ sourceNodeId: senderId, destinationNodeId: recipientId, frame,
            ownPrivateKey: identity.privateKey, expectedPeerPublicKey: store.contactSyncConfiguration()!.publicKey });
          if (message !== null) {
            recipient.mergeContactSyncState(recipientId, message.state);
            delivered.push(message.state.contacts.map(contact => contact.id));
          }
          return true;
        }
      }) });
    cleanups.push(() => {
      manager.close();
      restored.close();
      original.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const contact = store.createContact({ expectedDirectoryRevision: store.directoryState().revision,
      kind: "person", displayName: "Ada", summary: "Must survive a recipient restore" }).contact!;
    await manager.initialize();
    vi.useFakeTimers();
    try {
      await manager.setEnabled(manager.status().configurationRevision, true);
      await manager.grantCandidate(recipientId, candidate.fingerprint);
      await manager.syncNow(recipientId);
      expect(original.getContact(contact.id).summary).toBe(contact.summary);
      await vi.advanceTimersByTimeAsync(100);
      expect(delivered).toEqual([[contact.id], []]);

      recipient = restored;
      expect(restored.allContacts()).toEqual([]);
      await manager.syncNow(recipientId);
      expect(restored.getContact(contact.id).summary).toBe(contact.summary);
      expect(delivered).toEqual([[contact.id], [], [contact.id]]);

      recipientOnline = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(delivered).toHaveLength(3);
      recipientOnline = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(delivered.slice(3)).toEqual([[contact.id]]);

      vi.setSystemTime(Date.now() + 30 * 60_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(delivered.slice(4)).toEqual([[contact.id]]);
    } finally { manager.close(); vi.useRealTimers(); }
  });

  it("acknowledges a committed LAN frame while its separate reply is pending and retires old sends on regrant", async () => {
    const directory = mkdtempSync(join(tmpdir(), "joko-contact-sync-reply-"));
    const store = new ContactStore(join(directory, "contacts.db"));
    const vault = await CredentialVault.open(join(directory, "master.key"));
    const identity = generateNodeSyncIdentity();
    const callerId = "node-first", receiverId = "node-receiver";
    const logger = { debug: () => undefined, warn: () => undefined };
    let receiverPublicKey = "", receivedReplies = 0;
    const caller = new NodeSyncTcpTransport({ purpose: "contacts", logger, listenHost: "127.0.0.1",
      getSelf: () => ({ nodeId: callerId, displayName: "Caller", ...identity }),
      isPeerAllowed: (peerId, key) => peerId === receiverId && key === receiverPublicKey,
      onFrame: () => { receivedReplies += 1; }
    });
    let receiver!: NodeSyncTcpTransport;
    let explicitSync = false;
    const send = vi.fn<(nodeId: string, frame: NodeSyncCipherChunkFrame, delivery: NodeSyncDeliveryContext) => Promise<boolean>>();
    const candidate = { nodeId: callerId, displayName: "Caller", publicKey: identity.publicKey,
      fingerprint: contactSyncPublicKeyFingerprint(identity.publicKey), address: "127.0.0.1", port: 4318, seenAt: Date.now() };
    const manager = new ContactSyncManager({ store, vault, nodeId: receiverId, displayName: "Receiver", codec: inProcessContactSyncCodec,
      transportFactory: (options) => {
        receiver = new NodeSyncTcpTransport({ ...options, listenHost: "127.0.0.1" });
        return { start: () => receiver.start(), stop: () => receiver.stop(), send,
          candidates: () => [candidate], onlinePeerIds: () => explicitSync ? [callerId] : [] };
      }
    });
    cleanups.push(() => { manager.close(); caller.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    await caller.start();
    await manager.initialize();
    await manager.setEnabled(manager.status().configurationRevision, true);
    receiverPublicKey = store.contactSyncConfiguration()!.publicKey;
    await manager.grantCandidate(callerId, candidate.fingerprint);

    const frames = encodeContactSyncMessageInProcess({ message: { version: 1, type: "state", state: populatedState(12), requestReply: true },
      ownPrivateKey: identity.privateKey, ownPublicKey: identity.publicKey, peerPublicKey: receiverPublicKey,
      sourceNodeId: callerId, destinationNodeId: receiverId });
    expect(frames).toHaveLength(1);
    let failReply!: (sent: boolean) => void;
    send.mockImplementationOnce(() => new Promise<boolean>((resolve) => { failReply = resolve; }));
    try {
      expect(await caller.send({ host: "127.0.0.1", port: receiver.listenerPort()!, publicKey: receiverPublicKey }, receiverId, frames[0]!)).toBe(true);
      expect(store.getContact("contact-1").displayName).toBe("Ada");
      expect(send).toHaveBeenCalledOnce();
      expect(manager.status().phase).toBe("syncing");
    } finally { failReply?.(false); }
    await waitUntil(() => manager.status().errorCode === "sync_failed");

    let releaseSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => { releaseSend = resolve; });
    send.mockImplementationOnce(async (peerId, frame, delivery) => {
      await pendingSend;
      return receiver.send({ host: "127.0.0.1", port: caller.listenerPort()!, publicKey: identity.publicKey }, peerId, frame, delivery);
    });
    explicitSync = true;
    const syncing = manager.syncNow(callerId);
    explicitSync = false;
    const rejected = expect(syncing).rejects.toThrow(/could not be reached|authority changed/u);
    await waitUntil(() => send.mock.calls.length === 2);
    const originalDelivery = send.mock.calls[1]![2];
    const granted = manager.status().peers[0]!;
    manager.revokePeer(granted.peerId, granted.revision);
    await manager.grantCandidate(callerId, candidate.fingerprint);
    releaseSend();
    await rejected;
    expect(originalDelivery.signal.aborted).toBe(true);
    expect(originalDelivery.isCurrent()).toBe(false);
    expect(receivedReplies).toBe(0);
    expect(manager.status().errorCode).toBeUndefined();
  });

  it("discovers explicit candidates, converges two real LAN nodes, and revokes delivery", { timeout: 25_000 }, async ({ signal, onTestFailed, onTestFinished }) => {
    type Phase = "fixture" | "enable-first" | "enable-second" | "discovery" | "grant" | "convergence" | "settlement" | "revoke" | "revoked-delivery" | "complete";
    const startedAt = performance.now();
    let phase: Phase = "fixture";
    const observed = { firstEnabled: false, secondEnabled: false, firstSeesSecond: false, secondSeesFirst: false };
    let transportSnapshot: (() => unknown) | undefined;
    const snapshot = () => ({ phase, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), ...observed,
      transports: transportSnapshot?.() });
    let abortedSnapshot: ReturnType<typeof snapshot> | undefined;
    const captureAbort = () => { abortedSnapshot ??= snapshot(); };
    signal.addEventListener("abort", captureAbort, { once: true });
    onTestFinished(() => signal.removeEventListener("abort", captureAbort));
    onTestFailed(() => {
      try { console.error("[contact-sync-boundary]", JSON.stringify(abortedSnapshot ?? snapshot())); }
      catch { /* Observations must preserve the original failure. */ }
    });
    const port = randomInt(54_000, 60_000);
    const first = await managerFixture("first", port);
    const second = await managerFixture("second", port);
    transportSnapshot = () => [first, second].map(({ manager, diagnostics }) => {
      const status = manager.status();
      return { phase: status.phase, errorCode: status.errorCode, candidates: status.candidates.length,
        peers: status.peers.length, onlinePeers: status.onlinePeerCount, diagnostics,
        multicastInterface: process.platform === "win32" ? "os-default" : "loopback" };
    });
    const created = first.store.createContact({
      expectedDirectoryRevision: first.store.directoryState().revision,
      kind: "person",
      displayName: "Lin Xiao",
      summary: "Local before pairing",
      identities: [{ platform: "email", value: "lin@example.com" }]
    }).contact!;

    phase = "enable-first";
    await first.manager.setEnabled(first.manager.status().configurationRevision, true);
    observed.firstEnabled = first.manager.status().enabled;
    phase = "enable-second";
    await second.manager.setEnabled(second.manager.status().configurationRevision, true);
    observed.secondEnabled = second.manager.status().enabled;
    phase = "discovery";
    await waitUntil(() => {
      observed.firstSeesSecond = first.manager.status().candidates.some((candidate) => candidate.nodeId === "node-second");
      observed.secondSeesFirst = second.manager.status().candidates.some((candidate) => candidate.nodeId === "node-first");
      return observed.firstSeesSecond && observed.secondSeesFirst;
    });

    phase = "grant";
    const firstCandidate = first.manager.status().candidates.find((candidate) => candidate.nodeId === "node-second")!;
    const secondCandidate = second.manager.status().candidates.find((candidate) => candidate.nodeId === "node-first")!;
    expect(firstCandidate.granted).toBe(false);
    await first.manager.grantCandidate(firstCandidate.nodeId, firstCandidate.fingerprint);
    await second.manager.grantCandidate(secondCandidate.nodeId, secondCandidate.fingerprint);
    phase = "convergence";
    await waitUntil(() => second.store.allContacts().some((contact) => contact.id === created.id), 10_000);
    expect(second.store.getContact(created.id)).toMatchObject({
      displayName: "Lin Xiao",
      summary: "Local before pairing",
      identityCount: 1
    });
    phase = "settlement";
    await waitUntil(() => first.manager.status().phase === "up_to_date" || second.manager.status().phase === "up_to_date");

    phase = "revoke";
    const granted = first.manager.status().peers.find((peer) => peer.peerId === "node-second")!;
    first.manager.revokePeer(granted.peerId, granted.revision);
    const remote = second.store.getContact(created.id);
    second.store.updateContact(remote.id, remote.revision, { summary: "Must not cross a revoked grant" });
    phase = "revoked-delivery";
    await expect(second.manager.syncNow("node-first")).rejects.toThrow(/could not be reached|reachable/iu);
    expect(first.store.getContact(created.id).summary).toBe("Local before pairing");
    expect(first.manager.status().peers).toEqual([]);
    phase = "complete";
  });
});

function populatedState(narrativeLength: number) {
  const current: ContactDataSnapshot = {
    contacts: [{
      id: "contact-1",
      kind: "person",
      displayName: "Ada",
      aliases: [],
      summary: "",
      narrative: "x".repeat(narrativeLength),
      agentNotes: "",
      status: "confirmed",
      source: "manual",
      createdAt: 1,
      updatedAt: 1
    }],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: []
  };
  return captureContactSnapshot(createEmptyContactSyncState(), createEmptyContactSnapshot(), current, "node-first").state;
}

function multiChunkState() {
  const contacts: ContactDataSnapshot["contacts"][number][] = [];
  for (let index = 0; index < 32; index += 1) {
    contacts.push({
      id: `contact-${index}`,
      kind: "person",
      displayName: `Contact ${index}`,
      aliases: [],
      summary: "",
      narrative: randomBytes(11_500).toString("base64"),
      agentNotes: "",
      status: "confirmed",
      source: "manual",
      createdAt: 1,
      updatedAt: 1
    });
  }
  return captureContactSnapshot(createEmptyContactSyncState(), createEmptyContactSnapshot(), {
    contacts,
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: []
  }, "node-first").state;
}

async function managerFixture(name: string, multicastPort: number): Promise<{
  readonly manager: ContactSyncManager;
  readonly store: ContactStore;
  readonly diagnostics: readonly { readonly level: string; readonly code?: string }[];
}> {
  const directory = mkdtempSync(join(tmpdir(), `joko-contact-sync-manager-${name}-`));
  const store = new ContactStore(join(directory, "contacts.db"));
  const vault = await CredentialVault.open(join(directory, "master.key"));
  const diagnostics: { level: string; code?: string }[] = [];
  const record = (level: string, metadata?: Readonly<Record<string, unknown>>) => {
    if (diagnostics.length === 20) diagnostics.shift();
    diagnostics.push({ level, ...(typeof metadata?.code === "string" ? { code: metadata.code.slice(0, 48) } : {}) });
  };
  const manager = new ContactSyncManager({
    store,
    vault,
    nodeId: `node-${name}`,
    displayName: `${name} computer`,
    codec: inProcessContactSyncCodec,
    transportFactory: (options) => new NodeSyncLanTransport({
      ...options,
      // Windows uses the same OS-selected interface as the production LAN chain;
      // the Unix same-host fixtures use their configured loopback route.
      ...(process.platform === "win32" ? {} : { multicastInterface: "127.0.0.1" }),
      multicastPort,
      beaconIntervalMilliseconds: 150,
      endpointTtlMilliseconds: 2_000,
      connectTimeoutMilliseconds: 800,
      multicastLoopback: true,
      logger: { debug: (_message, metadata) => record("debug", metadata), warn: (_message, metadata) => record("warn", metadata) }
    })
  });
  await manager.initialize();
  cleanups.push(() => {
    manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, store, diagnostics };
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Contacts sync state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
