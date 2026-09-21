import { randomUUID } from "node:crypto";

import {
  ContactStore,
  ContactStoreError,
  normalizeContactIdentityValue,
  normalizeContactPlatform,
  type ContactDirectoryState,
  type ContactDraft,
  type ContactDuplicateCandidate,
  type ContactDuplicatePair,
  type ContactEventDraft,
  type ContactGroupRecord,
  type ContactIdentityDraft,
  type ContactKind,
  type ContactListOptions,
  type ContactListResult,
  type ContactMergeResult,
  type ContactPatch,
  type ContactProfileRecord,
  type ContactStatus
} from "@joko/store";

import { parseContactVCards, serializeContactVCards, type ParsedContactVCard } from "./contact-vcard.js";

const MAX_VCARD_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ENTRIES = 2_000;
const MAX_EXPORT_ENTRIES = 2_000;
const MAX_PREVIEWS = 20;
const PREVIEW_LIFETIME_MS = 10 * 60_000;

export type ContactVCardImportDisposition = "create" | "auto_enrich" | "needs_review";
export type ContactVCardImportDecisionKind = "create" | "merge" | "skip";

export interface ContactVCardImportPreviewEntry {
  readonly entryId: string;
  readonly contact: ContactDraft;
  readonly disposition: ContactVCardImportDisposition;
  readonly existingContactId?: string;
  readonly existingEntryId?: string;
  readonly candidates: readonly ContactDuplicateCandidate[];
  readonly similarEntryIds: readonly string[];
  readonly organizationName?: string;
  readonly title?: string;
  readonly groups: readonly string[];
  readonly organizationContactId?: string;
  readonly organizationCandidates: readonly ContactDuplicateCandidate[];
}

export interface ContactVCardImportPreview {
  readonly previewId: string;
  readonly directoryRevision: bigint;
  readonly entries: readonly ContactVCardImportPreviewEntry[];
  readonly expiresAt: number;
}

export interface ContactVCardImportDecision {
  readonly entryId: string;
  readonly decision: ContactVCardImportDecisionKind;
  readonly targetContactId?: string;
  readonly expectedTargetRevision?: bigint;
  readonly targetEntryId?: string;
  readonly confirmedNameCandidateIds?: readonly string[];
  readonly organizationDecision?: ContactVCardImportDecisionKind;
  readonly organizationTargetContactId?: string;
  readonly expectedOrganizationTargetRevision?: bigint;
  readonly organizationTargetEntryId?: string;
  readonly confirmedOrganizationCandidateIds?: readonly string[];
}

export interface ContactVCardImportResult {
  readonly created: number;
  readonly enriched: number;
  readonly skipped: number;
  readonly contactIds: readonly string[];
  readonly entries: readonly ContactVCardImportEntryResult[];
  readonly directory: ContactDirectoryState;
}

export interface ContactVCardImportEntryResult {
  readonly entryId: string;
  readonly displayName: string;
  readonly outcome: "created" | "enriched" | "skipped";
  readonly contactId?: string;
}

export interface ContactVCardExport {
  readonly text: string;
  readonly count: number;
  readonly suggestedFileName: string;
}

export type ContactManagerErrorCode =
  | "CONTACT_IMPORT_INVALID"
  | "CONTACT_IMPORT_EXPIRED"
  | "CONTACT_IMPORT_CHANGED";

export class ContactManagerError extends Error {
  constructor(readonly code: ContactManagerErrorCode, message: string) {
    super(message);
    this.name = "ContactManagerError";
  }
}

export interface ContactManagerOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

/** Orchestrator owner for the node-local Contact authority and portable vCard flow. */
export class ContactManager {
  readonly #previews = new Map<string, ContactVCardImportPreview>();
  readonly #now: () => number;
  readonly #idFactory: () => string;

