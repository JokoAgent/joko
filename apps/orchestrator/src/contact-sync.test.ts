import { randomBytes, randomInt } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContactStore,
  captureContactSnapshot,
  createEmptyContactSnapshot,
  createEmptyContactSyncState,
  type ContactDataSnapshot
} from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ContactSyncWorkerCodec } from "./contact-sync-codec.js";
import {
  createContactSyncLanProof,
  decryptContactSyncBytes,
  encryptContactSyncBytes,
  generateContactSyncIdentity,
  verifyContactSyncLanProof
} from "./contact-sync-crypto.js";
import { ContactSyncLanTransport } from "./contact-sync-lan.js";
import { ContactSyncManager } from "./contact-sync-manager.js";
import {
  ContactSyncWireDecoder,
  encodeContactSyncMessageInProcess,
  inProcessContactSyncCodec,
  type ContactSyncCipherChunkFrame
} from "./contact-sync-wire.js";
import { CredentialVault } from "./credential-vault.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Contacts sync authenticated codec", () => {
  it("binds ciphertext and LAN proofs to both nodes and every frame field", () => {
    const first = generateContactSyncIdentity();
    const second = generateContactSyncIdentity();
    const context = {
      sourceNodeId: "node-first",
      destinationNodeId: "node-second",
      transferId: "transfer-1",
      totalChunks: 1
    };
    const encrypted = encryptContactSyncBytes(Buffer.from("private contacts state"), first.privateKey, second.publicKey, context);
    expect(decryptContactSyncBytes(encrypted, second.privateKey, first.publicKey, context).toString("utf8"))
      .toBe("private contacts state");
    expect(() => decryptContactSyncBytes(encrypted, second.privateKey, first.publicKey, {
      ...context,
      destinationNodeId: "node-third"
    })).toThrow();

    const auth = {
      kind: "request" as const,
      sourceNodeId: "node-first",
      destinationNodeId: "node-second",
      challenge: Buffer.alloc(24, 3).toString("base64"),
      senderPublicKey: first.publicKey,
      transferId: "transfer-1",
      index: 0,
      total: 1,
      iv: encrypted.iv,
      tag: encrypted.tag,
      data: encrypted.ciphertext.toString("base64")
    };
    const proof = createContactSyncLanProof(first.privateKey, second.publicKey, auth);
    expect(verifyContactSyncLanProof(proof, second.privateKey, first.publicKey, auth)).toBe(true);
    expect(verifyContactSyncLanProof(proof, second.privateKey, first.publicKey, { ...auth, kind: "ack" })).toBe(false);
    expect(verifyContactSyncLanProof(proof, second.privateKey, first.publicKey, { ...auth, index: 1 })).toBe(false);
  });

  it("assembles out-of-order chunks once and rejects changed transfer metadata", async () => {
    const first = generateContactSyncIdentity();
    const second = generateContactSyncIdentity();
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
    const first = generateContactSyncIdentity();
    const second = generateContactSyncIdentity();
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
    const identity = generateContactSyncIdentity();
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

  it("discovers explicit candidates, converges two real LAN nodes, and revokes delivery", { timeout: 25_000 }, async () => {
    const port = randomInt(54_000, 60_000);
    const first = await managerFixture("first", port);
    const second = await managerFixture("second", port);
    const created = first.store.createContact({
      expectedDirectoryRevision: first.store.directoryState().revision,
      kind: "person",
      displayName: "Lin Xiao",
      summary: "Local before pairing",
      identities: [{ platform: "email", value: "lin@example.com" }]
    }).contact!;

    await first.manager.setEnabled(first.manager.status().configurationRevision, true);
    await second.manager.setEnabled(second.manager.status().configurationRevision, true);
    await waitUntil(() => first.manager.status().candidates.some((candidate) => candidate.nodeId === "node-second") &&
      second.manager.status().candidates.some((candidate) => candidate.nodeId === "node-first"));

    const firstCandidate = first.manager.status().candidates.find((candidate) => candidate.nodeId === "node-second")!;
    const secondCandidate = second.manager.status().candidates.find((candidate) => candidate.nodeId === "node-first")!;
    expect(firstCandidate.granted).toBe(false);
    await first.manager.grantCandidate(firstCandidate.nodeId, firstCandidate.fingerprint);
    await second.manager.grantCandidate(secondCandidate.nodeId, secondCandidate.fingerprint);
    await waitUntil(() => second.store.allContacts().some((contact) => contact.id === created.id), 10_000);
    expect(second.store.getContact(created.id)).toMatchObject({
      displayName: "Lin Xiao",
      summary: "Local before pairing",
      identityCount: 1
    });
    await waitUntil(() => first.manager.status().phase === "up_to_date" || second.manager.status().phase === "up_to_date");

    const granted = first.manager.status().peers.find((peer) => peer.peerId === "node-second")!;
    first.manager.revokePeer(granted.peerId, granted.revision);
    const remote = second.store.getContact(created.id);
    second.store.updateContact(remote.id, remote.revision, { summary: "Must not cross a revoked grant" });
    await expect(second.manager.syncNow("node-first")).rejects.toThrow(/could not be reached|reachable/iu);
    expect(first.store.getContact(created.id).summary).toBe("Local before pairing");
    expect(first.manager.status().peers).toEqual([]);
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
}> {
  const directory = mkdtempSync(join(tmpdir(), `joko-contact-sync-manager-${name}-`));
  const store = new ContactStore(join(directory, "contacts.db"));
  const vault = await CredentialVault.open(join(directory, "master.key"));
  const manager = new ContactSyncManager({
    store,
    vault,
    nodeId: `node-${name}`,
    displayName: `${name} computer`,
    codec: inProcessContactSyncCodec,
    transportFactory: (options) => new ContactSyncLanTransport({
      ...options,
      multicastPort,
      beaconIntervalMilliseconds: 150,
      endpointTtlMilliseconds: 2_000,
      connectTimeoutMilliseconds: 800,
      multicastLoopback: true
    })
  });
  await manager.initialize();
  cleanups.push(() => {
    manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { manager, store };
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Contacts sync state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
