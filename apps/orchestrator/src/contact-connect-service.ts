import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import {
  ContactStoreError,
  type ContactDirectoryState,
  type ContactDraft as StoredContactDraft,
  type ContactDuplicateCandidate as StoredDuplicateCandidate,
  type ContactEventRecord,
  type ContactGroupRecord,
  type ContactIdentityRecord,
  type ContactKind as StoredContactKind,
  type ContactProfileRecord,
  type ContactRelationRecord,
  type ContactSource as StoredContactSource,
  type ContactStatus as StoredContactStatus,
  type ContactSummaryRecord,
  type RelatedContactRecord
} from "@joko/store";

import {
  ContactManager,
  ContactManagerError,
  type ContactVCardImportDecision,
  type ContactVCardImportPreviewEntry
} from "./contact-manager.js";
import { fromProtoRevision, toProtoRevision, toProtoTimestamp } from "./proto-mapper.js";

export function createContactConnectService(
  manager: ContactManager | undefined,
  authenticate: (context: HandlerContext) => unknown
): ServiceImpl<typeof contract.ContactService> {
  const owner = (): ContactManager => {
    if (manager === undefined) throw new ConnectError("Contacts are unavailable.", Code.Unimplemented);
    return manager;
  };
  return {
    getContactDirectory: (_request, context) => {
      authenticate(context);
      return contactRpc(() => create(contract.GetContactDirectoryResponseSchema, { directory: toProtoDirectory(owner().directory()) }));
    },
    setContactDirectoryEnabled: (request, context) => {
      authenticate(context);
      return contactRpc(() => create(contract.SetContactDirectoryEnabledResponseSchema, {
        directory: toProtoDirectory(owner().setEnabled(fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"), request.enabled))
      }));
    },
    listContacts: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const result = owner().list({
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.kind === undefined ? {} : { kind: fromProtoKind(request.kind) }),
          ...(request.status === undefined ? {} : { status: fromProtoStatus(request.status) }),
          ...(request.contactGroupId === undefined ? {} : { groupId: request.contactGroupId }),
          limit: request.pageSize === 0 ? 50 : request.pageSize,
          offset: request.pageOffset
        });
        return create(contract.ListContactsResponseSchema, {
          contacts: result.contacts.map(toProtoSummary),
          total: result.total,
          ...(result.nextOffset === undefined ? {} : { nextPageOffset: result.nextOffset })
        });
      });
    },
    getContact: (request, context) => {
      authenticate(context);
      return contactRpc(() => create(contract.GetContactResponseSchema, { contact: toProtoProfile(owner().get(request.contactId)) }));
    },
    findSimilarContacts: (request, context) => {
      authenticate(context);
      return contactRpc(() => create(contract.FindSimilarContactsResponseSchema, {
        candidates: owner().findSimilar(fromProtoDraft(required(request.contact, "contact"))).map(toProtoCandidate)
      }));
    },
    createContact: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const result = active.create({
          ...fromProtoDraft(required(request.contact, "contact")),
          expectedDirectoryRevision: fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"),
          confirmedNameCandidateIds: request.confirmedNameCandidateIds
        });
        return create(contract.CreateContactResponseSchema, {
          ...(result.contact === undefined ? {} : { contact: toProtoProfile(result.contact) }),
          candidates: result.candidates.map(toProtoCandidate),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    updateContact: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const patch = required(request.patch, "patch");
        const contact = active.update(request.contactId, fromProtoRevision(request.expectedRevision, "expected_revision"), {
          ...(patch.kind === undefined ? {} : { kind: fromProtoKind(patch.kind) }),
          ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
          ...(patch.aliases === undefined ? {} : { aliases: patch.aliases.values }),
          ...(patch.summary === undefined ? {} : { summary: patch.summary }),
          ...(patch.narrative === undefined ? {} : { narrative: patch.narrative }),
          ...(patch.agentNotes === undefined ? {} : { agentNotes: patch.agentNotes }),
          ...(patch.status === undefined ? {} : { status: fromProtoStatus(patch.status) })
        });
        return create(contract.UpdateContactResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    confirmContact: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.confirm(request.contactId, fromProtoRevision(request.expectedRevision, "expected_revision"));
        return create(contract.ConfirmContactResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    deleteContact: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        active.delete(request.contactId, fromProtoRevision(request.expectedRevision, "expected_revision"));
        return create(contract.DeleteContactResponseSchema, { directory: toProtoDirectory(active.directory()) });
      });
    },
    addContactIdentity: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const identity = required(request.identity, "identity");
        const contact = active.addIdentity(request.contactId,
          fromProtoRevision(request.expectedContactRevision, "expected_contact_revision"), {
            platform: identity.platform, value: identity.value, label: identity.label, note: identity.note
          });
        return create(contract.AddContactIdentityResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    removeContactIdentity: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.removeIdentity(request.contactId,
          fromProtoRevision(request.expectedContactRevision, "expected_contact_revision"), request.contactIdentityId);
        return create(contract.RemoveContactIdentityResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    appendContactEvent: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const event = required(request.event, "event");
        const contact = active.appendEvent(request.contactId,
          fromProtoRevision(request.expectedContactRevision, "expected_contact_revision"), {
            date: event.date, text: event.text, source: event.source
          });
        return create(contract.AppendContactEventResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    removeContactEvent: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.removeEvent(request.contactId,
          fromProtoRevision(request.expectedContactRevision, "expected_contact_revision"), request.contactEventId);
        return create(contract.RemoveContactEventResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    listContactGroups: (_request, context) => {
      authenticate(context);
      return contactRpc(() => create(contract.ListContactGroupsResponseSchema, { groups: owner().groups().map(toProtoGroup) }));
    },
    createContactGroup: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const group = active.createGroup(fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"), request.name, request.description);
        return create(contract.CreateContactGroupResponseSchema, { group: toProtoGroup(group), directory: toProtoDirectory(active.directory()) });
      });
    },
    updateContactGroup: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const group = active.updateGroup(request.contactGroupId, fromProtoRevision(request.expectedRevision, "expected_revision"), request.name, request.description);
        return create(contract.UpdateContactGroupResponseSchema, { group: toProtoGroup(group), directory: toProtoDirectory(active.directory()) });
      });
    },
    deleteContactGroup: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        active.deleteGroup(request.contactGroupId, fromProtoRevision(request.expectedRevision, "expected_revision"));
        return create(contract.DeleteContactGroupResponseSchema, { directory: toProtoDirectory(active.directory()) });
      });
    },
    setContactGroupMembership: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.setGroupMembership(request.contactId,
          fromProtoRevision(request.expectedContactRevision, "expected_contact_revision"), request.contactGroupId, request.member);
        return create(contract.SetContactGroupMembershipResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    addContactRelation: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.addRelation({
          fromContactId: request.fromContactId,
          expectedFromRevision: fromProtoRevision(request.expectedFromRevision, "expected_from_revision"),
          toContactId: request.toContactId,
          relation: request.relation,
          note: request.note
        });
        return create(contract.AddContactRelationResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    updateContactRelation: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.updateRelation({
          ownerContactId: request.ownerContactId,
          expectedOwnerRevision: fromProtoRevision(request.expectedOwnerRevision, "expected_owner_revision"),
          relationId: request.contactRelationId,
          expectedRelationRevision: fromProtoRevision(request.expectedRelationRevision, "expected_relation_revision"),
          relation: request.relation,
          note: request.note
        });
        return create(contract.UpdateContactRelationResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    removeContactRelation: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const contact = active.removeRelation(request.ownerContactId,
          fromProtoRevision(request.expectedOwnerRevision, "expected_owner_revision"), request.contactRelationId);
        return create(contract.RemoveContactRelationResponseSchema, { contact: toProtoProfile(contact), directory: toProtoDirectory(active.directory()) });
      });
    },
    scanContactDuplicates: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        return create(contract.ScanContactDuplicatesResponseSchema, {
          pairs: active.duplicates(request.limit === 0 ? 50 : request.limit).map((pair) => create(contract.ContactDuplicatePairSchema, {
            first: toProtoSummary(pair.first), second: toProtoSummary(pair.second)
          })),
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    mergeContacts: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const active = owner();
        const result = active.merge({
          targetContactId: request.targetContactId,
          expectedTargetRevision: fromProtoRevision(request.expectedTargetRevision, "expected_target_revision"),
          mergedContactId: request.mergedContactId,
          expectedMergedRevision: fromProtoRevision(request.expectedMergedRevision, "expected_merged_revision")
        });
        return create(contract.MergeContactsResponseSchema, {
          target: toProtoProfile(result.target),
          mergedContactId: result.mergedContactId,
          movedIdentities: result.movedIdentities,
          movedEvents: result.movedEvents,
          movedRelations: result.movedRelations,
          directory: toProtoDirectory(active.directory())
        });
      });
    },
    previewContactVCardImport: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const preview = owner().previewVCardImport(request.vcardText);
        return create(contract.PreviewContactVCardImportResponseSchema, {
          previewId: preview.previewId,
          directoryRevision: toProtoRevision(preview.directoryRevision),
          entries: preview.entries.map(toProtoImportEntry),
          expiresAt: toProtoTimestamp(preview.expiresAt)
        });
      });
    },
    commitContactVCardImport: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const result = owner().commitVCardImport({
          previewId: request.previewId,
          expectedDirectoryRevision: fromProtoRevision(request.expectedDirectoryRevision, "expected_directory_revision"),
          decisions: request.decisions.map(fromProtoImportDecision)
        });
        return create(contract.CommitContactVCardImportResponseSchema, {
          created: result.created,
          enriched: result.enriched,
          skipped: result.skipped,
          contactIds: [...result.contactIds],
          directory: toProtoDirectory(result.directory),
          entries: result.entries.map((entry) => create(contract.ContactVCardImportEntryResultSchema, {
            entryId: entry.entryId,
            displayName: entry.displayName,
            outcome: entry.outcome === "created" ? contract.ContactVCardImportOutcome.CREATED
              : entry.outcome === "enriched" ? contract.ContactVCardImportOutcome.ENRICHED
                : contract.ContactVCardImportOutcome.SKIPPED,
            ...(entry.contactId === undefined ? {} : { contactId: entry.contactId })
          }))
        });
      });
    },
    exportContactsVCard: (request, context) => {
      authenticate(context);
      return contactRpc(() => {
        const result = owner().exportVCards(request.contactIds);
        return create(contract.ExportContactsVCardResponseSchema, {
          vcardText: result.text,
          contactCount: result.count,
          suggestedFileName: result.suggestedFileName
        });
      });
    }
  };
}

