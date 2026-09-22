import { rm } from "node:fs/promises";
import { ContactKind, ContactSource, ContactStatus, ContactVCardImportDisposition } from "@joko/contracts";
import { afterEach, expect, it } from "vitest";
import { OrchestratorE2eFixture } from "./fixture.js";

let fixture: OrchestratorE2eFixture | undefined;
let rootDirectory: string | undefined;

afterEach(async () => {
  await fixture?.close({ removeRoot: false });
  fixture = undefined;
  if (rootDirectory !== undefined) await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
  rootDirectory = undefined;
});

it("serves and restarts the complete authenticated local Contact chain", async () => {
  fixture = await OrchestratorE2eFixture.start({ keepRoot: true });
  rootDirectory = fixture.rootDirectory;
  let paired = await fixture.pair("Contact settings window");
  let contact = paired.clients.contact;

  const initial = (await contact.getContactDirectory({})).directory!;
  expect(initial).toMatchObject({ revision: { value: 1n }, enabled: false, people: 0, organizations: 0 });
  const enabled = (await contact.setContactDirectoryEnabled({ expectedDirectoryRevision: initial.revision, enabled: true })).directory!;

  const created = await contact.createContact({
    expectedDirectoryRevision: enabled.revision,
    contact: {
      kind: ContactKind.PERSON,
      displayName: "Ada Lovelace",
      aliases: ["Augusta Ada King"],
      summary: "Computing pioneer",
      narrative: "Worked on the Analytical Engine.",
      agentNotes: "Private local note",
      status: ContactStatus.PENDING,
      source: ContactSource.MANUAL,
      identities: [{ platform: "email", value: "ada@example.test", label: "work", note: "" }]
    }
  });
  const personId = created.contact!.summary!.contactId;
  const confirmed = await contact.confirmContact({
    contactId: personId,
    expectedRevision: created.contact!.summary!.revision
  });
  const withEvent = await contact.appendContactEvent({
    contactId: personId,
    expectedContactRevision: confirmed.contact!.summary!.revision,
    event: { date: "1843-01-01", text: "Published notes", source: "archive" }
  });
  const group = await contact.createContactGroup({
    expectedDirectoryRevision: withEvent.directory!.revision,
    name: "Computing pioneers",
    description: "Early computing contributors"
  });
  const grouped = await contact.setContactGroupMembership({
    contactId: personId,
    expectedContactRevision: withEvent.contact!.summary!.revision,
    contactGroupId: group.group!.contactGroupId,
    member: true
  });
  const organization = await contact.createContact({
    expectedDirectoryRevision: grouped.directory!.revision,
    contact: {
      kind: ContactKind.ORGANIZATION,
      displayName: "Analytical Engines",
      aliases: [],
      summary: "Research organization",
      narrative: "",
      agentNotes: "",
      status: ContactStatus.CONFIRMED,
      source: ContactSource.MANUAL,
      identities: []
    }
  });
  const related = await contact.addContactRelation({
    fromContactId: personId,
    expectedFromRevision: grouped.contact!.summary!.revision,
    toContactId: organization.contact!.summary!.contactId,
    relation: "works at",
    note: "Research"
  });
  expect((await contact.listContacts({ query: "Analytical", pageSize: 100 })).contacts.map((entry) => entry.contactId))
    .toEqual(expect.arrayContaining([personId, organization.contact!.summary!.contactId]));

  const preview = await contact.previewContactVCardImport({
    vcardText: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada L.\r\nEMAIL:ada@example.test\r\nEND:VCARD\r\n"
  });
  expect(preview.entries).toEqual([expect.objectContaining({
    disposition: ContactVCardImportDisposition.AUTO_ENRICH,
    existingContactId: personId
  })]);
  const imported = await contact.commitContactVCardImport({
    previewId: preview.previewId,
    expectedDirectoryRevision: preview.directoryRevision,
    decisions: []
  });
  expect(imported).toMatchObject({
    created: 0,
    enriched: 1,
    skipped: 0,
    contactIds: [personId],
    entries: [{ displayName: "Ada L.", outcome: 2, contactId: personId }]
  });
  const exported = await contact.exportContactsVCard({ contactIds: [personId] });
  expect(exported.vcardText).toContain("FN:Ada Lovelace");
  expect(exported.vcardText).toContain("EMAIL;TYPE=WORK:ada@example.test");
  expect(exported.vcardText).not.toContain("Private local note");

  await fixture.close({ removeRoot: false });
  fixture = await OrchestratorE2eFixture.start({ rootDirectory });
  paired = await fixture.pair("Restarted Contact settings window");
  contact = paired.clients.contact;
  const restartedDirectory = (await contact.getContactDirectory({})).directory!;
  expect(restartedDirectory).toMatchObject({ enabled: true, people: 1, organizations: 1, groups: 1, pending: 0 });
  const restarted = (await contact.getContact({ contactId: personId })).contact!;
  expect(restarted).toMatchObject({
    summary: { contactId: personId, aliases: expect.arrayContaining(["Augusta Ada King", "Ada L."]), status: ContactStatus.CONFIRMED },
    identities: [expect.objectContaining({ normalizedValue: "ada@example.test" })],
    events: [expect.objectContaining({ text: "Published notes" })],
    groups: [expect.objectContaining({ name: "Computing pioneers" })],
    relations: [expect.objectContaining({ relatedDisplayName: "Analytical Engines", relation: "works at" })]
  });
  expect(related.directory!.revision!.value).toBeLessThan(restartedDirectory.revision!.value);
});
