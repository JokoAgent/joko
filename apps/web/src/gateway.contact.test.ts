import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  ContactDuplicateMatchType,
  ContactKind,
  ContactRelationDirection,
  ContactSource,
  ContactStatus,
  ContactVCardImportDisposition,
  ContactVCardImportOutcome
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

describe("Contact gateway", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses generated Contact RPCs, maps the whole local graph, and preserves mutation and import fences", async () => {
    const requests: Array<{ readonly method: string; readonly input: any; readonly signal?: AbortSignal }> = [];
    const transport = {
      unary: vi.fn(async (method: any, signal: AbortSignal | undefined, _timeout: unknown, _headers: unknown, input: any) => {
        requests.push({ method: method.localName, input, signal });
        return response(method, create(method.output, contactResponse(method.localName)));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "profile", deviceId: "device", name: "Node", origin: "https://service.example", serverId: "node" },
      "fixture-auth",
      {},
      () => transport
    );
    await gateway.connect();
    const signal = new AbortController().signal;

    await expect(gateway.getContactDirectory(signal)).resolves.toEqual({
      format: 1, revision: 7n, enabled: true, people: 1, organizations: 1, pending: 1, groups: 1
    });
    await expect(gateway.setContactDirectoryEnabled(7n, false, signal)).resolves.toEqual({
      format: 1, revision: 7n, enabled: true, people: 1, organizations: 1, pending: 1, groups: 1
    });
    await expect(gateway.listContacts({ query: "Ada", kind: "person", status: "confirmed", groupId: "group-one", pageSize: 25, pageOffset: 5 }, signal)).resolves.toMatchObject({
      total: 1, contacts: [{ id: "contact-one", displayName: "Ada Lovelace", kind: "person", revision: 5n }]
    });
    await expect(gateway.getContact("contact-one", signal)).resolves.toMatchObject({
      id: "contact-one",
      identities: [{ id: "identity-one", platform: "email", value: "ada@example.test", revision: 3n }],
      events: [{ id: "event-one", date: "1843-01-01", text: "Published notes" }],
      groups: [{ id: "group-one", memberCount: 1 }],
      relations: [{ id: "relation-one", direction: "outgoing", relatedDisplayName: "Analytical Engines" }]
    });
    await expect(gateway.findSimilarContacts(draft(), signal)).resolves.toEqual([expect.objectContaining({ matchType: "name", contactId: "contact-one" })]);
    await expect(gateway.createContact(7n, draft(), ["contact-one"], signal)).resolves.toMatchObject({ contact: { id: "contact-one" }, directory: { revision: 7n } });
    await gateway.updateContact("contact-one", 5n, { aliases: ["A. Lovelace"], status: "pending" }, signal);
    await gateway.confirmContact("contact-one", 5n, signal);
    await gateway.deleteContact("contact-one", 5n, signal);
    await gateway.addContactIdentity("contact-one", 5n, { platform: "phone", value: "+1 555", label: "work", note: "" }, signal);
    await gateway.removeContactIdentity("contact-one", 5n, "identity-one", signal);
    await gateway.appendContactEvent("contact-one", 5n, { date: "1843-01-01", text: "Published notes", source: "archive" }, signal);
    await gateway.removeContactEvent("contact-one", 5n, "event-one", signal);
    await expect(gateway.listContactGroups(signal)).resolves.toEqual([expect.objectContaining({ id: "group-one", revision: 4n })]);
    await gateway.createContactGroup(7n, "Pioneers", "Computing pioneers", signal);
    await gateway.updateContactGroup("group-one", 4n, "Pioneers", "Updated", signal);
    await gateway.deleteContactGroup("group-one", 4n, signal);
    await gateway.setContactGroupMembership("contact-one", 5n, "group-one", true, signal);
    await gateway.addContactRelation("contact-one", 5n, "organization-one", "works at", "Founder", signal);
    await gateway.updateContactRelation("contact-one", 5n, "relation-one", 3n, "founded", "", signal);
    await gateway.removeContactRelation("contact-one", 5n, "relation-one", signal);
    await expect(gateway.scanContactDuplicates(20, signal)).resolves.toMatchObject({ pairs: [{ first: { id: "contact-one" }, second: { id: "organization-one" } }] });
    await expect(gateway.mergeContacts("contact-one", 5n, "organization-one", 4n, signal)).resolves.toMatchObject({ target: { id: "contact-one" }, mergedContactId: "organization-one", movedIdentities: 1 });
    const preview = await gateway.previewContactVCardImport("BEGIN:VCARD\r\nEND:VCARD\r\n", signal);
    expect(preview).toMatchObject({
      previewId: "preview-one",
      directoryRevision: 7n,
      expiresAt: 60_000,
      entries: [{
        entryId: "entry-one",
        disposition: "needsReview",
        contact: { status: "confirmed", source: "import" }
      }]
    });
    await gateway.commitContactVCardImport("preview-one", 7n, [{
      entryId: "entry-one", decision: "merge", targetContactId: "contact-one", expectedTargetRevision: 5n,
      organizationDecision: "merge", organizationTargetContactId: "organization-one", expectedOrganizationTargetRevision: 4n
    }], signal);
    await expect(gateway.exportContactsVCard(["contact-one"], signal)).resolves.toEqual({
      text: "BEGIN:VCARD\r\nEND:VCARD\r\n", contactCount: 1, suggestedFileName: "contacts.vcf"
    });

    const expectedMethods = [
      "getContactDirectory", "setContactDirectoryEnabled", "listContacts", "getContact", "findSimilarContacts", "createContact", "updateContact",
      "confirmContact", "deleteContact", "addContactIdentity", "removeContactIdentity", "appendContactEvent",
      "removeContactEvent", "listContactGroups", "createContactGroup", "updateContactGroup", "deleteContactGroup",
      "setContactGroupMembership", "addContactRelation", "updateContactRelation", "removeContactRelation",
      "scanContactDuplicates", "mergeContacts", "previewContactVCardImport", "commitContactVCardImport", "exportContactsVCard"
    ];
    expect(requests.filter((entry) => expectedMethods.includes(entry.method)).map((entry) => entry.method)).toEqual(expectedMethods);
    expect(requests.find((entry) => entry.method === "listContacts")?.input).toMatchObject({
      query: "Ada", kind: ContactKind.PERSON, status: ContactStatus.CONFIRMED, contactGroupId: "group-one", pageSize: 25, pageOffset: 5
    });
    expect(requests.find((entry) => entry.method === "setContactDirectoryEnabled")?.input).toEqual({
      expectedDirectoryRevision: { value: 7n }, enabled: false
    });
    expect(requests.find((entry) => entry.method === "updateContact")?.input).toMatchObject({
      contactId: "contact-one", expectedRevision: { value: 5n }, patch: { aliases: { values: ["A. Lovelace"] }, status: ContactStatus.PENDING }
    });
    expect(requests.find((entry) => entry.method === "mergeContacts")?.input).toEqual({
      targetContactId: "contact-one", expectedTargetRevision: { value: 5n }, mergedContactId: "organization-one", expectedMergedRevision: { value: 4n }
    });
    expect(requests.find((entry) => entry.method === "commitContactVCardImport")?.input).toMatchObject({
      previewId: "preview-one",
      expectedDirectoryRevision: { value: 7n },
      decisions: [{
        entryId: "entry-one",
        targetContactId: "contact-one",
        expectedTargetRevision: { value: 5n },
        organizationTargetContactId: "organization-one",
        expectedOrganizationTargetRevision: { value: 4n }
      }]
    });
    expect(requests.filter((entry) => expectedMethods.includes(entry.method)).every((entry) => entry.signal instanceof AbortSignal && !entry.signal.aborted)).toBe(true);
    gateway.disconnect();
  });
});