function toProtoDirectory(value: ContactDirectoryState): contract.ContactDirectory {
  return create(contract.ContactDirectorySchema, {
    format: value.format,
    revision: toProtoRevision(value.revision),
    enabled: value.enabled,
    people: value.people,
    organizations: value.organizations,
    pending: value.pending,
    groups: value.groups
  });
}

function toProtoSummary(value: ContactSummaryRecord): contract.ContactSummary {
  return create(contract.ContactSummarySchema, {
    contactId: value.id,
    revision: toProtoRevision(value.revision),
    kind: toProtoKind(value.kind),
    displayName: value.displayName,
    aliases: [...value.aliases],
    summary: value.summary,
    status: toProtoStatus(value.status),
    source: toProtoSource(value.source),
    identityCount: value.identityCount,
    createdAt: toProtoTimestamp(value.createdAt),
    updatedAt: toProtoTimestamp(value.updatedAt)
  });
}

function toProtoProfile(value: ContactProfileRecord): contract.ContactProfile {
  return create(contract.ContactProfileSchema, {
    summary: toProtoSummary(value),
    narrative: value.narrative,
    agentNotes: value.agentNotes,
    identities: value.identities.map(toProtoIdentity),
    events: value.events.map(toProtoEvent),
    groups: value.groups.map(toProtoGroup),
    relations: value.relations.map(toProtoRelation)
  });
}

