import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONTACT_SCHEMA_BASELINE_ID,
  ContactStore,
  ContactStoreError,
  type ContactDraft,
  type ContactProfileRecord
} from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("current-v1 Contacts store", () => {
  it("persists the exact baseline and rejects an incompatible development database", () => {
    const fixture = createFixture();
    expect(CONTACT_SCHEMA_BASELINE_ID).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.store.directoryState()).toEqual({
      format: 1,
      revision: 1n,
      enabled: false,
      people: 0,
      organizations: 0,
      pending: 0,
      groups: 0
    });

    const created = createContact(fixture.store, {
      kind: "person",
      displayName: "林晓",
      aliases: ["Xiao Lin"],
      summary: "Product lead",
      status: "pending",
      source: "import",
      identities: [{ platform: "email", value: "xiao@example.com", label: "work" }]
    });
    fixture.store.close();

    const reopened = new ContactStore(fixture.filePath);
    cleanups.push(() => reopened.close());
    expect(reopened.getContact(created.id)).toMatchObject({
      displayName: "林晓",
      aliases: ["Xiao Lin"],
      status: "pending",
      source: "import",
      identityCount: 1
    });
    expect(reopened.directoryState()).toMatchObject({ people: 1, pending: 1 });
    reopened.close();

    const raw = new DatabaseSync(fixture.filePath);
    raw.prepare("UPDATE contact_schema_version SET baseline_id = ? WHERE singleton = 1").run("0".repeat(64));
    raw.close();
    expectContactError(() => new ContactStore(fixture.filePath), "CONTACT_STORE_UNAVAILABLE");
  });

  it("requires explicit confirmation for name similarity and auto-enriches only exact identities", () => {
    const { store } = createFixture();
    const alice = createContact(store, {
      kind: "person",
      displayName: "Alice Chen",
      aliases: ["陈爱丽"],
      summary: "Design",
      identities: [{ platform: "github", value: "@Alice", label: "public" }]
    });

    const review = store.createContact({
      expectedDirectoryRevision: store.directoryState().revision,
      kind: "person",
      displayName: "Alice Chen",
      summary: "Research"
    });
    expect(review.contact).toBeUndefined();
    expect(review.candidates).toEqual([expect.objectContaining({
      matchType: "name",
      contactId: alice.id,
      displayName: "Alice Chen"
    })]);
    expect(store.directoryState().people).toBe(1);

    const second = store.createContact({
      expectedDirectoryRevision: store.directoryState().revision,
      confirmedNameCandidateIds: [alice.id],
      kind: "person",
      displayName: "Alice Chen",
      summary: "Research"
    }).contact!;
    expect(second.id).not.toBe(alice.id);
    expect(store.scanDuplicates()).toEqual([expect.objectContaining({
      first: expect.objectContaining({ displayName: "Alice Chen" }),
      second: expect.objectContaining({ displayName: "Alice Chen" })
    })]);

    const revisionBeforeConflict = store.directoryState().revision;
    expectContactError(() => store.createContact({
      expectedDirectoryRevision: revisionBeforeConflict,
      kind: "organization",
      displayName: "Alice Studio",
      identities: [{ platform: "GITHUB", value: "alice" }]
    }), "CONTACT_IDENTITY_CONFLICT", alice.id);
    expect(store.directoryState().revision).toBe(revisionBeforeConflict);
    expect(store.findContactByIdentity("github", "@ALICE")?.id).toBe(alice.id);

    const candidates = store.findSimilar({
      kind: "person",
      displayName: "陈爱丽老师"
    });
    expect(candidates).toContainEqual(expect.objectContaining({ matchType: "name", contactId: alice.id }));
  });

  it("owns bounded profile, identity, event, group, relation, search, and revision behavior", () => {
    const { store } = createFixture();
    const enabled = store.setEnabled(1n, true);
    expect(enabled).toMatchObject({ revision: 2n, enabled: true });
    expect(store.setEnabled(enabled.revision, true)).toEqual(enabled);

    let person = createContact(store, {
      kind: "person",
      displayName: "Mina Park",
      aliases: ["박미나"],
      narrative: "Met at the launch.",
      agentNotes: "Prefers concise updates.",
      identities: [{ platform: "email", value: "mina@example.com" }]
    });
    let organization = createContact(store, {
      kind: "organization",
      displayName: "Northwind Labs",
      summary: "Robotics studio"
    });
    expect(store.directoryState()).toMatchObject({ people: 1, organizations: 1, pending: 0 });

    const stalePersonRevision = person.revision;
    person = store.updateContact(person.id, person.revision, {
      displayName: "Mina Park",
      aliases: ["Mina Park", "박미나", "Mina P."],
      summary: "Robotics advisor"
    });
    expect(person.aliases).toEqual(["박미나", "Mina P."]);
    expectContactError(() => store.updateContact(person.id, stalePersonRevision, { summary: "stale" }), "CONTACT_CHANGED");

    person = store.addIdentity(person.id, person.revision, { platform: "phone", value: "+1 (555) 010-0200", label: "mobile" });
    expect(person.identities.at(-1)).toMatchObject({ normalizedValue: "+15550100200", label: "mobile" });
    person = store.appendEvent(person.id, person.revision, {
      date: "2026-09-21",
      text: "Discussed the Atlas prototype",
      source: "meeting"
    });
    expect(store.listContacts({ query: "Atlas" }).contacts.map((contact) => contact.id)).toEqual([person.id]);
    expect(store.listContacts({ query: "Robotics", kind: "person" })).toMatchObject({ total: 1 });

    const group = store.createGroup(store.directoryState().revision, "Advisors", "Trusted product advisors");
    person = store.setGroupMembership(person.id, person.revision, group.id, true);
    expect(person.groups).toEqual([expect.objectContaining({ id: group.id, memberCount: 1 })]);
    expect(store.listContacts({ groupId: group.id }).contacts.map((contact) => contact.id)).toEqual([person.id]);

    person = store.addRelation({
      fromContactId: person.id,
      expectedFromRevision: person.revision,
      toContactId: organization.id,
      relation: "advisor",
      note: "Quarterly review"
    });
    organization = store.getContact(organization.id);
    expect(person.relations).toEqual([expect.objectContaining({
      direction: "outgoing",
      relatedContactId: organization.id,
      relation: "advisor"
    })]);
    expect(organization.relations).toEqual([expect.objectContaining({ direction: "incoming", relatedContactId: person.id })]);

    person = store.updateRelation({
      ownerContactId: person.id,
      expectedOwnerRevision: person.revision,
      relationId: person.relations[0]!.id,
      expectedRelationRevision: person.relations[0]!.revision,
      relation: "mentor",
      note: "Monthly review"
    });
    expect(person.relations[0]).toMatchObject({ relation: "mentor", note: "Monthly review" });
    person = store.removeRelation(person.id, person.revision, person.relations[0]!.id);
    expect(person.relations).toEqual([]);
    expect(store.getContact(organization.id).relations).toEqual([]);

    person = store.removeEvent(person.id, person.revision, person.events[0]!.id);
    person = store.removeIdentity(person.id, person.revision, person.identities[1]!.id);
    expect(person).toMatchObject({ identityCount: 1, events: [] });
    const disabled = store.setEnabled(store.directoryState().revision, false);
    expect(disabled.enabled).toBe(false);
  });

  it("merges atomically and fences every profile or group affected by merge and delete", () => {
    const { store } = createFixture();
    let target = createContact(store, {
      kind: "person",
      displayName: "Sam Rivera",
      narrative: "Target narrative"
    });
    let merged = createContact(store, {
      kind: "person",
      displayName: "Samuel Rivera",
      summary: "Investor",
      narrative: "Merged narrative",
      agentNotes: "Source note",
      status: "pending",
      identities: [{ platform: "email", value: "samuel@example.com" }]
    });
    let counterpart = createContact(store, { kind: "organization", displayName: "Rivera Ventures" });
    merged = store.appendEvent(merged.id, merged.revision, { date: "2026-09", text: "Seed discussion" });
    const group = store.createGroup(store.directoryState().revision, "Investors");
    merged = store.setGroupMembership(merged.id, merged.revision, group.id, true);
    merged = store.addRelation({
      fromContactId: merged.id,
      expectedFromRevision: merged.revision,
      toContactId: counterpart.id,
      relation: "partner"
    });
    counterpart = store.getContact(counterpart.id);
    target = store.getContact(target.id);
    const groupBeforeMerge = store.listGroups()[0]!;

    const stateBeforeStaleMerge = store.directoryState();
    expectContactError(() => store.mergeContacts({
      targetContactId: target.id,
      expectedTargetRevision: target.revision + 1n,
      mergedContactId: merged.id,
      expectedMergedRevision: merged.revision
    }), "CONTACT_CHANGED");
    expect(store.directoryState()).toEqual(stateBeforeStaleMerge);

    const result = store.mergeContacts({
      targetContactId: target.id,
      expectedTargetRevision: target.revision,
      mergedContactId: merged.id,
      expectedMergedRevision: merged.revision
    });
    expect(result).toMatchObject({
      mergedContactId: merged.id,
      movedIdentities: 1,
      movedEvents: 1,
      movedRelations: 1,
      target: {
        id: target.id,
        aliases: ["Samuel Rivera"],
        summary: "Investor",
        narrative: "Target narrative\n\n---\n\nMerged narrative",
        agentNotes: "Source note",
        status: "confirmed",
        identityCount: 1
      }
    });
    expect(result.target.groups).toEqual([expect.objectContaining({ id: group.id, memberCount: 1 })]);
    expect(result.target.relations).toEqual([expect.objectContaining({ relatedContactId: counterpart.id, relation: "partner" })]);
    expectContactError(() => store.getContact(merged.id), "CONTACT_NOT_FOUND");
    const counterpartAfterMerge = store.getContact(counterpart.id);
    expect(counterpartAfterMerge.revision).toBeGreaterThan(counterpart.revision);
    const groupAfterMerge = store.listGroups()[0]!;
    expect(groupAfterMerge.revision).toBeGreaterThan(groupBeforeMerge.revision);

    expect(store.deleteContact(result.target.id, result.target.revision)).toBe(true);
    const counterpartAfterDelete = store.getContact(counterpart.id);
    expect(counterpartAfterDelete.revision).toBeGreaterThan(counterpartAfterMerge.revision);
    expect(counterpartAfterDelete.relations).toEqual([]);
    const groupAfterDelete = store.listGroups()[0]!;
    expect(groupAfterDelete.revision).toBeGreaterThan(groupAfterMerge.revision);
    expect(groupAfterDelete.memberCount).toBe(0);
    expect(store.directoryState()).toMatchObject({ people: 0, organizations: 1 });
  });
});

function createFixture(): { readonly store: ContactStore; readonly filePath: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-contact-store-"));
  const filePath = path.join(directory, "contacts.db");
  let seed = 0;
  let now = 1_000;
  const store = new ContactStore(filePath, {
    idFactory: () => `fixture-${seed += 1}`,
    now: () => now += 1
  });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

function createContact(store: ContactStore, draft: ContactDraft): ContactProfileRecord {
  const result = store.createContact({ ...draft, expectedDirectoryRevision: store.directoryState().revision });
  expect(result.candidates).toEqual([]);
  expect(result.contact).toBeDefined();
  return result.contact!;
}

function expectContactError(callback: () => unknown, code: ContactStoreError["code"], conflictContactId?: string): void {
  try {
    callback();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ContactStoreError);
    expect(error).toMatchObject({ code, ...(conflictContactId === undefined ? {} : { conflictContactId }) });
  }
}