  constructor(readonly store: ContactStore, options: ContactManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  close(): void {
    this.#previews.clear();
  }

  directory(): ContactDirectoryState { return this.store.directoryState(); }
  setEnabled(expectedRevision: bigint, enabled: boolean): ContactDirectoryState {
    return this.store.setEnabled(expectedRevision, enabled);
  }
  list(options: ContactListOptions): ContactListResult { return this.store.listContacts(options); }
  get(contactId: string): ContactProfileRecord { return this.store.getContact(contactId); }
  findSimilar(contact: ContactDraft): readonly ContactDuplicateCandidate[] { return this.store.findSimilar(contact); }
  create(input: ContactDraft & { readonly expectedDirectoryRevision: bigint; readonly confirmedNameCandidateIds?: readonly string[] }) {
    return this.store.createContact(input);
  }
  update(contactId: string, expectedRevision: bigint, patch: ContactPatch): ContactProfileRecord {
    return this.store.updateContact(contactId, expectedRevision, patch);
  }
  confirm(contactId: string, expectedRevision: bigint): ContactProfileRecord {
    return this.store.updateContact(contactId, expectedRevision, { status: "confirmed" });
  }
  delete(contactId: string, expectedRevision: bigint): boolean { return this.store.deleteContact(contactId, expectedRevision); }
  addIdentity(contactId: string, expectedRevision: bigint, identity: ContactIdentityDraft): ContactProfileRecord {
    return this.store.addIdentity(contactId, expectedRevision, identity);
  }
  removeIdentity(contactId: string, expectedRevision: bigint, identityId: string): ContactProfileRecord {
    return this.store.removeIdentity(contactId, expectedRevision, identityId);
  }
  appendEvent(contactId: string, expectedRevision: bigint, event: ContactEventDraft): ContactProfileRecord {
    return this.store.appendEvent(contactId, expectedRevision, event);
  }
  removeEvent(contactId: string, expectedRevision: bigint, eventId: string): ContactProfileRecord {
    return this.store.removeEvent(contactId, expectedRevision, eventId);
  }
  groups(): readonly ContactGroupRecord[] { return this.store.listGroups(); }
  createGroup(expectedRevision: bigint, name: string, description: string): ContactGroupRecord {
    return this.store.createGroup(expectedRevision, name, description);
  }
  updateGroup(groupId: string, expectedRevision: bigint, name: string, description: string): ContactGroupRecord {
    return this.store.updateGroup(groupId, expectedRevision, name, description);
  }
  deleteGroup(groupId: string, expectedRevision: bigint): boolean { return this.store.deleteGroup(groupId, expectedRevision); }
  setGroupMembership(contactId: string, expectedRevision: bigint, groupId: string, member: boolean): ContactProfileRecord {
    return this.store.setGroupMembership(contactId, expectedRevision, groupId, member);
  }
  addRelation(input: Parameters<ContactStore["addRelation"]>[0]): ContactProfileRecord { return this.store.addRelation(input); }
  updateRelation(input: Parameters<ContactStore["updateRelation"]>[0]): ContactProfileRecord { return this.store.updateRelation(input); }
  removeRelation(contactId: string, expectedRevision: bigint, relationId: string): ContactProfileRecord {
    return this.store.removeRelation(contactId, expectedRevision, relationId);
  }
  duplicates(limit: number): readonly ContactDuplicatePair[] { return this.store.scanDuplicates(limit); }
  merge(input: Parameters<ContactStore["mergeContacts"]>[0]): ContactMergeResult { return this.store.mergeContacts(input); }

  previewVCardImport(text: string): ContactVCardImportPreview {
    if (typeof text !== "string" || text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_VCARD_BYTES) {
      throw importInvalid("The vCard file is empty or exceeds the 2 MiB import limit.");
    }
    const parsed = parseContactVCards(text);
    if (parsed.length === 0) throw importInvalid("The file does not contain a usable vCard.");
    if (parsed.length > MAX_IMPORT_ENTRIES) throw importInvalid("The vCard import exceeds the 2,000 contact limit.");
    this.#prunePreviews();
    if (this.#previews.size >= MAX_PREVIEWS) {
      const oldest = [...this.#previews.values()].sort((left, right) => left.expiresAt - right.expiresAt)[0];
      if (oldest !== undefined) this.#previews.delete(oldest.previewId);
    }

    const entries: ContactVCardImportPreviewEntry[] = [];
    const stagedIdentities = new Map<string, string>();
    for (const [index, card] of parsed.entries()) {
      const entryId = `vcard-entry-${index + 1}`;
      const candidates = this.store.findSimilar(card.draft);
      const existingIdentityIds = unique(candidates.filter((candidate) => candidate.matchType === "identity")
        .map((candidate) => candidate.contactId));
      const stagedIdentityIds = unique((card.draft.identities ?? []).map((identity) => stagedIdentities.get(identityKey(identity)))
        .filter((value): value is string => value !== undefined));
      const identityOwners = [...existingIdentityIds.map((id) => ({ kind: "contact" as const, id })),
        ...stagedIdentityIds.map((id) => ({ kind: "entry" as const, id }))];
      const similarEntryIds = entries.filter((entry) => namesSimilar(card.draft, entry.contact)).map((entry) => entry.entryId);
      const nameCandidates = candidates.filter((candidate) => candidate.matchType === "name");
      const disposition: ContactVCardImportDisposition = identityOwners.length === 1
        ? "auto_enrich"
        : identityOwners.length > 1 || nameCandidates.length > 0 || similarEntryIds.length > 0
          ? "needs_review"
          : "create";
      const organization = this.#organizationPreview(card.organizationName);
      const entry: ContactVCardImportPreviewEntry = {
        entryId,
        contact: card.draft,
        disposition,
        ...(identityOwners[0]?.kind === "contact" && identityOwners.length === 1 ? { existingContactId: identityOwners[0].id } : {}),
        ...(identityOwners[0]?.kind === "entry" && identityOwners.length === 1 ? { existingEntryId: identityOwners[0].id } : {}),
        candidates,
        similarEntryIds,
        ...(card.organizationName === undefined ? {} : { organizationName: card.organizationName }),
        ...(card.title === undefined ? {} : { title: card.title }),
        groups: card.groups,
        ...(organization.contactId === undefined ? {} : { organizationContactId: organization.contactId }),
        organizationCandidates: organization.candidates
      };
      entries.push(entry);
      for (const identity of card.draft.identities ?? []) {
        if (!stagedIdentities.has(identityKey(identity))) stagedIdentities.set(identityKey(identity), entryId);
      }
    }
    const now = this.#now();
    const preview: ContactVCardImportPreview = Object.freeze({
      previewId: `contact-import-${this.#idFactory()}`,
      directoryRevision: this.store.directoryState().revision,
      entries: Object.freeze(entries),
      expiresAt: now + PREVIEW_LIFETIME_MS
    });
    this.#previews.set(preview.previewId, preview);
    return preview;
  }

  commitVCardImport(input: {
    readonly previewId: string;
    readonly expectedDirectoryRevision: bigint;
    readonly decisions: readonly ContactVCardImportDecision[];
  }): ContactVCardImportResult {
    this.#prunePreviews();
    const preview = this.#previews.get(input.previewId);
    if (preview === undefined) throw new ContactManagerError("CONTACT_IMPORT_EXPIRED", "The vCard import preview expired. Preview the file again.");
    if (preview.directoryRevision !== input.expectedDirectoryRevision
      || this.store.directoryState().revision !== input.expectedDirectoryRevision) {
      throw new ContactManagerError("CONTACT_IMPORT_CHANGED", "Contacts changed after the vCard preview. Preview the file again.");
    }
    const decisions = decisionMap(input.decisions, preview.entries);
    this.#preflightDecisions(preview, decisions);

    const result = this.store.runInTransaction(() => {
      const resolvedEntries = new Map<string, string>();
      const contactIds = new Set<string>();
      const entryResults: ContactVCardImportEntryResult[] = [];
      let created = 0;
      let enriched = 0;
      let skipped = 0;
      for (const entry of preview.entries) {
        const decision = decisions.get(entry.entryId);
        let contact: ContactProfileRecord | undefined;
        const action = entry.disposition === "needs_review" ? decision!.decision : entry.disposition === "create" ? "create" : "merge";
        if (action === "skip") {
          skipped += 1;
          entryResults.push({ entryId: entry.entryId, displayName: entry.contact.displayName, outcome: "skipped" });
          continue;
        }
        let outcome: ContactVCardImportEntryResult["outcome"];
        if (action === "merge") {
          const targetId = decision?.targetContactId ?? entry.existingContactId
            ?? resolvedEntryId(decision?.targetEntryId ?? entry.existingEntryId, resolvedEntries, "contact import target");
          contact = this.#enrich(targetId, entry.contact);
          enriched += 1;
          outcome = "enriched";
        } else {
          const currentCandidates = this.store.findSimilar(entry.contact);
          const exact = unique(currentCandidates.filter((candidate) => candidate.matchType === "identity")
            .map((candidate) => candidate.contactId));
          if (exact.length === 1) {
            contact = this.#enrich(exact[0]!, entry.contact);
            enriched += 1;
            outcome = "enriched";
          } else if (exact.length > 1) {
            throw importInvalid("A vCard entry now resolves to more than one exact identity.");
          } else {
            const confirmed = unique([
              ...(decision?.confirmedNameCandidateIds ?? []),
              ...entry.candidates.filter((candidate) => candidate.matchType === "name").map((candidate) => candidate.contactId),
              ...entry.similarEntryIds.map((id) => resolvedEntries.get(id)).filter((id): id is string => id !== undefined),
              ...currentCandidates.filter((candidate) => candidate.matchType === "name").map((candidate) => candidate.contactId)
            ]);
            const createdContact = this.store.createContact({
              ...entry.contact,
              expectedDirectoryRevision: this.store.directoryState().revision,
              confirmedNameCandidateIds: confirmed
            });
            if (createdContact.contact === undefined) throw importInvalid("A vCard entry requires a new duplicate review.");
            contact = createdContact.contact;
            created += 1;
            outcome = "created";
          }
        }
        resolvedEntries.set(entry.entryId, contact.id);
        contact = this.#applyImportedOrganization(contact, entry, decision, resolvedEntries);
        contact = this.#applyImportedGroups(contact, entry.groups);
        contactIds.add(contact.id);
        entryResults.push({
          entryId: entry.entryId,
          displayName: entry.contact.displayName,
          outcome,
          contactId: contact.id
        });
      }
      return { created, enriched, skipped, contactIds: [...contactIds], entries: entryResults };
    });
    this.#previews.delete(preview.previewId);
    return { ...result, directory: this.store.directoryState() };
  }

  exportVCards(contactIds: readonly string[]): ContactVCardExport {
    if (!Array.isArray(contactIds) || contactIds.length > MAX_EXPORT_ENTRIES) {
      throw importInvalid("The vCard export exceeds the 2,000 contact limit.");
    }
    const ids = unique(contactIds);
    if (ids.length !== contactIds.length) throw importInvalid("The vCard export contains duplicate contact IDs.");
    const profiles = ids.length === 0 ? this.store.allContacts() : ids.map((id) => this.store.getContact(id));
    if (profiles.length > MAX_EXPORT_ENTRIES) throw importInvalid("The vCard export exceeds the 2,000 contact limit.");
    const date = new Date(this.#now()).toISOString().slice(0, 10);
    return { text: serializeContactVCards(profiles), count: profiles.length, suggestedFileName: `joko-contacts-${date}.vcf` };
  }

  #organizationPreview(name: string | undefined): {
    readonly contactId?: string;
    readonly candidates: readonly ContactDuplicateCandidate[];
  } {
    if (name === undefined) return { candidates: [] };
    const candidates = this.store.findSimilar({ kind: "organization", displayName: name, source: "import" })
      .filter((candidate) => candidate.kind === "organization");
    const exact = candidates.find((candidate) => folded(candidate.displayName) === folded(name));
    return exact === undefined
      ? { candidates: candidates.filter((candidate) => candidate.matchType === "name") }
      : { contactId: exact.contactId, candidates: [] };
  }

  #preflightDecisions(
    preview: ContactVCardImportPreview,
    decisions: ReadonlyMap<string, ContactVCardImportDecision>
  ): void {
    for (const entry of preview.entries) {
      const decision = decisions.get(entry.entryId);
      if (entry.disposition === "needs_review" && decision === undefined) {
        throw importInvalid(`The vCard entry ${entry.entryId} requires a duplicate decision.`);
      }
      if (decision?.decision === "merge") {
        if ((decision.targetContactId === undefined) === (decision.targetEntryId === undefined)) {
          throw importInvalid(`The vCard entry ${entry.entryId} requires exactly one merge target.`);
        }
        if (decision.targetContactId !== undefined) {
          const target = this.store.getContact(decision.targetContactId);
          if (decision.expectedTargetRevision === undefined || target.revision !== decision.expectedTargetRevision) {
            throw new ContactManagerError("CONTACT_IMPORT_CHANGED", "A selected merge target changed after preview.");
          }
        } else if (!isPriorEntry(decision.targetEntryId!, entry.entryId, preview.entries)) {
          throw importInvalid("A vCard merge target entry must precede the current entry.");
        }
      }
      if (entry.organizationCandidates.length > 0 && decision?.decision !== "skip") {
        if (decision?.organizationDecision === undefined) {
          throw importInvalid(`The organization for vCard entry ${entry.entryId} requires a duplicate decision.`);
        }
        if (decision.organizationDecision === "merge") {
          if ((decision.organizationTargetContactId === undefined) === (decision.organizationTargetEntryId === undefined)) {
            throw importInvalid("An imported organization requires exactly one merge target.");
          }
          if (decision.organizationTargetContactId !== undefined) {
            const target = this.store.getContact(decision.organizationTargetContactId);
            if (target.kind !== "organization") throw importInvalid("An organization merge target must be an organization.");
            if (decision.expectedOrganizationTargetRevision === undefined
              || target.revision !== decision.expectedOrganizationTargetRevision) {
              throw new ContactManagerError("CONTACT_IMPORT_CHANGED", "A selected organization changed after preview.");
            }
          }
        }
      }
    }
  }

  #enrich(contactId: string, draft: ContactDraft): ContactProfileRecord {
    let current = this.store.getContact(contactId);
    const aliases = uniqueNames([
      ...current.aliases,
      ...(folded(current.displayName) === folded(draft.displayName) ? [] : [draft.displayName]),
      ...(draft.aliases ?? [])
    ], current.displayName).slice(0, 20);
    const patch: ContactPatch = {
      ...(sameFoldedNames(aliases, current.aliases) ? {} : { aliases }),
      ...(current.summary === "" && draft.summary !== undefined && draft.summary !== "" ? { summary: draft.summary } : {}),
      ...(current.narrative === "" && draft.narrative !== undefined && draft.narrative !== "" ? { narrative: draft.narrative } : {}),
      ...(current.agentNotes === "" && draft.agentNotes !== undefined && draft.agentNotes !== "" ? { agentNotes: draft.agentNotes } : {}),
      ...(current.status === "pending" && draft.status === "confirmed" ? { status: "confirmed" as ContactStatus } : {})
    };
    if (Object.keys(patch).length > 0) current = this.store.updateContact(current.id, current.revision, patch);
    for (const identity of draft.identities ?? []) {
      const owner = this.store.findContactByIdentity(identity.platform, identity.value);
      if (owner?.id === current.id) continue;
      if (owner !== undefined) continue;
      try {
        current = this.store.addIdentity(current.id, current.revision, identity);
      } catch (error) {
        if (!(error instanceof ContactStoreError && error.code === "CONTACT_IDENTITY_CONFLICT")) throw error;
      }
    }
    return current;
  }

