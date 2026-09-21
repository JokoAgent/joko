import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  ContactStore,
  ContactStoreError,
  captureContactSnapshot,
  contactMembershipSyncId,
  contactSyncPublicKeyFingerprint,
  createEmptyContactSnapshot,
  createEmptyContactSyncState,
  isValidContactSyncState,
  materializeContactSyncState,
  mergeContactSyncStates,
  stableContactSyncJson,
  type ContactDataSnapshot,
  type ContactSyncState
} from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Contacts current-v1 device sync state", () => {
  it("merges field-LWW changes associatively, commutatively, and idempotently", () => {
    const initial = snapshot({
      contacts: [contact("contact-1", { displayName: "Ada", summary: "Initial" })]
    });
    const common = captureContactSnapshot(createEmptyContactSyncState(), createEmptyContactSnapshot(), initial, "node-common").state;
    const leftSnapshot = snapshot({
      contacts: [contact("contact-1", { displayName: "Ada Lovelace", summary: "Initial" })]
    });
    const rightSnapshot = snapshot({
      contacts: [contact("contact-1", { displayName: "Ada", summary: "Computing pioneer" })]
    });
    const thirdSnapshot = snapshot({
      contacts: [contact("contact-1", { displayName: "Ada", summary: "Initial", narrative: "Analytical Engine" })]
    });
    const left = captureContactSnapshot(common, initial, leftSnapshot, "node-left").state;
    const right = captureContactSnapshot(common, initial, rightSnapshot, "node-right").state;
    const third = captureContactSnapshot(common, initial, thirdSnapshot, "node-third").state;

    const leftRight = mergeContactSyncStates(left, right);
    expect(stableContactSyncJson(leftRight)).toBe(stableContactSyncJson(mergeContactSyncStates(right, left)));
    expect(stableContactSyncJson(mergeContactSyncStates(leftRight, leftRight))).toBe(stableContactSyncJson(leftRight));
    const associatedLeft = mergeContactSyncStates(mergeContactSyncStates(left, right), third);
    const associatedRight = mergeContactSyncStates(left, mergeContactSyncStates(right, third));
    expect(stableContactSyncJson(associatedLeft)).toBe(stableContactSyncJson(associatedRight));
    expect(materializeContactSyncState(associatedLeft).contacts[0]).toMatchObject({
      displayName: "Ada Lovelace",
      summary: "Computing pioneer",
      narrative: "Analytical Engine"
    });
    expect(isValidContactSyncState(associatedLeft)).toBe(true);
  });

  it("keeps UUID tombstones permanent while allowing membership removal and re-addition", () => {
    const initial = snapshot({
      contacts: [contact("contact-1")],
      groups: [{ id: "group-1", name: "Friends", description: "", createdAt: 1, updatedAt: 1 }],
      memberships: [{ id: contactMembershipSyncId("group-1", "contact-1"), groupId: "group-1", contactId: "contact-1" }]
    });
    const common = captureContactSnapshot(createEmptyContactSyncState(), createEmptyContactSnapshot(), initial, "node-common").state;
    const removedMembership = snapshot({ contacts: initial.contacts, groups: initial.groups });
    const removed = captureContactSnapshot(common, initial, removedMembership, "node-a").state;
    const readded = captureContactSnapshot(removed, removedMembership, initial, "node-a").state;
    expect(materializeContactSyncState(readded).memberships).toHaveLength(1);

    const deletedSnapshot = snapshot({ groups: initial.groups });
    const deleted = captureContactSnapshot(common, initial, deletedSnapshot, "node-a").state;
    const updatedSnapshot = snapshot({
      contacts: [contact("contact-1", { summary: "offline edit" })],
      groups: initial.groups
    });
    const updated = captureContactSnapshot(common, initial, updatedSnapshot, "node-b").state;
    expect(materializeContactSyncState(mergeContactSyncStates(deleted, updated)).contacts).toEqual([]);

    const attemptedReuse = captureContactSnapshot(deleted, deletedSnapshot, updatedSnapshot, "node-a").state;
    expect(materializeContactSyncState(attemptedReuse).contacts).toEqual([]);
  });

  it("materializes deterministic uniqueness winners and requires explicit conflict acknowledgement", () => {
    const initial = snapshot({ contacts: [contact("contact-a"), contact("contact-b", { displayName: "Grace" })] });
    const common = captureContactSnapshot(createEmptyContactSyncState(), createEmptyContactSnapshot(), initial, "node-common").state;
    const leftSnapshot = snapshot({
      contacts: initial.contacts,
      identities: [identity("identity-a", "contact-a", "ada@example.com")]
    });
    const rightSnapshot = snapshot({
      contacts: initial.contacts,
      identities: [identity("identity-b", "contact-b", "ada@example.com")]
    });
    const left = captureContactSnapshot(common, initial, leftSnapshot, "node-left").state;
    const right = captureContactSnapshot(common, initial, rightSnapshot, "node-right").state;
    const merged = mergeContactSyncStates(left, right);
    const projected = materializeContactSyncState(merged);
    expect(projected.identities).toHaveLength(1);
    expect(projected.contacts.map((value) => value.status)).toEqual(["pending", "pending"]);

    const confirmed = snapshot({
      ...projected,
      contacts: projected.contacts.map((value) => value.id === "contact-a" ? { ...value, status: "confirmed" as const } : value)
    });
    const acknowledged = captureContactSnapshot(merged, projected, confirmed, "node-left").state;
    expect(materializeContactSyncState(acknowledged).contacts).toEqual([
      expect.objectContaining({ id: "contact-a", status: "confirmed" }),
      expect.objectContaining({ id: "contact-b", status: "pending" })
    ]);
  });

  it("fails closed when clocks do not cover content stamps", () => {
    const state = captureContactSnapshot(createEmptyContactSyncState(), createEmptyContactSnapshot(),
      snapshot({ contacts: [contact("contact-1")] }), "node-a").state;
    const corrupted = structuredClone(state) as ContactSyncState & { clocks: Array<{ nodeId: string; counter: number }> };
    corrupted.clocks[0]!.counter = 0;
    expect(isValidContactSyncState(corrupted)).toBe(false);
  });
});