function toProtoIdentity(value: ContactIdentityRecord): contract.ContactIdentity {
  return create(contract.ContactIdentitySchema, {
    contactIdentityId: value.id,
    contactId: value.contactId,
    revision: toProtoRevision(value.revision),
    platform: value.platform,
    value: value.value,
    normalizedValue: value.normalizedValue,
    label: value.label,
    note: value.note,
    createdAt: toProtoTimestamp(value.createdAt)
  });
}

function toProtoEvent(value: ContactEventRecord): contract.ContactEvent {
  return create(contract.ContactEventSchema, {
    contactEventId: value.id,
    contactId: value.contactId,
    revision: toProtoRevision(value.revision),
    date: value.date,
    text: value.text,
    source: value.source,
    createdAt: toProtoTimestamp(value.createdAt)
  });
}

function toProtoGroup(value: ContactGroupRecord): contract.ContactGroup {
  return create(contract.ContactGroupSchema, {
    contactGroupId: value.id,
    revision: toProtoRevision(value.revision),
    name: value.name,
    description: value.description,
    memberCount: value.memberCount,
    createdAt: toProtoTimestamp(value.createdAt),
    updatedAt: toProtoTimestamp(value.updatedAt)
  });
}

function toProtoRelation(value: RelatedContactRecord | ContactRelationRecord): contract.ContactRelation {
  const related = "direction" in value ? value : undefined;
  return create(contract.ContactRelationSchema, {
    contactRelationId: value.id,
    revision: toProtoRevision(value.revision),
    fromContactId: value.fromContactId,
    toContactId: value.toContactId,
    relation: value.relation,
    note: value.note,
    createdAt: toProtoTimestamp(value.createdAt),
    ...(related === undefined ? {} : {
      direction: related.direction === "outgoing"
        ? contract.ContactRelationDirection.OUTGOING : contract.ContactRelationDirection.INCOMING,
      relatedContactId: related.relatedContactId,
      relatedDisplayName: related.relatedDisplayName,
      relatedKind: toProtoKind(related.relatedKind)
    })
  });
}