function revision(value: bigint) { return { value }; }
function timestamp(seconds: bigint) { return { seconds, nanos: 0 }; }
function directory() { return { format: 1, revision: revision(7n), enabled: true, people: 1, organizations: 1, pending: 1, groups: 1 }; }
function summary(id = "contact-one", kind = ContactKind.PERSON) {
  return {
    contactId: id,
    revision: revision(id === "contact-one" ? 5n : 4n),
    kind,
    displayName: id === "contact-one" ? "Ada Lovelace" : "Analytical Engines",
    aliases: ["Ada"],
    summary: "Computing pioneer",
    status: ContactStatus.CONFIRMED,
    source: ContactSource.MANUAL,
    identityCount: 1,
    createdAt: timestamp(1n),
    updatedAt: timestamp(2n)
  };
}
function group() { return { contactGroupId: "group-one", revision: revision(4n), name: "Pioneers", description: "Computing pioneers", memberCount: 1, createdAt: timestamp(1n), updatedAt: timestamp(2n) }; }
function profile() {
  return {
    summary: summary(), narrative: "Mathematician", agentNotes: "Private note",
    identities: [{ contactIdentityId: "identity-one", contactId: "contact-one", revision: revision(3n), platform: "email", value: "ada@example.test", normalizedValue: "ada@example.test", label: "work", note: "", createdAt: timestamp(1n) }],
    events: [{ contactEventId: "event-one", contactId: "contact-one", revision: revision(3n), date: "1843-01-01", text: "Published notes", source: "archive", createdAt: timestamp(1n) }],
    groups: [group()],
    relations: [{ contactRelationId: "relation-one", revision: revision(3n), fromContactId: "contact-one", toContactId: "organization-one", relation: "works at", note: "Founder", createdAt: timestamp(1n), direction: ContactRelationDirection.OUTGOING, relatedContactId: "organization-one", relatedDisplayName: "Analytical Engines", relatedKind: ContactKind.ORGANIZATION }]
  };
}
function draft() {
  return { kind: "person" as const, displayName: "Ada Lovelace", aliases: ["Ada"], summary: "Computing pioneer", narrative: "", agentNotes: "", status: "confirmed" as const, source: "manual" as const, identities: [{ platform: "email", value: "ada@example.test", label: "work", note: "" }] };
}
function candidate() { return { matchType: ContactDuplicateMatchType.NAME, contactId: "contact-one", displayName: "Ada Lovelace", kind: ContactKind.PERSON, status: ContactStatus.CONFIRMED, summary: "Computing pioneer" }; }
function contactResponse(method: string): object {
  if (method === "getSnapshot") return { snapshot: {} };
  if (method === "getContactDirectory" || method === "setContactDirectoryEnabled" || method === "deleteContact" || method === "deleteContactGroup") return { directory: directory() };
  if (method === "listContacts") return { contacts: [summary()], total: 1 };
  if (method === "getContact") return { contact: profile() };
  if (method === "findSimilarContacts") return { candidates: [candidate()] };
  if (method === "listContactGroups") return { groups: [group()] };
  if (method === "createContactGroup" || method === "updateContactGroup") return { group: group(), directory: directory() };
  if (["createContact", "updateContact", "confirmContact", "addContactIdentity", "removeContactIdentity", "appendContactEvent", "removeContactEvent", "setContactGroupMembership", "addContactRelation", "updateContactRelation", "removeContactRelation"].includes(method)) return { contact: profile(), candidates: [], directory: directory() };
  if (method === "scanContactDuplicates") return { pairs: [{ first: summary(), second: summary("organization-one", ContactKind.ORGANIZATION) }], directory: directory() };
  if (method === "mergeContacts") return { target: profile(), mergedContactId: "organization-one", movedIdentities: 1, movedEvents: 2, movedRelations: 3, directory: directory() };
  if (method === "previewContactVCardImport") return { previewId: "preview-one", directoryRevision: revision(7n), entries: [{ entryId: "entry-one", contact: {
    kind: ContactKind.PERSON, displayName: "Ada Lovelace", aliases: [], status: ContactStatus.CONFIRMED, source: ContactSource.IMPORT
  }, disposition: ContactVCardImportDisposition.NEEDS_REVIEW, candidates: [candidate()] }], expiresAt: timestamp(60n) };
  if (method === "commitContactVCardImport") return {
    created: 0,
    enriched: 1,
    skipped: 0,
    contactIds: ["contact-one"],
    entries: [{ entryId: "entry-one", displayName: "Ada Lovelace", outcome: ContactVCardImportOutcome.ENRICHED, contactId: "contact-one" }],
    directory: directory()
  };
  if (method === "exportContactsVCard") return { vcardText: "BEGIN:VCARD\r\nEND:VCARD\r\n", contactCount: 1, suggestedFileName: "contacts.vcf" };
  throw new Error(`Unexpected RPC ${method}`);
}
function response(method: any, message: any, stream = false): any { return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message }; }
async function* idleStream(): AsyncIterable<never> { await new Promise<never>(() => undefined); }