describe("Contacts sync durable boundary", () => {
  it("round-trips two stores, persists tombstones, and never revives an offline deletion", () => {
    const first = fixture("first");
    const second = fixture("second");
    const created = first.store.createContact({
      expectedDirectoryRevision: first.store.directoryState().revision,
      kind: "person",
      displayName: "Mina Park",
      identities: [{ platform: "email", value: "mina@example.com" }]
    }).contact!;
    const firstState = first.store.readContactSyncState("node-first").state;
    expect(second.store.mergeContactSyncState("node-second", firstState)).toMatchObject({ changed: true, materialized: true });
    expect(second.store.getContact(created.id)).toMatchObject({ displayName: "Mina Park", identityCount: 1 });

    const secondContact = second.store.updateContact(created.id, second.store.getContact(created.id).revision, { summary: "Remote edit" });
    const secondState = second.store.readContactSyncState("node-second").state;
    first.store.mergeContactSyncState("node-first", secondState);
    expect(first.store.getContact(created.id).summary).toBe("Remote edit");

    first.store.deleteContact(created.id, first.store.getContact(created.id).revision);
    const deletion = first.store.readContactSyncState("node-first").state;
    second.store.mergeContactSyncState("node-second", deletion);
    expect(second.store.allContacts()).toEqual([]);

    const staleOfflineState = secondState;
    second.store.close();
    const reopened = new ContactStore(second.filePath);
    cleanups.push(() => reopened.close());
    reopened.mergeContactSyncState("node-second", staleOfflineState);
    expect(reopened.allContacts()).toEqual([]);
    expect(reopened.readContactSyncState("node-second").state.contacts[0]?.deleted).toBeDefined();
    expect(secondContact.summary).toBe("Remote edit");
  });

  it("persists a sealed local identity and explicitly fenced peer grants", () => {
    const { store } = fixture("configuration");
    const publicKey = Buffer.alloc(44, 7).toString("base64");
    const peerKey = Buffer.alloc(44, 9).toString("base64");
    const configuration = store.initializeContactSyncConfiguration({
      nodeId: "node-local",
      publicKey,
      sealedPrivateKey: JSON.stringify({ algorithm: "aes-256-gcm", ciphertext: "sealed" })
    });
    expect(configuration).toMatchObject({ revision: 1n, enabled: false, nodeId: "node-local", publicKey });
    expect(store.setContactSyncEnabled(configuration.revision, true)).toMatchObject({ revision: 2n, enabled: true });
    expectStoreError(() => store.setContactSyncEnabled(1n, false), "CONTACT_SYNC_CHANGED");

    const peer = store.grantContactSyncPeer({
      peerId: "node-peer",
      displayName: "Office computer",
      publicKey: peerKey,
      fingerprint: contactSyncPublicKeyFingerprint(peerKey)
    });
    expect(peer).toMatchObject({ revision: 1n, peerId: "node-peer" });
    expect(peer.lastSyncAt).toBeUndefined();
    expect(store.recordContactSyncSuccess(peer.peerId, "lan", 123)).toMatchObject({ lastSyncAt: 123, lastRoute: "lan" });
    expectStoreError(() => store.grantContactSyncPeer({
      peerId: "node-peer",
      displayName: "Spoofed computer",
      publicKey: Buffer.alloc(44, 10).toString("base64"),
      fingerprint: contactSyncPublicKeyFingerprint(Buffer.alloc(44, 10).toString("base64"))
    }), "CONTACT_SYNC_CHANGED");
    expect(store.revokeContactSyncPeer(peer.peerId, peer.revision)).toBe(true);
    expect(store.listContactSyncPeers()).toEqual([]);
  });

  it("rejects a corrupted persisted projection without emitting tombstones", () => {
    const value = fixture("corrupt");
    value.store.readContactSyncState("node-local");
    value.store.close();
    const raw = new DatabaseSync(value.filePath);
    raw.prepare("UPDATE contact_sync_state SET projection_json = ? WHERE singleton = 1").run('{"contacts":"invalid"}');
    raw.close();
    const reopened = new ContactStore(value.filePath);
    cleanups.push(() => reopened.close());
    expectStoreError(() => reopened.readContactSyncState("node-local"), "CONTACT_STORE_UNAVAILABLE");
  });
});

