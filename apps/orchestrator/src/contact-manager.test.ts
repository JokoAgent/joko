import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ContactStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { ContactManager, ContactManagerError } from "./contact-manager.js";
import { parseContactVCards } from "./contact-vcard.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ContactManager portable address-book boundary", () => {
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
      "NOTE:Robotics partner",
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
