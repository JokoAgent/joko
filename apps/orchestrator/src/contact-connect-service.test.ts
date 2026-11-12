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
import type { ContactSyncManager, ContactSyncStatus } from "./contact-sync-manager.js";
import { SystemContactsPermissionError, type NativeSystemContactsPort } from "./input-handoff/native-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ContactService", () => {
  it("imports only on the original native connection and stores the Apple ID privately", async () => {
    const { manager, store } = createFixture();
    manager.setEnabled(1n, true);
    let connectionId = "remote";
    let current = true;
    const port: NativeSystemContactsPort = {
      connectionId: "desktop", deviceId: "mac",
      assertCurrent: () => { if (!current) throw new ConnectError("Host retired", Code.FailedPrecondition); },
      read: vi.fn<NativeSystemContactsPort["read"]>(async (_input, check) => {
        check();
        return create(contract.NativeSystemContactsReadResponseSchema, { cards: [{
          nativeId: "apple-card-1", fields: { kind: contract.ContactKind.PERSON, displayName: "Ada Lovelace",
            emails: [{ value: "ada@example.test" }, { value: "ADA@example.test" }] }
        }] });
      }),
      write: async () => { throw new Error("Unexpected native write."); }
    };
    const service = createContactConnectService(manager, () => connectionId, undefined, id => id === port.connectionId
      ? { ownerId: id, port, assertCurrent: port.assertCurrent } : undefined);
    const caller = context();
    const directory = () => service.getContactDirectory(create(contract.GetContactDirectoryRequestSchema), caller);
    const preview = () => service.previewSystemContactImport(create(contract.PreviewSystemContactImportRequestSchema), caller);
    expect((await directory()).systemImportAvailable).toBe(false);
    await expect(preview()).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(port.read).not.toHaveBeenCalled();

    connectionId = "desktop";
    expect((await directory()).systemImportAvailable).toBe(true);
    vi.mocked(port.read).mockRejectedValueOnce(new SystemContactsPermissionError());
    await expect(preview()).rejects.toMatchObject({ code: Code.PermissionDenied });
    const first = (await preview()).preview!;
    expect(JSON.stringify(first, (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toContain("apple-card-1");
    expect(first.entries[0]?.contact?.identities).toHaveLength(1);
    const confirmation = { previewId: first.previewId, expectedDirectoryRevision: first.directoryRevision };
    expectConnectError(() => service.commitContactVCardImport(create(contract.CommitContactVCardImportRequestSchema, confirmation), caller), Code.FailedPrecondition);
    connectionId = "remote";
    const commit = () => service.commitSystemContactImport(create(contract.CommitSystemContactImportRequestSchema, { confirmation }), caller);
    expectConnectError(commit, Code.FailedPrecondition);
    expect(manager.directory().people).toBe(0);
    connectionId = "desktop";
    const receipt = (await commit()).receipt!;
    expect(receipt).toMatchObject({ created: 1, enriched: 0 });
    expect(store.systemContactAnchor("mac", receipt.contactIds[0]!)).toEqual({ nativeId: "apple-card-1", unresolved: false });
    expect(manager.exportVCards(receipt.contactIds).text).not.toContain("apple-card-1");
    const second = (await preview()).preview!;
    expect(second.entries[0]).toMatchObject({ disposition: contract.ContactVCardImportDisposition.AUTO_ENRICH,
      existingContactId: receipt.contactIds[0] });
    current = false;
    expectConnectError(() => service.commitSystemContactImport(create(contract.CommitSystemContactImportRequestSchema, {
      confirmation: { previewId: second.previewId, expectedDirectoryRevision: second.directoryRevision }
    }), caller), Code.FailedPrecondition);
    expect(manager.directory().people).toBe(1);
  });

  it("saves and syncs multiline contact prose through the formal create and update requests", async () => {
    const { store, manager } = createFixture();
    const service = createContactConnectService(manager, () => ({ connectionId: "connection-1" }));
    const caller = context();
    const enabled = await service.setContactDirectoryEnabled(create(contract.SetContactDirectoryEnabledRequestSchema, {
      expectedDirectoryRevision: revision(1n), enabled: true
    }), caller);
    const narrative = "第一段\r\n第二段\t细节";
    const created = await service.createContact(create(contract.CreateContactRequestSchema, {
      expectedDirectoryRevision: enabled.directory!.revision,
      contact: { kind: contract.ContactKind.PERSON, displayName: "Alice Chen", narrative, agentNotes: "First\nSecond" }
    }), caller);
    expect(created.contact).toMatchObject({ narrative, agentNotes: "First\nSecond" });
    const contactId = created.contact!.summary!.contactId;
    if (!contactId) throw new Error("The created contact has no identity.");
    const notes = "Use preferred name\n\tConfirm with Alice";
    const update = async (patch: { summary?: string; narrative?: string; agentNotes?: string }) => service.updateContact(
      create(contract.UpdateContactRequestSchema, { contactId, expectedRevision: created.contact!.summary!.revision, patch }), caller
    );
    for (const patch of [{ summary: "First\nSecond" }, { narrative: "First\u0000Second" },
      { narrative: "中".repeat(5_462) }, { agentNotes: "First\rSecond" }]) {
      await expect(update(patch)).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    await expect(update({ agentNotes: notes })).resolves.toMatchObject({ contact: { narrative, agentNotes: notes } });
    const destination = createFixture();
    const sync = store.readContactSyncState("source-node").state;
    destination.store.mergeContactSyncState("destination-node", sync);
    expect(destination.store.getContact(contactId)).toMatchObject({ narrative, agentNotes: notes });
  });

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

  it("reports all-invalid cards without effects and rechecks authentication before committing them", async () => {
    const { manager, store } = createFixture();
    let authorized = true;
    const service = createContactConnectService(manager, () => {
      if (!authorized) throw new ConnectError("Revoked", Code.Unauthenticated);
      return { connectionId: "connection-1" };
    });
    const before = store.directoryState();
    const preview = await service.previewContactVCardImport(create(contract.PreviewContactVCardImportRequestSchema, {
      vcardText: `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${"x".repeat(101)}\r\nEND:VCARD\r\n`
    }), context());
    expect(preview).toMatchObject({ entries: [], rejectedEntries: [{ entryId: "vcard-entry-1", reason: "Contact display name is invalid." }] });
    const commit = create(contract.CommitContactVCardImportRequestSchema, { previewId: preview.previewId, expectedDirectoryRevision: preview.directoryRevision });
    authorized = false;
    expectConnectError(() => service.commitContactVCardImport(commit, context()), Code.Unauthenticated);
    expect(store.directoryState()).toEqual(before);
    authorized = true;
    expect(await service.commitContactVCardImport(commit, context())).toMatchObject({ created: 0, enriched: 0, skipped: 1,
      entries: [{ entryId: "vcard-entry-1", outcome: contract.ContactVCardImportOutcome.SKIPPED, reason: "Contact display name is invalid." }] });
    expect(store.directoryState()).toEqual(before);
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

  it("preserves explicit skip decisions and their receipts for new and exact-match vCards", async () => {
    const fixture = createFixture();
    const existing = fixture.store.createContact({
      expectedDirectoryRevision: fixture.store.directoryState().revision,
      kind: "person",
      displayName: "Existing Person",
      identities: [{ platform: "email", value: "existing@example.com" }]
    }).contact!;
    const before = fixture.store.directoryState();
    const authenticate = vi.fn(() => ({ connectionId: "connection-1" }));
    const service = createContactConnectService(fixture.manager, authenticate);
    const preview = await service.previewContactVCardImport(create(contract.PreviewContactVCardImportRequestSchema, {
      vcardText: [
        "BEGIN:VCARD", "VERSION:3.0", "FN:New Person", "EMAIL:new@example.com", "END:VCARD",
        "BEGIN:VCARD", "VERSION:3.0", "FN:Existing Person", "EMAIL:existing@example.com",
        "TEL:+1 555 010 0199", "END:VCARD"
      ].join("\r\n")
    }), context());
    const newEntryId = preview.entries?.[0]?.entryId;
    const existingEntryId = preview.entries?.[1]?.entryId;
    if (!newEntryId || !existingEntryId) throw new Error("ContactService returned no vCard preview entry IDs.");

    const result = await service.commitContactVCardImport(create(contract.CommitContactVCardImportRequestSchema, {
      previewId: preview.previewId,
      expectedDirectoryRevision: preview.directoryRevision,
      decisions: [
        { entryId: newEntryId, decision: contract.ContactVCardImportDecisionKind.SKIP },
        { entryId: existingEntryId, decision: contract.ContactVCardImportDecisionKind.SKIP }
      ]
    }), context());

    expect(result).toMatchObject({
      created: 0,
      enriched: 0,
      skipped: 2,
      contactIds: [],
      entries: [
        { entryId: newEntryId, displayName: "New Person", outcome: contract.ContactVCardImportOutcome.SKIPPED },
        { entryId: existingEntryId, displayName: "Existing Person", outcome: contract.ContactVCardImportOutcome.SKIPPED }
      ]
    });
    expect(result.entries?.map((entry) => entry.contactId)).toEqual([undefined, undefined]);
    expect(fixture.store.directoryState()).toEqual(before);
    expect(fixture.manager.get(existing.id)).toEqual(existing);
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  it("authenticates and maps device-sync status, grants, revocation, and manual retry", async () => {
    const fixture = createFixture();
    const status = contactSyncStatus();
    const sync = {
      status: vi.fn(() => status),
      setEnabled: vi.fn(async () => status),
      grantCandidate: vi.fn(async () => status),
      revokePeer: vi.fn(() => status),
      syncNow: vi.fn(async () => status)
    };
    const authenticate = vi.fn(() => ({ connectionId: "connection-1" }));
    const service = createContactConnectService(fixture.manager, authenticate, sync as unknown as ContactSyncManager);
    const callContext = context();

    const current = await service.getContactSyncStatus(create(contract.GetContactSyncStatusRequestSchema), callContext);
    expect(current.status).toMatchObject({
      available: true,
      configurationRevision: { value: 9n },
      nodeId: "node-local",
      fingerprint: "a".repeat(64),
      enabled: true,
      phase: contract.ContactSyncPhase.UP_TO_DATE,
      onlinePeerCount: 1,
      lastSyncPeerId: "node-peer",
      lastSyncPeerName: "Nearby Joko",
      lastRoute: contract.ContactSyncRoute.LAN,
      peers: [expect.objectContaining({
        peerId: "node-peer",
        revision: expect.objectContaining({ value: 3n }),
        state: contract.ContactSyncPeerState.ACTIVE,
        online: true,
        lastRoute: contract.ContactSyncRoute.LAN
      })],
      candidates: [expect.objectContaining({ nodeId: "node-new", granted: false, keyChanged: false })]
    });
    await service.setContactSyncEnabled(create(contract.SetContactSyncEnabledRequestSchema, {
      expectedConfigurationRevision: revision(9n), enabled: false
    }), callContext);
    await service.grantContactSyncPeer(create(contract.GrantContactSyncPeerRequestSchema, {
      nodeId: "node-new", expectedFingerprint: "c".repeat(64)
    }), callContext);
    await service.revokeContactSyncPeer(create(contract.RevokeContactSyncPeerRequestSchema, {
      peerId: "node-peer", expectedRevision: revision(3n)
    }), callContext);
    await service.syncContactsNow(create(contract.SyncContactsNowRequestSchema, { peerId: "node-peer" }), callContext);

    expect(sync.setEnabled).toHaveBeenCalledWith(9n, false);
    expect(sync.grantCandidate).toHaveBeenCalledWith("node-new", "c".repeat(64));
    expect(sync.revokePeer).toHaveBeenCalledWith("node-peer", 3n);
    expect(sync.syncNow).toHaveBeenCalledWith("node-peer");
    expect(authenticate).toHaveBeenCalledTimes(5);
  });
});

function contactSyncStatus(): ContactSyncStatus {
  return {
    available: true,
    configurationRevision: 9n,
    nodeId: "node-local",
    fingerprint: "a".repeat(64),
    enabled: true,
    phase: "up_to_date",
    onlinePeerCount: 1,
    lastSyncAt: 4_000,
    lastSyncPeerId: "node-peer",
    lastSyncPeerName: "Nearby Joko",
    lastRoute: "lan",
    peers: [{
      peerId: "node-peer",
      revision: 3n,
      displayName: "Nearby Joko",
      fingerprint: "b".repeat(64),
      online: true,
      state: "active",
      grantedAt: 2_000,
      lastSyncAt: 4_000,
      lastRoute: "lan"
    }],
    candidates: [{
      nodeId: "node-new",
      displayName: "New Joko",
      fingerprint: "c".repeat(64),
      seenAt: 5_000,
      granted: false,
      keyChanged: false
    }]
  };
}

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