  #applyImportedOrganization(
    contact: ContactProfileRecord,
    entry: ContactVCardImportPreviewEntry,
    decision: ContactVCardImportDecision | undefined,
    resolvedEntries: ReadonlyMap<string, string>
  ): ContactProfileRecord {
    if (entry.organizationName === undefined || contact.kind === "organization") return contact;
    const orgAction = entry.organizationCandidates.length === 0 ? "create" : decision?.organizationDecision;
    if (orgAction === "skip") return contact;
    let organization: ContactProfileRecord;
    const exact = entry.organizationContactId === undefined ? undefined : this.store.getContact(entry.organizationContactId);
    if (exact !== undefined) organization = exact;
    else if (orgAction === "merge") {
      const targetId = decision?.organizationTargetContactId
        ?? resolvedEntryId(decision?.organizationTargetEntryId, resolvedEntries, "organization import target");
      organization = this.store.getContact(targetId);
      if (organization.kind !== "organization") throw importInvalid("An imported organization target is not an organization.");
    } else {
      const current = this.#organizationPreview(entry.organizationName);
      if (current.contactId !== undefined) organization = this.store.getContact(current.contactId);
      else {
        const confirmed = unique([
          ...(decision?.confirmedOrganizationCandidateIds ?? []),
          ...entry.organizationCandidates.map((candidate) => candidate.contactId),
          ...current.candidates.map((candidate) => candidate.contactId)
        ]);
        const created = this.store.createContact({
          expectedDirectoryRevision: this.store.directoryState().revision,
          confirmedNameCandidateIds: confirmed,
          kind: "organization",
          displayName: entry.organizationName,
          source: "import"
        }).contact;
        if (created === undefined) throw importInvalid("An imported organization requires a new duplicate review.");
        organization = created;
      }
    }
    contact = this.store.getContact(contact.id);
    const exists = contact.relations.some((relation) => relation.direction === "outgoing"
      && relation.relatedContactId === organization.id && relation.relation === "works at");
    if (exists) return contact;
    return this.store.addRelation({
      fromContactId: contact.id,
      expectedFromRevision: contact.revision,
      toContactId: organization.id,
      relation: "works at",
      ...(entry.title === undefined ? {} : { note: entry.title })
    });
  }

  #applyImportedGroups(contact: ContactProfileRecord, names: readonly string[]): ContactProfileRecord {
    let current = contact;
    for (const name of names) {
      try {
        let group = this.store.listGroups().find((candidate) => folded(candidate.name) === folded(name));
        group ??= this.store.createGroup(this.store.directoryState().revision, name);
        if (!current.groups.some((candidate) => candidate.id === group.id)) {
          current = this.store.setGroupMembership(current.id, current.revision, group.id, true);
        }
      } catch (error) {
        if (!(error instanceof ContactStoreError && ["CONTACT_INVALID", "CONTACT_ALREADY_EXISTS"].includes(error.code))) throw error;
      }
    }
    return current;
  }

  #prunePreviews(): void {
    const now = this.#now();
    for (const [id, preview] of this.#previews) if (preview.expiresAt <= now) this.#previews.delete(id);
  }
}