function toProtoCandidate(value: StoredDuplicateCandidate): contract.ContactDuplicateCandidate {
  return create(contract.ContactDuplicateCandidateSchema, {
    matchType: value.matchType === "identity"
      ? contract.ContactDuplicateMatchType.IDENTITY : contract.ContactDuplicateMatchType.NAME,
    contactId: value.contactId,
    displayName: value.displayName,
    kind: toProtoKind(value.kind),
    status: toProtoStatus(value.status),
    summary: value.summary,
    ...(value.matchedPlatform === undefined ? {} : { matchedPlatform: value.matchedPlatform }),
    ...(value.matchedValue === undefined ? {} : { matchedValue: value.matchedValue })
  });
}

function toProtoImportEntry(value: ContactVCardImportPreviewEntry): contract.ContactVCardImportPreviewEntry {
  return create(contract.ContactVCardImportPreviewEntrySchema, {
    entryId: value.entryId,
    contact: toProtoDraft(value.contact),
    disposition: value.disposition === "create" ? contract.ContactVCardImportDisposition.CREATE
      : value.disposition === "auto_enrich" ? contract.ContactVCardImportDisposition.AUTO_ENRICH
        : contract.ContactVCardImportDisposition.NEEDS_REVIEW,
    ...(value.existingContactId === undefined ? {} : { existingContactId: value.existingContactId }),
    candidates: value.candidates.map(toProtoCandidate),
    ...(value.existingEntryId === undefined ? {} : { existingEntryId: value.existingEntryId }),
    similarEntryIds: [...value.similarEntryIds],
    ...(value.organizationName === undefined ? {} : { organizationName: value.organizationName }),
    ...(value.title === undefined ? {} : { title: value.title }),
    groups: [...value.groups],
    ...(value.organizationContactId === undefined ? {} : { organizationContactId: value.organizationContactId }),
    organizationCandidates: value.organizationCandidates.map(toProtoCandidate)
  });
}

function toProtoDraft(value: StoredContactDraft): contract.ContactDraft {
  return create(contract.ContactDraftSchema, {
    kind: toProtoKind(value.kind),
    displayName: value.displayName,
    aliases: [...(value.aliases ?? [])],
    summary: value.summary ?? "",
    narrative: value.narrative ?? "",
    agentNotes: value.agentNotes ?? "",
    status: value.status === undefined ? contract.ContactStatus.CONFIRMED : toProtoStatus(value.status),
    source: value.source === undefined ? contract.ContactSource.IMPORT : toProtoSource(value.source),
    identities: (value.identities ?? []).map((identity) => create(contract.ContactIdentityInputSchema, {
      platform: identity.platform,
      value: identity.value,
      label: identity.label ?? "",
      note: identity.note ?? ""
    }))
  });
}

function fromProtoDraft(value: contract.ContactDraft): StoredContactDraft {
  return {
    kind: fromProtoKind(value.kind),
    displayName: value.displayName,
    aliases: value.aliases,
    summary: value.summary,
    narrative: value.narrative,
    agentNotes: value.agentNotes,
    ...(value.status === contract.ContactStatus.UNSPECIFIED ? {} : { status: fromProtoStatus(value.status) }),
    ...(value.source === contract.ContactSource.UNSPECIFIED ? {} : { source: fromProtoSource(value.source) }),
    identities: value.identities.map((identity) => ({
      platform: identity.platform,
      value: identity.value,
      label: identity.label,
      note: identity.note
    }))
  };
}

