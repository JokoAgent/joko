import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ContactStore, type ContactDraft } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ContactManager, ContactManagerError } from "./contact-manager.js";
import { parseContactVCards } from "./contact-vcard.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ContactManager portable address-book boundary", () => {
  it("fills and appends exact-identity agent narratives once while keeping independent merge rules", () => {
    const { manager, store, advance } = createFixture();
    const original = store.createContact({ expectedDirectoryRevision: store.directoryState().revision,
      kind: "person", displayName: "Alice", status: "pending",
      identities: [{ platform: "email", value: "alice@example.test" }] }).contact!;
    const enrich = (narrative: string, extra: Pick<ContactDraft, "summary" | "agentNotes" | "status"> = {}) => manager.createOrEnrichFromAgent({
      expectedDirectoryRevision: manager.directory().revision, kind: "person", displayName: "Alice",
      identities: [{ platform: "email", value: "ALICE@example.test" }], narrative, ...extra
    });
    const filled = enrich("去年在会议认识", { summary: "Original summary", agentNotes: "Use the work address." });
    expect(filled).toMatchObject({ merged: true, mergedContactId: original.id,
      contact: { narrative: "去年在会议认识", status: "pending", source: "manual" } });
    advance(24 * 60 * 60_000);
    const appended = enrich("现在负责采购", { summary: "Replacement summary", agentNotes: "Replacement instructions", status: "confirmed" });
    const combined = "去年在会议认识\n\n<!-- agent enrich 2026-09-22 -->\n现在负责采购";
    expect(appended.contact).toMatchObject({ narrative: combined, summary: "Original summary",
      agentNotes: "Use the work address.", status: "confirmed", source: "manual" });
    expect(manager.list({ query: "负责采购" }).contacts.map(contact => contact.id)).toEqual([original.id]);
    const beforeRepeat = manager.directory();
    expect(enrich("现在负责采购").contact).toEqual(appended.contact);
    expect(enrich("在会议认识").contact).toEqual(appended.contact);
    expect(enrich("").contact).toEqual(appended.contact);
    for (const invalid of [" \t\n ", " 现在负责采购 "]) {
      expect(() => enrich(invalid)).toThrowError(expect.objectContaining({ code: "CONTACT_INVALID" }));
    }
    expect(manager.get(original.id)).toEqual(appended.contact);
    expect(manager.directory()).toEqual(beforeRepeat);

    const preview = manager.previewVCardImport("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alice\r\nEMAIL:alice@example.test\r\nNOTE:Imported note\\nOther imported context\r\nEND:VCARD\r\n");
    manager.commitVCardImport({ previewId: preview.previewId, expectedDirectoryRevision: preview.directoryRevision, decisions: [] });
    expect(manager.get(original.id).narrative).toBe(combined);
  });

  it.each([14, 15])("enforces the combined UTF-8 narrative limit atomically for %i new emoji", (count) => {
    const { manager, store } = createFixture();
    const original = store.createContact({ expectedDirectoryRevision: store.directoryState().revision,
      kind: "person", displayName: "Alice", narrative: "界".repeat(5_430), status: "pending",
      identities: [{ platform: "email", value: "alice@example.test" }] }).contact!;
    const before = manager.directory();
    const enrich = () => manager.createOrEnrichFromAgent({ expectedDirectoryRevision: before.revision,
      kind: "person", displayName: "Alias on enrichment", summary: "New summary", agentNotes: "New instruction",
      status: "confirmed", narrative: "😀".repeat(count),
      identities: [{ platform: "email", value: "alice@example.test" }, { platform: "github", value: "alice" }] });
    if (count === 14) {
      const result = enrich();
      expect(result.contact).toMatchObject({ id: original.id, aliases: ["Alias on enrichment"], summary: "New summary",
        agentNotes: "New instruction", status: "confirmed", identityCount: 2 });
      expect(Buffer.byteLength(result.contact!.narrative, "utf8")).toBe(16_381);
    } else {
      expect(enrich).toThrowError(expect.objectContaining({ code: "CONTACT_INVALID", message: "Contact narrative is too large." }));
      expect(manager.get(original.id)).toEqual(original);
      expect(manager.directory()).toEqual(before);
      expect(manager.resolveIdentity("github", "alice")).toBeUndefined();
    }
  });

  it("previews exact enrichment and staged name review before importing vCard groups and employment", () => {
    const fixture = createFixture();
    const alice = fixture.store.createContact({
      expectedDirectoryRevision: fixture.store.directoryState().revision,
      kind: "person",
      displayName: "Alice Chen",
      aliases: ["陈爱丽"],
      identities: [{ platform: "email", value: "alice@example.com" }]
    }).contact!;

    const preview = fixture.manager.previewVCardImport([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Alice Chen",
      "EMAIL;TYPE=WORK:ALICE@example.com",
      "TEL;TYPE=CELL:+1 (555) 010-0101",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Bob Li",
      "NICKNAME:小李,Bobby",
      "EMAIL:bob@example.com",
      "ORG:Northwind Labs",
      "TITLE:Principal Engineer",
      "CATEGORIES:Partners,Launch Team",
      "NOTE:Robotics partner\\nMet at launch",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:4.0",
      "FN:Bob Li",
      "TEL:tel:+86 138 0013 8000",
      "END:VCARD"
    ].join("\r\n"));

    expect(preview.directoryRevision).toBe(fixture.store.directoryState().revision);
    expect(preview.entries).toHaveLength(3);
    expect(preview.entries[0]).toMatchObject({ disposition: "auto_enrich", existingContactId: alice.id });
    expect(preview.entries[1]).toMatchObject({
      disposition: "create",
      organizationName: "Northwind Labs",
      title: "Principal Engineer",
      groups: ["Partners", "Launch Team"]
    });
    expect(preview.entries[2]).toMatchObject({
      disposition: "needs_review",
      similarEntryIds: [preview.entries[1]!.entryId]
    });

    const result = fixture.manager.commitVCardImport({
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: [{
        entryId: preview.entries[2]!.entryId,
        decision: "merge",
        targetEntryId: preview.entries[1]!.entryId
      }]
    });
    expect(result).toMatchObject({ created: 1, enriched: 2, skipped: 0 });
    expect(result.entries).toEqual([
      expect.objectContaining({ entryId: preview.entries[0]!.entryId, displayName: "Alice Chen", outcome: "enriched", contactId: alice.id }),
      expect.objectContaining({ entryId: preview.entries[1]!.entryId, displayName: "Bob Li", outcome: "created" }),
      expect.objectContaining({ entryId: preview.entries[2]!.entryId, displayName: "Bob Li", outcome: "enriched" })
    ]);
    expect(result.directory).toMatchObject({ people: 2, organizations: 1, groups: 2 });

    const enrichedAlice = fixture.manager.get(alice.id);
    expect(enrichedAlice.identities).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "email", normalizedValue: "alice@example.com" }),
      expect.objectContaining({ platform: "phone", normalizedValue: "+15550100101" })
    ]));
    const bob = fixture.manager.list({ query: "Robotics" }).contacts[0]!;
    const bobProfile = fixture.manager.get(bob.id);
    expect(bobProfile.narrative).toBe("Robotics partner\nMet at launch");
    expect(bobProfile.aliases).toEqual(["小李", "Bobby"]);
    expect(bobProfile.identities).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "email", value: "bob@example.com" }),
      expect.objectContaining({ platform: "phone", normalizedValue: "+8613800138000" })
    ]));
    expect(bobProfile.groups.map((group) => group.name)).toEqual(["Launch Team", "Partners"]);
    expect(bobProfile.relations).toEqual([expect.objectContaining({
      direction: "outgoing",
      relatedDisplayName: "Northwind Labs",
      relatedKind: "organization",
      relation: "works at",
      note: "Principal Engineer"
    })]);

    let privateBob = fixture.manager.update(bob.id, bobProfile.revision, {
      narrative: "PRIVATE_NARRATIVE_MUST_NOT_EXPORT",
      agentNotes: "PRIVATE_AGENT_NOTE_MUST_NOT_EXPORT"
    });
    privateBob = fixture.manager.appendEvent(privateBob.id, privateBob.revision, {
      date: "2026-09-21",
      text: "PRIVATE_EVENT_MUST_NOT_EXPORT"
    });
    const exported = fixture.manager.exportVCards([privateBob.id]);
    expect(exported).toMatchObject({ count: 1, suggestedFileName: "joko-contacts-2026-09-21.vcf" });
    expect(exported.text).toContain("NICKNAME:");
    expect(exported.text).toContain("ORG:Northwind Labs");
    expect(exported.text).toContain("TITLE:Principal Engineer");
    expect(exported.text).toContain("CATEGORIES:Launch Team,Partners");
    expect(exported.text).not.toContain("PRIVATE_NARRATIVE");
    expect(exported.text).not.toContain("PRIVATE_AGENT_NOTE");
    expect(exported.text).not.toContain("PRIVATE_EVENT");
    for (const line of exported.text.split("\r\n").filter(Boolean)) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(parseContactVCards(exported.text)[0]).toMatchObject({
      draft: { displayName: "Bob Li", aliases: ["小李", "Bobby"], summary: "Robotics partner" },
      organizationName: "Northwind Labs",
      title: "Principal Engineer",
      groups: ["Launch Team", "Partners"]
    });
  });

  it("keeps similar names pending until an explicit create or merge decision", () => {
    const fixture = createFixture();
    const existing = fixture.store.createContact({
      expectedDirectoryRevision: 1n,
      kind: "person",
      displayName: "John Smith"
    }).contact!;
    const preview = fixture.manager.previewVCardImport("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:John Smith\r\nEND:VCARD\r\n");
    expect(preview.entries[0]).toMatchObject({
      disposition: "needs_review",
      candidates: [expect.objectContaining({ matchType: "name", contactId: existing.id })]
    });
    expect(() => fixture.manager.commitVCardImport({
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: []
    })).toThrow(/requires a duplicate decision/u);

    const result = fixture.manager.commitVCardImport({
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: [{
        entryId: preview.entries[0]!.entryId,
        decision: "create",
        confirmedNameCandidateIds: [existing.id]
      }]
    });
    expect(result).toMatchObject({ created: 1, enriched: 0, skipped: 0 });
    expect(fixture.store.directoryState().people).toBe(2);
  });

  it("skips new, exact-match and reviewed cards without changing contacts, organizations or groups", () => {
    const fixture = createFixture();
    const existing = fixture.store.createContact({
      expectedDirectoryRevision: fixture.store.directoryState().revision,
      kind: "person",
      displayName: "Existing Person",
      identities: [{ platform: "email", value: "existing@example.com" }]
    }).contact!;
    const organization = fixture.store.createContact({
      expectedDirectoryRevision: fixture.store.directoryState().revision,
      kind: "organization",
      displayName: "Northwind Labs"
    }).contact!;
    const before = fixture.store.directoryState();
    const preview = fixture.manager.previewVCardImport([
      "BEGIN:VCARD", "VERSION:3.0", "FN:Skipped New Person", "EMAIL:new@example.com",
      "ORG:New Organization", "CATEGORIES:Skipped New Group", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "FN:Existing Person", "EMAIL:existing@example.com",
      "TEL:+1 555 010 0199", "NOTE:Skipped enrichment", "ORG:Northwind Labs Europe",
      "CATEGORIES:Skipped Existing Group", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "FN:Existing Person", "NOTE:Skipped name review", "END:VCARD"
    ].join("\r\n"));
    expect(preview.entries.map((entry) => entry.disposition)).toEqual(["create", "auto_enrich", "needs_review"]);
    expect(preview.entries[1]!.organizationCandidates).toEqual([
      expect.objectContaining({ contactId: organization.id, matchType: "name" })
    ]);

    const result = fixture.manager.commitVCardImport({
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: preview.entries.map((entry) => ({ entryId: entry.entryId, decision: "skip" }))
    });

    expect(result).toEqual({
      created: 0,
      enriched: 0,
      skipped: 3,
      contactIds: [],
      entries: preview.entries.map((entry) => ({
        entryId: entry.entryId,
        displayName: entry.contact.displayName,
        outcome: "skipped"
      })),
      directory: before
    });
    expect(fixture.manager.get(existing.id)).toEqual(existing);
    expect(fixture.manager.get(organization.id)).toEqual(organization);
    expect(fixture.store.directoryState()).toEqual(before);
    expect(fixture.manager.groups()).toEqual([]);
    expect(fixture.manager.list({ query: "Skipped New Person" })).toMatchObject({ contacts: [], total: 0 });
  });

  it("keeps skipped cards out of a mixed import while applying the selected cards", () => {
    const fixture = createFixture();
    const existing = fixture.store.createContact({
      expectedDirectoryRevision: fixture.store.directoryState().revision,
      kind: "person",
      displayName: "Existing Person",
      identities: [{ platform: "email", value: "existing@example.com" }]
    }).contact!;
    const preview = fixture.manager.previewVCardImport([
      "BEGIN:VCARD", "VERSION:3.0", "FN:Skipped Person", "EMAIL:skipped@example.com",
      "ORG:Skipped Organization", "CATEGORIES:Skipped Group", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "FN:Selected Person", "EMAIL:selected@example.com", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "FN:Existing Person", "EMAIL:existing@example.com",
      "NOTE:Skipped enrichment", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "FN:Existing Person", "EMAIL:existing@example.com",
      "TEL:+1 555 010 0111", "END:VCARD"
    ].join("\r\n"));

    const result = fixture.manager.commitVCardImport({
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: [
        { entryId: preview.entries[0]!.entryId, decision: "skip" },
        { entryId: preview.entries[2]!.entryId, decision: "skip" },
        { entryId: preview.entries[3]!.entryId, decision: "merge", targetContactId: existing.id, expectedTargetRevision: existing.revision }
      ]
    });

    expect(result).toMatchObject({ created: 1, enriched: 1, skipped: 2, directory: { people: 2, organizations: 0, groups: 0 } });
    expect(result.entries).toEqual([
      { entryId: preview.entries[0]!.entryId, displayName: "Skipped Person", outcome: "skipped" },
      { entryId: preview.entries[1]!.entryId, displayName: "Selected Person", outcome: "created", contactId: expect.any(String) },
      { entryId: preview.entries[2]!.entryId, displayName: "Existing Person", outcome: "skipped" },
      { entryId: preview.entries[3]!.entryId, displayName: "Existing Person", outcome: "enriched", contactId: existing.id }
    ]);
    expect(result.contactIds).toEqual([result.entries[1]!.contactId, existing.id]);
    expect(fixture.manager.resolveIdentity("email", "skipped@example.com")).toBeUndefined();
    expect(fixture.manager.resolveIdentity("email", "selected@example.com")?.id).toBe(result.entries[1]!.contactId);
    expect(fixture.manager.get(existing.id)).toMatchObject({
      summary: "",
      narrative: "",
      identities: expect.arrayContaining([expect.objectContaining({ platform: "phone", normalizedValue: "+15550100111" })])
    });
    expect(fixture.manager.groups()).toEqual([]);
  });

  it("expires previews and rejects a directory that changed after review", () => {
    const fixture = createFixture();
    const card = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Fresh Person\r\nEND:VCARD\r\n";
    const changed = fixture.manager.previewVCardImport(card);
    fixture.store.createContact({
      expectedDirectoryRevision: fixture.store.directoryState().revision,
      kind: "person",
      displayName: "Concurrent Person"
    });
    expectManagerError(() => fixture.manager.commitVCardImport({
      previewId: changed.previewId,
      expectedDirectoryRevision: changed.directoryRevision,
      decisions: []
    }), "CONTACT_IMPORT_CHANGED");

    const expiring = fixture.manager.previewVCardImport(card);
    fixture.advance(10 * 60_000 + 1);
    expectManagerError(() => fixture.manager.commitVCardImport({
      previewId: expiring.previewId,
      expectedDirectoryRevision: expiring.directoryRevision,
      decisions: []
    }), "CONTACT_IMPORT_EXPIRED");
  });

  it("rolls back the whole vCard installation when a later staged target is unavailable", () => {
    const fixture = createFixture();
    fixture.store.createContact({
      expectedDirectoryRevision: 1n,
      kind: "person",
      displayName: "Blocked Target"
    });
    const preview = fixture.manager.previewVCardImport([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Fresh Contact",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Blocked Target",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Blocked Target",
      "END:VCARD"
    ].join("\r\n"));
    expect(preview.entries.map((entry) => entry.disposition)).toEqual(["create", "needs_review", "needs_review"]);

    expectManagerError(() => fixture.manager.commitVCardImport({
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: [
        { entryId: preview.entries[1]!.entryId, decision: "skip" },
        { entryId: preview.entries[2]!.entryId, decision: "merge", targetEntryId: preview.entries[1]!.entryId }
      ]
    }), "CONTACT_IMPORT_INVALID");

    expect(fixture.store.directoryState()).toMatchObject({ revision: preview.directoryRevision, people: 1 });
    expect(fixture.manager.list({ query: "Fresh Contact" })).toMatchObject({ contacts: [], total: 0 });
  });
});

function createFixture(): {
  readonly store: ContactStore;
  readonly manager: ContactManager;
  readonly advance: (milliseconds: number) => void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-contact-manager-"));
  let now = Date.UTC(2026, 8, 21, 12);
  let id = 0;
  const store = new ContactStore(path.join(directory, "contacts.db"), {
    now: () => now,
    idFactory: () => `store-${id += 1}`
  });
  const manager = new ContactManager(store, {
    now: () => now,
    idFactory: () => `preview-${id += 1}`
  });
  cleanups.push(() => {
    manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, manager, advance: (milliseconds) => { now += milliseconds; } };
}

function expectManagerError(callback: () => unknown, code: ContactManagerError["code"]): void {
  try {
    callback();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ContactManagerError);
    expect(error).toMatchObject({ code });
  }
}