function decisionMap(
  values: readonly ContactVCardImportDecision[],
  entries: readonly ContactVCardImportPreviewEntry[]
): ReadonlyMap<string, ContactVCardImportDecision> {
  if (!Array.isArray(values) || values.length > entries.length) throw importInvalid("The vCard import decisions are invalid.");
  const entryIds = new Set(entries.map((entry) => entry.entryId));
  const result = new Map<string, ContactVCardImportDecision>();
  for (const value of values) {
    if (!entryIds.has(value.entryId) || result.has(value.entryId)) throw importInvalid("The vCard import decisions are invalid.");
    result.set(value.entryId, value);
  }
  return result;
}

function resolvedEntryId(entryId: string | undefined, values: ReadonlyMap<string, string>, label: string): string {
  if (entryId === undefined) throw importInvalid(`The ${label} is missing.`);
  const result = values.get(entryId);
  if (result === undefined) throw importInvalid(`The ${label} is unavailable.`);
  return result;
}

function isPriorEntry(targetId: string, currentId: string, entries: readonly ContactVCardImportPreviewEntry[]): boolean {
  const target = entries.findIndex((entry) => entry.entryId === targetId);
  const current = entries.findIndex((entry) => entry.entryId === currentId);
  return target >= 0 && target < current;
}