function fromProtoImportDecision(value: contract.ContactVCardImportDecision): ContactVCardImportDecision {
  return {
    entryId: value.entryId,
    decision: fromProtoDecision(value.decision),
    ...(value.targetContactId === undefined ? {} : { targetContactId: value.targetContactId }),
    ...(value.expectedTargetRevision === undefined ? {} : { expectedTargetRevision: fromProtoRevision(value.expectedTargetRevision) }),
    ...(value.targetEntryId === undefined ? {} : { targetEntryId: value.targetEntryId }),
    confirmedNameCandidateIds: value.confirmedNameCandidateIds,
    ...(value.organizationDecision === undefined ? {} : { organizationDecision: fromProtoDecision(value.organizationDecision) }),
    ...(value.organizationTargetContactId === undefined ? {} : { organizationTargetContactId: value.organizationTargetContactId }),
    ...(value.expectedOrganizationTargetRevision === undefined ? {} : {
      expectedOrganizationTargetRevision: fromProtoRevision(value.expectedOrganizationTargetRevision)
    }),
    ...(value.organizationTargetEntryId === undefined ? {} : { organizationTargetEntryId: value.organizationTargetEntryId }),
    confirmedOrganizationCandidateIds: value.confirmedOrganizationCandidateIds
  };
}

function fromProtoDecision(value: contract.ContactVCardImportDecisionKind): ContactVCardImportDecision["decision"] {
  switch (value) {
    case contract.ContactVCardImportDecisionKind.CREATE: return "create";
    case contract.ContactVCardImportDecisionKind.MERGE: return "merge";
    case contract.ContactVCardImportDecisionKind.SKIP: return "skip";
    default: throw new ConnectError("A vCard import decision is required.", Code.InvalidArgument);
  }
}

function toProtoKind(value: StoredContactKind): contract.ContactKind {
  return value === "person" ? contract.ContactKind.PERSON : contract.ContactKind.ORGANIZATION;
}

function fromProtoKind(value: contract.ContactKind): StoredContactKind {
  if (value === contract.ContactKind.PERSON) return "person";
  if (value === contract.ContactKind.ORGANIZATION) return "organization";
  throw new ConnectError("Contact kind is required.", Code.InvalidArgument);
}

function toProtoStatus(value: StoredContactStatus): contract.ContactStatus {
  return value === "confirmed" ? contract.ContactStatus.CONFIRMED : contract.ContactStatus.PENDING;
}

function fromProtoStatus(value: contract.ContactStatus): StoredContactStatus {
  if (value === contract.ContactStatus.CONFIRMED) return "confirmed";
  if (value === contract.ContactStatus.PENDING) return "pending";
  throw new ConnectError("Contact status is required.", Code.InvalidArgument);
}

function toProtoSource(value: StoredContactSource): contract.ContactSource {
  if (value === "manual") return contract.ContactSource.MANUAL;
  if (value === "agent") return contract.ContactSource.AGENT;
  return contract.ContactSource.IMPORT;
}

function fromProtoSource(value: contract.ContactSource): StoredContactSource {
  if (value === contract.ContactSource.MANUAL) return "manual";
  if (value === contract.ContactSource.AGENT) return "agent";
  if (value === contract.ContactSource.IMPORT) return "import";
  throw new ConnectError("Contact source is invalid.", Code.InvalidArgument);
}

function contactRpc<T>(effect: () => T): T {
  try {
    return effect();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (error instanceof ContactManagerError) {
      throw new ConnectError(error.message, error.code === "CONTACT_IMPORT_INVALID" ? Code.InvalidArgument
        : error.code === "CONTACT_IMPORT_CHANGED" ? Code.Aborted : Code.FailedPrecondition);
    }
    if (error instanceof ContactStoreError) {
      const code = error.code === "CONTACT_INVALID" ? Code.InvalidArgument
        : error.code === "CONTACT_NOT_FOUND" ? Code.NotFound
          : error.code === "CONTACT_CHANGED" || error.code === "CONTACT_DIRECTORY_CHANGED" ? Code.Aborted
            : error.code === "CONTACT_IDENTITY_CONFLICT" || error.code === "CONTACT_ALREADY_EXISTS" ? Code.AlreadyExists
              : Code.Unavailable;
      throw new ConnectError(error.message, code);
    }
    throw new ConnectError("The contact operation failed.", Code.Internal);
  }
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new ConnectError(`${field} is required.`, Code.InvalidArgument);
  return value;
}
