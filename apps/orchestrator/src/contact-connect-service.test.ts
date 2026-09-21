import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { ContactStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createContactConnectService } from "./contact-connect-service.js";
import { ContactManager } from "./contact-manager.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ContactService", () => {
  it("authenticates and maps the full local directory lifecycle", async () => {
    const fixture = createFixture();
    const authenticate = vi.fn(() => ({ connectionId: "connection-1" }));
    const service = createContactConnectService(fixture.manager, authenticate);
    const callContext = context();

    const initial = await service.getContactDirectory(create(contract.GetContactDirectoryRequestSchema), callContext);
    expect(initial.directory).toMatchObject({ revision: { value: 1n }, enabled: false, people: 0 });
    const enabled = await service.setContactDirectoryEnabled(create(contract.SetContactDirectoryEnabledRequestSchema, {
      expectedDirectoryRevision: revision(1n), enabled: true
    }), callContext);
    expect(enabled.directory).toMatchObject({ revision: { value: 2n }, enabled: true });

    const created = await service.createContact(create(contract.CreateContactRequestSchema, {
      expectedDirectoryRevision: enabled.directory!.revision,
      contact: create(contract.ContactDraftSchema, {
        kind: contract.ContactKind.PERSON,
        displayName: "Alice Chen",
        aliases: ["陈爱丽"],
        summary: "Product designer",
        status: contract.ContactStatus.PENDING,
        source: contract.ContactSource.MANUAL
      })
    }), callContext);
    expect(created.contact).toMatchObject({ summary: {
      displayName: "Alice Chen",
      status: contract.ContactStatus.PENDING,
      source: contract.ContactSource.MANUAL
    } });
    const contactId = created.contact?.summary?.contactId;
    if (contactId === undefined || contactId === "") throw new Error("ContactService returned no created Contact ID.");
    const pendingRevision = created.contact!.summary!.revision!;

    const confirmed = await service.confirmContact(create(contract.ConfirmContactRequestSchema, {
      contactId, expectedRevision: pendingRevision
    }), callContext);
    expect(confirmed.contact?.summary?.status).toBe(contract.ContactStatus.CONFIRMED);
    const withIdentity = await service.addContactIdentity(create(contract.AddContactIdentityRequestSchema, {
      contactId,
      expectedContactRevision: confirmed.contact!.summary!.revision,
      identity: create(contract.ContactIdentityInputSchema, {
        platform: "email", value: "alice@example.com", label: "work"
      })
    }), callContext);
    const withEvent = await service.appendContactEvent(create(contract.AppendContactEventRequestSchema, {
      contactId,
      expectedContactRevision: withIdentity.contact!.summary!.revision,
      event: create(contract.ContactEventInputSchema, {
        date: "2026-09-21", text: "Reviewed Atlas prototype", source: "meeting"
      })
    }), callContext);
    expect(withEvent.contact).toMatchObject({
      identities: [expect.objectContaining({ normalizedValue: "alice@example.com" })],
      events: [expect.objectContaining({ text: "Reviewed Atlas prototype" })]
    });

    const group = await service.createContactGroup(create(contract.CreateContactGroupRequestSchema, {
      expectedDirectoryRevision: withEvent.directory!.revision,
      name: "Design Partners",
      description: "External design partners"
    }), callContext);
    const grouped = await service.setContactGroupMembership(create(contract.SetContactGroupMembershipRequestSchema, {
      contactId,
      expectedContactRevision: withEvent.contact!.summary!.revision,
      contactGroupId: group.group!.contactGroupId,
      member: true
    }), callContext);
    expect(grouped.contact?.groups).toEqual([expect.objectContaining({ name: "Design Partners", memberCount: 1 })]);

    const organization = await service.createContact(create(contract.CreateContactRequestSchema, {
      expectedDirectoryRevision: grouped.directory!.revision,
      contact: create(contract.ContactDraftSchema, {
        kind: contract.ContactKind.ORGANIZATION,
        displayName: "Northwind Labs",
        source: contract.ContactSource.MANUAL
      })
    }), callContext);
    const related = await service.addContactRelation(create(contract.AddContactRelationRequestSchema, {
      fromContactId: contactId,
      expectedFromRevision: grouped.contact!.summary!.revision,
      toContactId: organization.contact!.summary!.contactId,
      relation: "works at",
      note: "Advisor"
    }), callContext);
    expect(related.contact?.relations).toEqual([expect.objectContaining({
      direction: contract.ContactRelationDirection.OUTGOING,
      relatedDisplayName: "Northwind Labs",
      relation: "works at"
    })]);

    const searched = await service.listContacts(create(contract.ListContactsRequestSchema, {
      query: "Atlas",
      kind: contract.ContactKind.PERSON,
      pageSize: 20
    }), callContext);
    expect(searched).toMatchObject({ total: 1, contacts: [expect.objectContaining({ contactId })] });
    const exported = await service.exportContactsVCard(create(contract.ExportContactsVCardRequestSchema, {
      contactIds: [contactId]
    }), callContext);
    expect(exported).toMatchObject({ contactCount: 1, suggestedFileName: "joko-contacts-2026-09-21.vcf" });
    expect(exported.vcardText).toContain("ORG:Northwind Labs");

    const duplicateReview = await service.createContact(create(contract.CreateContactRequestSchema, {
      expectedDirectoryRevision: related.directory!.revision,
      contact: create(contract.ContactDraftSchema, {
        kind: contract.ContactKind.PERSON,
        displayName: "Alice Chen",
        source: contract.ContactSource.MANUAL
      })
    }), callContext);
    expect(duplicateReview.contact).toBeUndefined();
    expect(duplicateReview.candidates).toEqual([expect.objectContaining({
      matchType: contract.ContactDuplicateMatchType.NAME,
      contactId
    })]);
    const duplicate = await service.createContact(create(contract.CreateContactRequestSchema, {
      expectedDirectoryRevision: duplicateReview.directory!.revision,
      confirmedNameCandidateIds: [contactId],
      contact: create(contract.ContactDraftSchema, {
        kind: contract.ContactKind.PERSON,
        displayName: "Alice Chen",
        source: contract.ContactSource.MANUAL
      })
    }), callContext);
    const scanned = await service.scanContactDuplicates(create(contract.ScanContactDuplicatesRequestSchema, { limit: 10 }), callContext);
    expect(scanned.pairs).toHaveLength(1);
    const current = await service.getContact(create(contract.GetContactRequestSchema, { contactId }), callContext);
    const merged = await service.mergeContacts(create(contract.MergeContactsRequestSchema, {
      targetContactId: contactId,
      expectedTargetRevision: current.contact!.summary!.revision,
      mergedContactId: duplicate.contact!.summary!.contactId,
      expectedMergedRevision: duplicate.contact!.summary!.revision
    }), callContext);
    expect(merged).toMatchObject({ mergedContactId: duplicate.contact!.summary!.contactId, target: { summary: { contactId } } });

    expectConnectError(() => service.updateContact(create(contract.UpdateContactRequestSchema, {
      contactId,
      expectedRevision: pendingRevision,
      patch: create(contract.ContactPatchSchema, { summary: "stale" })
    }), callContext), Code.Aborted);
    expect(authenticate).toHaveBeenCalled();
  });

  it("maps vCard preview/commit and unavailable ownership without exposing file paths", async () => {
    const fixture = createFixture();
    const service = createContactConnectService(fixture.manager, () => ({ connectionId: "connection-1" }));
    const preview = await service.previewContactVCardImport(create(contract.PreviewContactVCardImportRequestSchema, {
      vcardText: "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Imported Person\r\nEMAIL:imported@example.com\r\nEND:VCARD\r\n"
    }), context());
    expect(preview).toMatchObject({
      previewId: expect.stringMatching(/^contact-import-/u),
      entries: [expect.objectContaining({
        disposition: contract.ContactVCardImportDisposition.CREATE,
        contact: expect.objectContaining({
          displayName: "Imported Person",
          status: contract.ContactStatus.CONFIRMED,
          source: contract.ContactSource.IMPORT
        })
      })]
    });
    const previewEntryId = preview.entries?.[0]?.entryId;
    if (previewEntryId === undefined || previewEntryId === "") throw new Error("ContactService returned no vCard preview entry ID.");
    const committed = await service.commitContactVCardImport(create(contract.CommitContactVCardImportRequestSchema, {
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision
    }), context());
    expect(committed).toMatchObject({
      created: 1,
      enriched: 0,
      skipped: 0,
      entries: [{
        entryId: previewEntryId,
        displayName: "Imported Person",
        outcome: contract.ContactVCardImportOutcome.CREATED,
        contactId: expect.any(String)
      }],
      directory: { people: 1 }
    });

    const unavailable = createContactConnectService(undefined, () => ({ connectionId: "connection-1" }));
    expectConnectError(
      () => unavailable.getContactDirectory(create(contract.GetContactDirectoryRequestSchema), context()),
      Code.Unimplemented
    );
  });
});

function createFixture(): { readonly store: ContactStore; readonly manager: ContactManager } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-contact-connect-"));
  let id = 0;
  const store = new ContactStore(path.join(directory, "contacts.db"), {
    now: () => Date.UTC(2026, 8, 21, 12),
    idFactory: () => `contact-${id += 1}`
  });
  const manager = new ContactManager(store, {
    now: () => Date.UTC(2026, 8, 21, 12),
    idFactory: () => `preview-${id += 1}`
  });
  cleanups.push(() => {
    manager.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, manager };
}

function revision(value: bigint): contract.Revision {
  return create(contract.RevisionSchema, { value, etag: `W/\"rev-${value.toString()}\"` });
}

function context(): HandlerContext {
  return { signal: new AbortController().signal } as HandlerContext;
}

function expectConnectError(callback: () => unknown, code: Code): void {
  try {
    callback();
    throw new Error(`Expected Connect code ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code });
  }
}