function snapshot(overrides: Partial<ContactDataSnapshot> = {}): ContactDataSnapshot {
  return {
    contacts: [],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: [],
    ...overrides
  };
}

function contact(id: string, overrides: Partial<ContactDataSnapshot["contacts"][number]> = {}): ContactDataSnapshot["contacts"][number] {
  return {
    id,
    kind: "person",
    displayName: "Ada",
    aliases: [],
    summary: "",
    narrative: "",
    agentNotes: "",
    status: "confirmed",
    source: "manual",
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function identity(id: string, contactId: string, value: string): ContactDataSnapshot["identities"][number] {
  return {
    id,
    contactId,
    platform: "email",
    value,
    normalizedValue: value,
    label: "",
    note: "",
    createdAt: 1
  };
}

function fixture(name: string): { readonly store: ContactStore; readonly filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), `joko-contact-sync-${name}-`));
  const filePath = join(directory, "contacts.db");
  let sequence = 0;
  const store = new ContactStore(filePath, { idFactory: () => `${name}-${++sequence}` });
  cleanups.push(() => {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

function expectStoreError(callback: () => unknown, code: ContactStoreError["code"]): void {
  try {
    callback();
    throw new Error("Expected Contacts store error.");
  } catch (error) {
    expect(error).toBeInstanceOf(ContactStoreError);
    expect((error as ContactStoreError).code).toBe(code);
  }
}