function identityKey(identity: ContactIdentityDraft): string {
  const platform = normalizeContactPlatform(identity.platform);
  return `${platform}\0${normalizeContactIdentityValue(identity.value, platform)}`;
}

function namesSimilar(left: ContactDraft, right: ContactDraft): boolean {
  const leftFacets = [left.displayName, ...(left.aliases ?? [])].map(nameFacet);
  const rightFacets = [right.displayName, ...(right.aliases ?? [])].map(nameFacet);
  return leftFacets.some((a) => rightFacets.some((b) => {
    if (a.normalized === "" || b.normalized === "") return false;
    if (a.normalized === b.normalized) return true;
    if (a.cjk || b.cjk) {
      const [shorter, longer] = a.normalized.length <= b.normalized.length ? [a, b] : [b, a];
      if (shorter.cjk && shorter.normalized.length >= 2 && longer.normalized.includes(shorter.normalized)) return true;
    }
    const [small, large] = a.tokens.size <= b.tokens.size ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
    return small.size > 0 && [...small].every((token) => large.has(token));
  }));
}

function nameFacet(value: string): { readonly normalized: string; readonly cjk: boolean; readonly tokens: ReadonlySet<string> } {
  const normalized = folded(value).replace(/[\s·.,_-]+/gu, "");
  return {
    normalized,
    cjk: /[\u3400-\u9fff\uf900-\ufaff]/u.test(normalized),
    tokens: new Set(folded(value).split(/[\s·.,_-]+/gu).filter(Boolean))
  };
}

function uniqueNames(values: readonly string[], excluded: string): readonly string[] {
  const blocked = folded(excluded);
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = folded(value);
    if (key === blocked || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameFoldedNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => folded(value) === folded(right[index]!));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function importInvalid(message: string): ContactManagerError {
  return new ContactManagerError("CONTACT_IMPORT_INVALID", message);
}
