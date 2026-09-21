import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ContactDirectoryState,
  ContactDraft,
  ContactDuplicateCandidate,
  ContactDuplicatePair,
  ContactEventDraft,
  ContactEventRecord,
  ContactGroupRecord,
  ContactIdentityDraft,
  ContactIdentityRecord,
  ContactKind,
  ContactListResult,
  ContactMergeResult,
  ContactPatch,
  ContactProfileRecord,
  ContactRelationRecord,
  ContactSource,
  ContactStatus,
  ContactSummaryRecord,
  RelatedContactRecord
} from "./contact-types.js";
import { ContactStoreError } from "./contact-types.js";

type Row = Record<string, unknown>;

export interface ContactStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface ContactListOptions {
  readonly query?: string;
  readonly kind?: ContactKind;
  readonly status?: ContactStatus;
  readonly groupId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const CONTACT_SCHEMA_VERSION = 1;
const MAX_SAFE_REVISION = 9_007_199_254_740_991;
const MAX_CONTACTS = 50_000;
const MAX_ALIASES = 20;
const MAX_IDENTITIES = 30;
const MAX_EVENTS = 10_000;
const MAX_GROUPS = 1_000;
const MAX_RELATIONS = 10_000;
const MAX_DISPLAY_NAME = 100;
const MAX_SUMMARY = 300;
const MAX_NARRATIVE_BYTES = 16_384;
const MAX_AGENT_NOTES = 1_000;
const MAX_IDENTITY_VALUE = 320;
const MAX_EVENT_TEXT = 1_000;
const MAX_GROUP_NAME = 60;
const MAX_RELATION = 30;
const MAX_NOTE = 1_000;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLATFORM = /^[a-z0-9_-]{1,32}$/u;
const EVENT_DATE = /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const CONTACT_SCHEMA = `
CREATE TABLE contact_schema_version (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  baseline_id TEXT NOT NULL CHECK (length(baseline_id) = 64),
  initialized_at INTEGER NOT NULL CHECK (initialized_at >= 0)
) STRICT;

CREATE TABLE contact_directory (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organization')),
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  narrative TEXT NOT NULL,
  agent_notes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'pending')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'agent', 'import')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE contact_identities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  platform TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(platform, normalized_value)
) STRICT;

CREATE TABLE contact_events (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  event_date TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE contact_groups (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
) STRICT;

CREATE TABLE contact_group_members (
  group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, contact_id)
) STRICT;

CREATE TABLE contact_relations (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  from_contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  to_contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE(from_contact_id, to_contact_id, relation),
  CHECK(from_contact_id <> to_contact_id)
) STRICT;

CREATE VIRTUAL TABLE contact_search_fts USING fts5(
  contact_id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX contacts_updated_idx ON contacts(updated_at DESC, id);
CREATE INDEX contacts_kind_status_idx ON contacts(kind, status, updated_at DESC, id);
CREATE INDEX contact_identities_contact_idx ON contact_identities(contact_id, created_at, id);
CREATE INDEX contact_events_contact_idx ON contact_events(contact_id, event_date DESC, created_at DESC, id);
CREATE INDEX contact_group_members_contact_idx ON contact_group_members(contact_id, group_id);
CREATE INDEX contact_relations_from_idx ON contact_relations(from_contact_id, created_at, id);
CREATE INDEX contact_relations_to_idx ON contact_relations(to_contact_id, created_at, id);
`;

export const CONTACT_SCHEMA_BASELINE_ID = createHash("sha256")
  .update(`contact-v1\n${CONTACT_SCHEMA}`, "utf8").digest("hex");

/** Current-v1, standalone durable Contacts database. No old-shape reader or migration exists. */
export class ContactStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  #writeDepth = 0;
  #closed = false;

  constructor(readonly filePath: string, options: ContactStoreOptions = {}) {
    if (filePath !== ":memory:" && !filePath.startsWith("file:")) {
      mkdirSync(dirname(resolve(filePath)), { recursive: true });
    }
    this.#database = new DatabaseSync(filePath);
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    try {
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;");
      if (filePath !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.#initialize();
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  runInTransaction<T>(callback: () => T): T {
    if (typeof callback !== "function") throw invalid("Contact transaction callback is invalid.");
    return this.#write(callback);
  }

  directoryState(): ContactDirectoryState {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT revision, enabled FROM contact_directory WHERE singleton = 1").get() as Row;
    const counts = this.#database.prepare(`
      SELECT
        SUM(CASE WHEN kind = 'person' THEN 1 ELSE 0 END) AS people,
        SUM(CASE WHEN kind = 'organization' THEN 1 ELSE 0 END) AS organizations,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM contacts
    `).get() as Row;
    const groups = this.#database.prepare("SELECT COUNT(*) AS count FROM contact_groups").get() as Row;
    return {
      format: 1,
      revision: bigint(row["revision"]),
      enabled: integer(row["enabled"]) === 1,
      people: nullableCount(counts["people"]),
      organizations: nullableCount(counts["organizations"]),
      pending: nullableCount(counts["pending"]),
      groups: integer(groups["count"])
    };
  }

  setEnabled(expectedDirectoryRevision: bigint, enabled: boolean): ContactDirectoryState {
    return this.#write(() => {
      this.#assertDirectoryRevision(expectedDirectoryRevision);
      const current = this.directoryState();
      if (current.enabled === enabled) return current;
      const revision = this.#advanceDirectoryRevision();
      this.#database.prepare("UPDATE contact_directory SET enabled = ?, updated_at = ? WHERE singleton = 1")
        .run(enabled ? 1 : 0, this.#now());
      this.#assertRevisionValue(revision);
      return this.directoryState();
    });
  }

  listContacts(options: ContactListOptions = {}): ContactListResult {
    this.#assertOpen();
    const limit = boundedInteger(options.limit ?? 50, 1, 200, "Contact page size");
    const offset = boundedInteger(options.offset ?? 0, 0, MAX_CONTACTS, "Contact page offset");
    const kind = options.kind === undefined ? undefined : contactKind(options.kind);
    const status = options.status === undefined ? undefined : contactStatus(options.status);
    const groupId = options.groupId === undefined ? undefined : entityId(options.groupId, "Contact group ID");
    if (groupId !== undefined) this.#requireGroupRow(groupId);
    const query = options.query?.trim();
    const fts = query === undefined || query === "" ? undefined : contactFtsQuery(query);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (kind !== undefined) { clauses.push("contact.kind = ?"); params.push(kind); }
    if (status !== undefined) { clauses.push("contact.status = ?"); params.push(status); }
    if (groupId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM contact_group_members member WHERE member.contact_id = contact.id AND member.group_id = ?)");
      params.push(groupId);
    }
    if (fts !== undefined) { clauses.push("contact_search_fts MATCH ?"); params.push(fts); }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const join = fts === undefined ? "" : "JOIN contact_search_fts ON contact_search_fts.contact_id = contact.id";
    const totalRow = this.#database.prepare(`SELECT COUNT(*) AS count FROM contacts contact ${join} ${where}`).get(...params) as Row;
    const order = fts === undefined ? "contact.updated_at DESC, contact.id" : "bm25(contact_search_fts), contact.updated_at DESC, contact.id";
    const rows = this.#database.prepare(`
      SELECT contact.*, (SELECT COUNT(*) FROM contact_identities identity WHERE identity.contact_id = contact.id) AS identity_count
      FROM contacts contact ${join} ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Row[];
    const total = integer(totalRow["count"]);
    return {
      contacts: rows.map(contactSummaryFromRow),
      total,
      ...(offset + rows.length < total ? { nextOffset: offset + rows.length } : {})
    };
  }

  getContact(contactId: string): ContactProfileRecord {
    this.#assertOpen();
    const id = entityId(contactId, "Contact ID");
    const row = this.#requireContactRow(id);
    const identities = (this.#database.prepare(`
      SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY created_at, id
    `).all(id) as Row[]).map(contactIdentityFromRow);
    const events = (this.#database.prepare(`
      SELECT * FROM contact_events WHERE contact_id = ? ORDER BY event_date DESC, created_at DESC, id DESC
    `).all(id) as Row[]).map(contactEventFromRow);
    const groups = (this.#database.prepare(`
      SELECT group_value.*, COUNT(all_member.contact_id) AS member_count
      FROM contact_groups group_value
      JOIN contact_group_members owned ON owned.group_id = group_value.id AND owned.contact_id = ?
      LEFT JOIN contact_group_members all_member ON all_member.group_id = group_value.id
      GROUP BY group_value.id ORDER BY group_value.name COLLATE NOCASE, group_value.id
    `).all(id) as Row[]).map(contactGroupFromRow);
    const relations = (this.#database.prepare(`
      SELECT relation_value.*,
        CASE WHEN relation_value.from_contact_id = ? THEN 'outgoing' ELSE 'incoming' END AS direction,
        related.id AS related_contact_id, related.display_name AS related_display_name, related.kind AS related_kind
      FROM contact_relations relation_value
      JOIN contacts related ON related.id = CASE WHEN relation_value.from_contact_id = ?
        THEN relation_value.to_contact_id ELSE relation_value.from_contact_id END
      WHERE relation_value.from_contact_id = ? OR relation_value.to_contact_id = ?
      ORDER BY relation_value.created_at, relation_value.id
    `).all(id, id, id, id) as Row[]).map(relatedContactFromRow);
    return {
      ...contactSummaryFromRow({ ...row, identity_count: identities.length }),
      narrative: string(row["narrative"]),
      agentNotes: string(row["agent_notes"]),
      identities,
      events,
      groups,
      relations
    };
  }

  findSimilar(input: ContactDraft): readonly ContactDuplicateCandidate[] {
    this.#assertOpen();
    const draft = contactDraft(input);
    const results: ContactDuplicateCandidate[] = [];
    const seen = new Set<string>();
    for (const identity of draft.identities) {
      const row = this.#database.prepare(`
        SELECT contact.*, identity.platform AS matched_platform, identity.value AS matched_value
        FROM contact_identities identity JOIN contacts contact ON contact.id = identity.contact_id
        WHERE identity.platform = ? AND identity.normalized_value = ?
      `).get(identity.platform, identity.normalizedValue) as Row | undefined;
      if (row === undefined || seen.has(string(row["id"]))) continue;
      const id = string(row["id"]);
      seen.add(id);
      results.push({
        matchType: "identity",
        contactId: id,
        displayName: string(row["display_name"]),
        kind: contactKind(row["kind"]),
        status: contactStatus(row["status"]),
        summary: string(row["summary"]),
        matchedPlatform: string(row["matched_platform"]),
        matchedValue: string(row["matched_value"])
      });
    }
    const draftNames = nameFacets(draft.displayName, draft.aliases);
    const rows = this.#database.prepare("SELECT id, kind, display_name, aliases_json, status, summary FROM contacts ORDER BY id").all() as Row[];
    for (const row of rows) {
      const id = string(row["id"]);
      if (seen.has(id)) continue;
      if (!facetsSimilar(draftNames, nameFacets(string(row["display_name"]), aliases(row["aliases_json"])))) continue;
      seen.add(id);
      results.push({
        matchType: "name",
        contactId: id,
        displayName: string(row["display_name"]),
        kind: contactKind(row["kind"]),
        status: contactStatus(row["status"]),
        summary: string(row["summary"])
      });
    }
    return results;
  }

  createContact(input: ContactDraft & {
    readonly expectedDirectoryRevision: bigint;
    readonly confirmedNameCandidateIds?: readonly string[];
  }): { readonly contact?: ContactProfileRecord; readonly candidates: readonly ContactDuplicateCandidate[] } {
    return this.#write(() => {
      this.#assertDirectoryRevision(input.expectedDirectoryRevision);
      if (this.#count("contacts") >= MAX_CONTACTS) throw invalid("The contact directory is full.");
      const draft = contactDraft(input);
      const candidates = this.findSimilar(draft);
      const identity = candidates.find((candidate) => candidate.matchType === "identity");
      if (identity !== undefined) {
        throw new ContactStoreError("CONTACT_IDENTITY_CONFLICT", "An exact identity already belongs to another contact.", identity.contactId);
      }
      const names = candidates.filter((candidate) => candidate.matchType === "name");
      const confirmed = uniqueEntityIds(input.confirmedNameCandidateIds ?? [], "Confirmed duplicate contact ID");
      const expected = names.map((candidate) => candidate.contactId).sort();
      if (!sameStrings(confirmed, expected)) return { candidates: names };
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      const id = this.#newId("contact");
      this.#database.prepare(`
        INSERT INTO contacts(
          id, revision, kind, display_name, aliases_json, summary, narrative, agent_notes,
          status, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, revision, draft.kind, draft.displayName, JSON.stringify(draft.aliases), draft.summary,
        draft.narrative, draft.agentNotes, draft.status, draft.source, at, at);
      for (const identityDraft of draft.identities) this.#insertIdentity(id, revision, identityDraft, at);
      this.#rebuildSearch(id);
      return { contact: this.getContact(id), candidates: names };
    });
  }

  updateContact(contactId: string, expectedRevision: bigint, patch: ContactPatch): ContactProfileRecord {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const current = this.#requireContactRow(id);
      this.#assertEntityRevision("Contact", id, current, expectedRevision);
      const normalized = contactPatch(patch);
      if (Object.keys(normalized).length === 0) return this.getContact(id);
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      const next = {
        kind: normalized.kind ?? contactKind(current["kind"]),
        displayName: normalized.displayName ?? string(current["display_name"]),
        aliases: normalized.aliases ?? aliases(current["aliases_json"]),
        summary: normalized.summary ?? string(current["summary"]),
        narrative: normalized.narrative ?? string(current["narrative"]),
        agentNotes: normalized.agentNotes ?? string(current["agent_notes"]),
        status: normalized.status ?? contactStatus(current["status"])
      };
      next.aliases = uniqueNames(next.aliases, next.displayName);
      this.#database.prepare(`
        UPDATE contacts SET revision = ?, kind = ?, display_name = ?, aliases_json = ?, summary = ?,
          narrative = ?, agent_notes = ?, status = ?, updated_at = ? WHERE id = ?
      `).run(revision, next.kind, next.displayName, JSON.stringify(next.aliases), next.summary,
        next.narrative, next.agentNotes, next.status, at, id);
      this.#rebuildSearch(id);
      return this.getContact(id);
    });
  }

  deleteContact(contactId: string, expectedRevision: bigint): boolean {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const current = this.#requireContactRow(id);
      this.#assertEntityRevision("Contact", id, current, expectedRevision);
      const groups = (this.#database.prepare("SELECT group_id FROM contact_group_members WHERE contact_id = ?").all(id) as Row[])
        .map((row) => string(row["group_id"]));
      const relatedContacts = (this.#database.prepare(`
        SELECT CASE WHEN from_contact_id = ? THEN to_contact_id ELSE from_contact_id END AS contact_id
        FROM contact_relations WHERE from_contact_id = ? OR to_contact_id = ?
      `).all(id, id, id) as Row[]).map((row) => string(row["contact_id"]));
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      this.#database.prepare("DELETE FROM contact_search_fts WHERE contact_id = ?").run(id);
      const removed = this.#database.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes === 1;
      this.#touchContacts(relatedContacts, revision, at);
      this.#touchGroups(groups, revision, at);
      return removed;
    });
  }

  addIdentity(contactId: string, expectedContactRevision: bigint, input: ContactIdentityDraft): ContactProfileRecord {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const contact = this.#requireContactRow(id);
      this.#assertEntityRevision("Contact", id, contact, expectedContactRevision);
      if (this.#count("contact_identities", "contact_id", id) >= MAX_IDENTITIES) throw invalid("The contact identity limit was reached.");
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      this.#insertIdentity(id, revision, identityDraft(input), at);
      this.#touchContacts([id], revision, at);
      this.#rebuildSearch(id);
      return this.getContact(id);
    });
  }

  removeIdentity(contactId: string, expectedContactRevision: bigint, identityId: string): ContactProfileRecord {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const identity = entityId(identityId, "Contact identity ID");
      const contact = this.#requireContactRow(id);
      this.#assertEntityRevision("Contact", id, contact, expectedContactRevision);
      const row = this.#database.prepare("SELECT id FROM contact_identities WHERE id = ? AND contact_id = ?").get(identity, id);
      if (row === undefined) throw notFound("Contact identity", identity);
      const revision = this.#advanceDirectoryRevision();
      this.#database.prepare("DELETE FROM contact_identities WHERE id = ? AND contact_id = ?").run(identity, id);
      this.#touchContacts([id], revision, this.#now());
      this.#rebuildSearch(id);
      return this.getContact(id);
    });
  }

  appendEvent(contactId: string, expectedContactRevision: bigint, input: ContactEventDraft): ContactProfileRecord {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const contact = this.#requireContactRow(id);
      this.#assertEntityRevision("Contact", id, contact, expectedContactRevision);
      if (this.#count("contact_events", "contact_id", id) >= MAX_EVENTS) throw invalid("The contact event limit was reached.");
      const draft = eventDraft(input);
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      this.#database.prepare(`
        INSERT INTO contact_events(id, contact_id, revision, event_date, text, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.#newId("contact_event"), id, revision, draft.date, draft.text, draft.source, at);
      this.#touchContacts([id], revision, at);
      this.#rebuildSearch(id);
      return this.getContact(id);
    });
  }

  removeEvent(contactId: string, expectedContactRevision: bigint, eventId: string): ContactProfileRecord {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const event = entityId(eventId, "Contact event ID");
      const contact = this.#requireContactRow(id);
      this.#assertEntityRevision("Contact", id, contact, expectedContactRevision);
      if (this.#database.prepare("SELECT id FROM contact_events WHERE id = ? AND contact_id = ?").get(event, id) === undefined) {
        throw notFound("Contact event", event);
      }
      const revision = this.#advanceDirectoryRevision();
      this.#database.prepare("DELETE FROM contact_events WHERE id = ? AND contact_id = ?").run(event, id);
      this.#touchContacts([id], revision, this.#now());
      this.#rebuildSearch(id);
      return this.getContact(id);
    });
  }

  listGroups(): readonly ContactGroupRecord[] {
    this.#assertOpen();
    return (this.#database.prepare(`
      SELECT group_value.*, COUNT(member.contact_id) AS member_count
      FROM contact_groups group_value LEFT JOIN contact_group_members member ON member.group_id = group_value.id
      GROUP BY group_value.id ORDER BY group_value.name COLLATE NOCASE, group_value.id
    `).all() as Row[]).map(contactGroupFromRow);
  }

  createGroup(expectedDirectoryRevision: bigint, nameValue: string, descriptionValue = ""): ContactGroupRecord {
    return this.#write(() => {
      this.#assertDirectoryRevision(expectedDirectoryRevision);
      if (this.#count("contact_groups") >= MAX_GROUPS) throw invalid("The contact group limit was reached.");
      const name = text(nameValue, 1, MAX_GROUP_NAME, "Contact group name");
      const description = text(descriptionValue, 0, MAX_SUMMARY, "Contact group description");
      if (this.#database.prepare("SELECT id FROM contact_groups WHERE name = ? COLLATE NOCASE").get(name) !== undefined) {
        throw new ContactStoreError("CONTACT_ALREADY_EXISTS", "A contact group with this name already exists.");
      }
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      const id = this.#newId("contact_group");
      this.#database.prepare(`
        INSERT INTO contact_groups(id, revision, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, revision, name, description, at, at);
      return contactGroupFromRow({ ...this.#requireGroupRow(id), member_count: 0 });
    });
  }

  updateGroup(groupId: string, expectedRevision: bigint, nameValue: string, descriptionValue: string): ContactGroupRecord {
    return this.#write(() => {
      const id = entityId(groupId, "Contact group ID");
      const current = this.#requireGroupRow(id);
      this.#assertEntityRevision("Contact group", id, current, expectedRevision);
      const name = text(nameValue, 1, MAX_GROUP_NAME, "Contact group name");
      const description = text(descriptionValue, 0, MAX_SUMMARY, "Contact group description");
      const duplicate = this.#database.prepare("SELECT id FROM contact_groups WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, id);
      if (duplicate !== undefined) throw new ContactStoreError("CONTACT_ALREADY_EXISTS", "A contact group with this name already exists.");
      const revision = this.#advanceDirectoryRevision();
      this.#database.prepare("UPDATE contact_groups SET revision = ?, name = ?, description = ?, updated_at = ? WHERE id = ?")
        .run(revision, name, description, this.#now(), id);
      return this.listGroups().find((group) => group.id === id)!;
    });
  }

  deleteGroup(groupId: string, expectedRevision: bigint): boolean {
    return this.#write(() => {
      const id = entityId(groupId, "Contact group ID");
      const current = this.#requireGroupRow(id);
      this.#assertEntityRevision("Contact group", id, current, expectedRevision);
      const contacts = (this.#database.prepare("SELECT contact_id FROM contact_group_members WHERE group_id = ?").all(id) as Row[])
        .map((row) => string(row["contact_id"]));
      const revision = this.#advanceDirectoryRevision();
      const removed = this.#database.prepare("DELETE FROM contact_groups WHERE id = ?").run(id).changes === 1;
      this.#touchContacts(contacts, revision, this.#now());
      return removed;
    });
  }

  setGroupMembership(contactId: string, expectedContactRevision: bigint, groupId: string, member: boolean): ContactProfileRecord {
    return this.#write(() => {
      const id = entityId(contactId, "Contact ID");
      const group = entityId(groupId, "Contact group ID");
      const contact = this.#requireContactRow(id);
      this.#requireGroupRow(group);
      this.#assertEntityRevision("Contact", id, contact, expectedContactRevision);
      const exists = this.#database.prepare("SELECT 1 AS present FROM contact_group_members WHERE group_id = ? AND contact_id = ?")
        .get(group, id) !== undefined;
      if (exists === member) return this.getContact(id);
      const revision = this.#advanceDirectoryRevision();
      if (member) this.#database.prepare("INSERT INTO contact_group_members(group_id, contact_id) VALUES (?, ?)").run(group, id);
      else this.#database.prepare("DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?").run(group, id);
      const at = this.#now();
      this.#database.prepare("UPDATE contact_groups SET revision = ?, updated_at = ? WHERE id = ?").run(revision, at, group);
      this.#touchContacts([id], revision, at);
      return this.getContact(id);
    });
  }

  addRelation(input: {
    readonly fromContactId: string;
    readonly expectedFromRevision: bigint;
    readonly toContactId: string;
    readonly relation: string;
    readonly note?: string;
  }): ContactProfileRecord {
    return this.#write(() => {
      const from = entityId(input.fromContactId, "Source contact ID");
      const to = entityId(input.toContactId, "Related contact ID");
      if (from === to) throw invalid("A contact cannot relate to itself.");
      const fromRow = this.#requireContactRow(from);
      this.#requireContactRow(to);
      this.#assertEntityRevision("Contact", from, fromRow, input.expectedFromRevision);
      if (this.#count("contact_relations", "from_contact_id", from) + this.#count("contact_relations", "to_contact_id", from) >= MAX_RELATIONS) {
        throw invalid("The contact relation limit was reached.");
      }
      const relation = text(input.relation, 1, MAX_RELATION, "Contact relation");
      const note = text(input.note ?? "", 0, MAX_NOTE, "Contact relation note");
      if (this.#database.prepare(`
        SELECT id FROM contact_relations WHERE from_contact_id = ? AND to_contact_id = ? AND relation = ?
      `).get(from, to, relation) !== undefined) throw new ContactStoreError("CONTACT_ALREADY_EXISTS", "This contact relation already exists.");
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      this.#database.prepare(`
        INSERT INTO contact_relations(id, revision, from_contact_id, to_contact_id, relation, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this.#newId("contact_relation"), revision, from, to, relation, note, at);
      this.#touchContacts([from, to], revision, at);
      return this.getContact(from);
    });
  }

  updateRelation(input: {
    readonly ownerContactId: string;
    readonly expectedOwnerRevision: bigint;
    readonly relationId: string;
    readonly expectedRelationRevision: bigint;
    readonly relation: string;
    readonly note?: string;
  }): ContactProfileRecord {
    return this.#write(() => {
      const owner = entityId(input.ownerContactId, "Contact ID");
      const relationId = entityId(input.relationId, "Contact relation ID");
      const ownerRow = this.#requireContactRow(owner);
      this.#assertEntityRevision("Contact", owner, ownerRow, input.expectedOwnerRevision);
      const current = this.#database.prepare("SELECT * FROM contact_relations WHERE id = ?").get(relationId) as Row | undefined;
      if (current === undefined || (string(current["from_contact_id"]) !== owner && string(current["to_contact_id"]) !== owner)) {
        throw notFound("Contact relation", relationId);
      }
      this.#assertEntityRevision("Contact relation", relationId, current, input.expectedRelationRevision);
      const relation = text(input.relation, 1, MAX_RELATION, "Contact relation");
      const note = text(input.note ?? "", 0, MAX_NOTE, "Contact relation note");
      const from = string(current["from_contact_id"]);
      const to = string(current["to_contact_id"]);
      const duplicate = this.#database.prepare(`
        SELECT id FROM contact_relations WHERE from_contact_id = ? AND to_contact_id = ? AND relation = ? AND id <> ?
      `).get(from, to, relation, relationId);
      if (duplicate !== undefined) throw new ContactStoreError("CONTACT_ALREADY_EXISTS", "This contact relation already exists.");
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      this.#database.prepare("UPDATE contact_relations SET revision = ?, relation = ?, note = ? WHERE id = ?")
        .run(revision, relation, note, relationId);
      this.#touchContacts([from, to], revision, at);
      return this.getContact(owner);
    });
  }

  removeRelation(ownerContactId: string, expectedOwnerRevision: bigint, relationId: string): ContactProfileRecord {
    return this.#write(() => {
      const owner = entityId(ownerContactId, "Contact ID");
      const relation = entityId(relationId, "Contact relation ID");
      const ownerRow = this.#requireContactRow(owner);
      this.#assertEntityRevision("Contact", owner, ownerRow, expectedOwnerRevision);
      const current = this.#database.prepare("SELECT * FROM contact_relations WHERE id = ?").get(relation) as Row | undefined;
      if (current === undefined || (string(current["from_contact_id"]) !== owner && string(current["to_contact_id"]) !== owner)) {
        throw notFound("Contact relation", relation);
      }
      const revision = this.#advanceDirectoryRevision();
      this.#database.prepare("DELETE FROM contact_relations WHERE id = ?").run(relation);
      this.#touchContacts([string(current["from_contact_id"]), string(current["to_contact_id"])], revision, this.#now());
      return this.getContact(owner);
    });
  }

  scanDuplicates(limitValue = 50): readonly ContactDuplicatePair[] {
    const limit = boundedInteger(limitValue, 1, 100, "Duplicate pair limit");
    const contacts = this.listContacts({ limit: 200, offset: 0 }).contacts;
    const additional: ContactSummaryRecord[] = [];
    for (let offset = contacts.length; offset < Math.min(2_000, this.#count("contacts")); offset += 200) {
      additional.push(...this.listContacts({ limit: 200, offset }).contacts);
    }
    const all = [...contacts, ...additional];
    const prepared = all.map((contact) => ({ contact, facets: nameFacets(contact.displayName, contact.aliases) }));
    const pairs: ContactDuplicatePair[] = [];
    for (let left = 0; left < prepared.length && pairs.length < limit; left += 1) {
      for (let right = left + 1; right < prepared.length && pairs.length < limit; right += 1) {
        if (facetsSimilar(prepared[left]!.facets, prepared[right]!.facets)) {
          pairs.push({ first: prepared[left]!.contact, second: prepared[right]!.contact });
        }
      }
    }
    return pairs;
  }

  mergeContacts(input: {
    readonly targetContactId: string;
    readonly expectedTargetRevision: bigint;
    readonly mergedContactId: string;
    readonly expectedMergedRevision: bigint;
  }): ContactMergeResult {
    return this.#write(() => {
      const targetId = entityId(input.targetContactId, "Target contact ID");
      const sourceId = entityId(input.mergedContactId, "Merged contact ID");
      if (targetId === sourceId) throw invalid("A contact cannot be merged into itself.");
      const target = this.#requireContactRow(targetId);
      const source = this.#requireContactRow(sourceId);
      this.#assertEntityRevision("Target contact", targetId, target, input.expectedTargetRevision);
      this.#assertEntityRevision("Merged contact", sourceId, source, input.expectedMergedRevision);
      const targetAliases = aliases(target["aliases_json"]);
      const sourceAliases = [string(source["display_name"]), ...aliases(source["aliases_json"])];
      const mergedAliases = uniqueNames([...targetAliases, ...sourceAliases], string(target["display_name"]));
      if (mergedAliases.length > MAX_ALIASES) throw invalid("Merge would exceed the contact alias limit.");
      const narrative = mergeText(string(target["narrative"]), string(source["narrative"]), "\n\n---\n\n", MAX_NARRATIVE_BYTES, true);
      const agentNotes = mergeText(string(target["agent_notes"]), string(source["agent_notes"]), "\n", MAX_AGENT_NOTES, false);
      const revision = this.#advanceDirectoryRevision();
      const at = this.#now();
      const identityRows = this.#database.prepare("SELECT id FROM contact_identities WHERE contact_id = ?").all(sourceId) as Row[];
      const eventRows = this.#database.prepare("SELECT id FROM contact_events WHERE contact_id = ?").all(sourceId) as Row[];
      const groupIds = (this.#database.prepare("SELECT group_id FROM contact_group_members WHERE contact_id = ?").all(sourceId) as Row[])
        .map((row) => string(row["group_id"]));
      this.#database.prepare("UPDATE contact_identities SET contact_id = ?, revision = ? WHERE contact_id = ?")
        .run(targetId, revision, sourceId);
      this.#database.prepare("UPDATE contact_events SET contact_id = ?, revision = ? WHERE contact_id = ?")
        .run(targetId, revision, sourceId);
      this.#database.prepare(`
        INSERT OR IGNORE INTO contact_group_members(group_id, contact_id)
        SELECT group_id, ? FROM contact_group_members WHERE contact_id = ?
      `).run(targetId, sourceId);
      this.#database.prepare("DELETE FROM contact_group_members WHERE contact_id = ?").run(sourceId);
      const relationRows = this.#database.prepare(`
        SELECT * FROM contact_relations WHERE from_contact_id = ? OR to_contact_id = ? ORDER BY created_at, id
      `).all(sourceId, sourceId) as Row[];
      const relatedContactIds = relationRows.map((row) => string(row["from_contact_id"]) === sourceId
        ? string(row["to_contact_id"])
        : string(row["from_contact_id"])).filter((id) => id !== targetId && id !== sourceId);
      this.#database.prepare("DELETE FROM contact_relations WHERE from_contact_id = ? OR to_contact_id = ?").run(sourceId, sourceId);
      let movedRelations = 0;
      for (const relationRow of relationRows) {
        const from = string(relationRow["from_contact_id"]) === sourceId ? targetId : string(relationRow["from_contact_id"]);
        const to = string(relationRow["to_contact_id"]) === sourceId ? targetId : string(relationRow["to_contact_id"]);
        if (from === to) continue;
        const relation = string(relationRow["relation"]);
        if (this.#database.prepare(`
          SELECT 1 AS present FROM contact_relations WHERE from_contact_id = ? AND to_contact_id = ? AND relation = ?
        `).get(from, to, relation) !== undefined) continue;
        this.#database.prepare(`
          INSERT INTO contact_relations(id, revision, from_contact_id, to_contact_id, relation, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(string(relationRow["id"]), revision, from, to, relation, string(relationRow["note"]), integer(relationRow["created_at"]));
        movedRelations += 1;
      }
      this.#database.prepare(`
        UPDATE contacts SET revision = ?, aliases_json = ?,
          summary = CASE WHEN summary = '' THEN ? ELSE summary END,
          narrative = ?, agent_notes = ?, status = CASE WHEN status = 'confirmed' OR ? = 'confirmed' THEN 'confirmed' ELSE 'pending' END,
          updated_at = ? WHERE id = ?
      `).run(revision, JSON.stringify(mergedAliases), string(source["summary"]), narrative, agentNotes,
        string(source["status"]), at, targetId);
      this.#database.prepare("DELETE FROM contact_search_fts WHERE contact_id IN (?, ?)").run(targetId, sourceId);
      this.#database.prepare("DELETE FROM contacts WHERE id = ?").run(sourceId);
      this.#touchContacts(relatedContactIds, revision, at);
      this.#touchGroups(groupIds, revision, at);
      this.#rebuildSearch(targetId);
      return {
        target: this.getContact(targetId),
        mergedContactId: sourceId,
        movedIdentities: identityRows.length,
        movedEvents: eventRows.length,
        movedRelations
      };
    });
  }

  allContacts(): readonly ContactProfileRecord[] {
    const result: ContactProfileRecord[] = [];
    for (let offset = 0;; offset += 200) {
      const page = this.listContacts({ limit: 200, offset });
      result.push(...page.contacts.map((contact) => this.getContact(contact.id)));
      if (page.nextOffset === undefined) return result;
    }
  }

  findContactByIdentity(platformValue: string, identityValue: string): ContactProfileRecord | undefined {
    const platform = normalizeContactPlatform(platformValue);
    const normalized = normalizeContactIdentityValue(identityValue, platform);
    const row = this.#database.prepare(`
      SELECT contact_id FROM contact_identities WHERE platform = ? AND normalized_value = ?
    `).get(platform, normalized) as Row | undefined;
    return row === undefined ? undefined : this.getContact(string(row["contact_id"]));
  }

  findIdentitiesByValue(identityValue: string, limitValue = 20): readonly ContactIdentityRecord[] {
    this.#assertOpen();
    const limit = boundedInteger(limitValue, 1, 20, "Contact identity match limit");
    const normalizedValues = [...new Set([
      normalizeContactIdentityValue(identityValue),
      normalizeContactIdentityValue(identityValue, "phone")
    ])];
    const placeholders = normalizedValues.map(() => "?").join(", ");
    return (this.#database.prepare(`
      SELECT * FROM contact_identities
      WHERE normalized_value IN (${placeholders})
      ORDER BY created_at, id LIMIT ?
    `).all(...normalizedValues, limit) as Row[]).map(contactIdentityFromRow);
  }

  #initialize(): void {
    const marker = this.#database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact_schema_version'
    `).get();
    if (marker === undefined) {
      const existing = this.#database.prepare(`
        SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' LIMIT 1
      `).get();
      if (existing !== undefined) throw new ContactStoreError("CONTACT_STORE_UNAVAILABLE", "The Contacts database has an unknown schema. Rebuild the development database explicitly.");
      const at = this.#now();
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(CONTACT_SCHEMA);
        this.#database.prepare(`
          INSERT INTO contact_schema_version(singleton, version, baseline_id, initialized_at) VALUES (1, ?, ?, ?)
        `).run(CONTACT_SCHEMA_VERSION, CONTACT_SCHEMA_BASELINE_ID, at);
        this.#database.prepare(`
          INSERT INTO contact_directory(singleton, revision, enabled, created_at, updated_at) VALUES (1, 1, 0, ?, ?)
        `).run(at, at);
        this.#database.exec("COMMIT");
      } catch (error) {
        try { this.#database.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return;
    }
    const row = this.#database.prepare("SELECT version, baseline_id FROM contact_schema_version WHERE singleton = 1").get() as Row | undefined;
    if (row === undefined || integer(row["version"]) !== CONTACT_SCHEMA_VERSION || string(row["baseline_id"]) !== CONTACT_SCHEMA_BASELINE_ID) {
      throw new ContactStoreError("CONTACT_STORE_UNAVAILABLE", "The Contacts database is not the current v1 baseline. Rebuild incompatible development data explicitly.");
    }
    const integrity = this.#database.prepare("PRAGMA quick_check").all() as Row[];
    if (integrity.length !== 1 || string(integrity[0]?.["quick_check"]) !== "ok") {
      throw new ContactStoreError("CONTACT_STORE_UNAVAILABLE", "The Contacts database failed its integrity check.");
    }
  }

  #write<T>(callback: () => T): T {
    this.#assertOpen();
    if (this.#writeDepth > 0) return callback();
    this.#database.exec("BEGIN IMMEDIATE");
    this.#writeDepth = 1;
    try {
      const result = callback();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      if (error instanceof ContactStoreError) throw error;
      if (error instanceof Error && /UNIQUE constraint failed: contact_identities\.platform, contact_identities\.normalized_value/u.test(error.message)) {
        throw new ContactStoreError("CONTACT_IDENTITY_CONFLICT", "The contact identity belongs to another contact.");
      }
      throw error;
    } finally {
      this.#writeDepth = 0;
    }
  }

  #advanceDirectoryRevision(): number {
    const row = this.#database.prepare("SELECT revision FROM contact_directory WHERE singleton = 1").get() as Row;
    const current = integer(row["revision"]);
    if (current >= MAX_SAFE_REVISION) throw new ContactStoreError("CONTACT_STORE_UNAVAILABLE", "The Contacts revision space is exhausted.");
    const next = current + 1;
    this.#database.prepare("UPDATE contact_directory SET revision = ?, updated_at = ? WHERE singleton = 1")
      .run(next, this.#now());
    return next;
  }

  #assertDirectoryRevision(expected: bigint): void {
    if (expected < 1n) throw invalid("Contact directory revision is invalid.");
    const actual = this.directoryState().revision;
    if (actual !== expected) throw new ContactStoreError("CONTACT_DIRECTORY_CHANGED", "The contact directory changed concurrently.");
  }

  #assertEntityRevision(label: string, id: string, row: Row, expected: bigint): void {
    if (expected < 1n) throw invalid(`${label} revision is invalid.`);
    if (bigint(row["revision"]) !== expected) throw new ContactStoreError("CONTACT_CHANGED", `${label} ${id} changed concurrently.`);
  }

  #assertRevisionValue(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) throw new ContactStoreError("CONTACT_STORE_UNAVAILABLE", "The Contacts revision is invalid.");
  }

  #insertIdentity(contactId: string, revision: number, draftValue: ReturnType<typeof identityDraft>, at: number): void {
    const conflict = this.#database.prepare(`
      SELECT contact_id FROM contact_identities WHERE platform = ? AND normalized_value = ?
    `).get(draftValue.platform, draftValue.normalizedValue) as Row | undefined;
    if (conflict !== undefined) {
      throw new ContactStoreError("CONTACT_IDENTITY_CONFLICT", "The contact identity belongs to another contact.", string(conflict["contact_id"]));
    }
    this.#database.prepare(`
      INSERT INTO contact_identities(id, contact_id, revision, platform, value, normalized_value, label, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(this.#newId("contact_identity"), contactId, revision, draftValue.platform, draftValue.value,
      draftValue.normalizedValue, draftValue.label, draftValue.note, at);
  }

  #touchContacts(ids: readonly string[], revision: number, at: number): void {
    for (const id of new Set(ids)) {
      this.#database.prepare("UPDATE contacts SET revision = ?, updated_at = ? WHERE id = ?").run(revision, at, id);
    }
  }

  #touchGroups(ids: readonly string[], revision: number, at: number): void {
    for (const id of new Set(ids)) {
      this.#database.prepare("UPDATE contact_groups SET revision = ?, updated_at = ? WHERE id = ?").run(revision, at, id);
    }
  }

  #rebuildSearch(contactId: string): void {
    const contact = this.#requireContactRow(contactId);
    const identityRows = this.#database.prepare(`
      SELECT platform, value, label, note FROM contact_identities WHERE contact_id = ? ORDER BY id
    `).all(contactId) as Row[];
    const eventRows = this.#database.prepare(`
      SELECT event_date, text, source FROM contact_events WHERE contact_id = ? ORDER BY id
    `).all(contactId) as Row[];
    const content = [
      string(contact["display_name"]),
      ...aliases(contact["aliases_json"]),
      string(contact["summary"]),
      string(contact["narrative"]),
      string(contact["agent_notes"]),
      ...identityRows.flatMap((row) => [string(row["platform"]), string(row["value"]), string(row["label"]), string(row["note"])]),
      ...eventRows.flatMap((row) => [string(row["event_date"]), string(row["text"]), string(row["source"])])
    ].filter(Boolean).join("\n");
    this.#database.prepare("DELETE FROM contact_search_fts WHERE contact_id = ?").run(contactId);
    this.#database.prepare("INSERT INTO contact_search_fts(contact_id, content) VALUES (?, ?)").run(contactId, content);
  }

  #requireContactRow(contactId: string): Row {
    const row = this.#database.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as Row | undefined;
    if (row === undefined) throw notFound("Contact", contactId);
    return row;
  }

  #requireGroupRow(groupId: string): Row {
    const row = this.#database.prepare("SELECT * FROM contact_groups WHERE id = ?").get(groupId) as Row | undefined;
    if (row === undefined) throw notFound("Contact group", groupId);
    return row;
  }

  #count(table: "contacts" | "contact_groups" | "contact_identities" | "contact_events" | "contact_relations", key?: string, value?: string): number {
    if (key === undefined) {
      const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row;
      return integer(row["count"]);
    }
    if (value === undefined) throw invalid("Contact count filter is invalid.");
    const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${key} = ?`).get(value) as Row;
    return integer(row["count"]);
  }

  #newId(kind: "contact" | "contact_identity" | "contact_event" | "contact_group" | "contact_relation"): string {
    const seed = this.#idFactory();
    if (typeof seed !== "string" || seed.length < 1 || seed.length > 1_024) throw invalid("Contact identity seed is invalid.");
    return `${kind}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
  }

  #assertOpen(): void {
    if (this.#closed) throw new ContactStoreError("CONTACT_STORE_UNAVAILABLE", "The Contacts store is closed.");
  }
}

export function normalizeContactPlatform(value: string): string {
  if (typeof value !== "string") throw invalid("Contact identity platform is invalid.");
  const platform = value.trim().toLowerCase();
  if (!PLATFORM.test(platform)) throw invalid("Contact identity platform is invalid.");
  return platform;
}

export function normalizeContactIdentityValue(value: string, platformValue?: string): string {
  const platform = platformValue === undefined ? undefined : normalizeContactPlatform(platformValue);
  const original = text(value, 1, MAX_IDENTITY_VALUE, "Contact identity value");
  let normalized = original.toLocaleLowerCase("en-US");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (platform === "phone") {
    const phone = normalized.replace(/[^0-9+]/gu, "");
    if (/\d/u.test(phone)) normalized = phone;
  }
  if (normalized.length < 1 || normalized.length > MAX_IDENTITY_VALUE * 2) throw invalid("Contact identity value is invalid.");
  return normalized;
}

function contactDraft(input: ContactDraft): {
  readonly kind: ContactKind;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly narrative: string;
  readonly agentNotes: string;
  readonly status: ContactStatus;
  readonly source: ContactSource;
  readonly identities: readonly ReturnType<typeof identityDraft>[];
} {
  const displayName = text(input.displayName, 1, MAX_DISPLAY_NAME, "Contact display name");
  const aliasValues = uniqueNames(input.aliases ?? [], displayName);
  if (aliasValues.length > MAX_ALIASES) throw invalid("The contact alias limit was exceeded.");
  const identities = (input.identities ?? []).map(identityDraft);
  if (identities.length > MAX_IDENTITIES) throw invalid("The contact identity limit was exceeded.");
  const keys = identities.map((identity) => `${identity.platform}\0${identity.normalizedValue}`);
  if (new Set(keys).size !== keys.length) throw invalid("Contact identities contain duplicates.");
  const narrative = text(input.narrative ?? "", 0, Number.MAX_SAFE_INTEGER, "Contact narrative");
  if (Buffer.byteLength(narrative, "utf8") > MAX_NARRATIVE_BYTES) throw invalid("Contact narrative is too large.");
  return {
    kind: contactKind(input.kind),
    displayName,
    aliases: aliasValues,
    summary: text(input.summary ?? "", 0, MAX_SUMMARY, "Contact summary"),
    narrative,
    agentNotes: text(input.agentNotes ?? "", 0, MAX_AGENT_NOTES, "Contact agent notes"),
    status: contactStatus(input.status ?? "confirmed"),
    source: contactSource(input.source ?? "manual"),
    identities
  };
}

function contactPatch(input: ContactPatch): ContactPatch {
  const keys = Object.keys(input);
  const expected = new Set(["kind", "displayName", "aliases", "summary", "narrative", "agentNotes", "status"]);
  if (keys.some((key) => !expected.has(key))) throw invalid("Contact patch contains unknown fields.");
  const result: {
    kind?: ContactKind;
    displayName?: string;
    aliases?: readonly string[];
    summary?: string;
    narrative?: string;
    agentNotes?: string;
    status?: ContactStatus;
  } = {};
  if (input.kind !== undefined) result.kind = contactKind(input.kind);
  if (input.displayName !== undefined) result.displayName = text(input.displayName, 1, MAX_DISPLAY_NAME, "Contact display name");
  if (input.aliases !== undefined) {
    const values = uniqueNames(input.aliases, result.displayName ?? "");
    if (values.length > MAX_ALIASES) throw invalid("The contact alias limit was exceeded.");
    result.aliases = values;
  }
  if (input.summary !== undefined) result.summary = text(input.summary, 0, MAX_SUMMARY, "Contact summary");
  if (input.narrative !== undefined) {
    const value = text(input.narrative, 0, Number.MAX_SAFE_INTEGER, "Contact narrative");
    if (Buffer.byteLength(value, "utf8") > MAX_NARRATIVE_BYTES) throw invalid("Contact narrative is too large.");
    result.narrative = value;
  }
  if (input.agentNotes !== undefined) result.agentNotes = text(input.agentNotes, 0, MAX_AGENT_NOTES, "Contact agent notes");
  if (input.status !== undefined) result.status = contactStatus(input.status);
  return result;
}

function identityDraft(input: ContactIdentityDraft): {
  readonly platform: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly label: string;
  readonly note: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw invalid("Contact identity is invalid.");
  const platform = normalizeContactPlatform(input.platform);
  const value = text(input.value, 1, MAX_IDENTITY_VALUE, "Contact identity value");
  return {
    platform,
    value,
    normalizedValue: normalizeContactIdentityValue(value, platform),
    label: text(input.label ?? "", 0, 100, "Contact identity label"),
    note: text(input.note ?? "", 0, MAX_NOTE, "Contact identity note")
  };
}

function eventDraft(input: ContactEventDraft): { readonly date: string; readonly text: string; readonly source: string } {
  const date = text(input.date, 7, 10, "Contact event date");
  if (!EVENT_DATE.test(date)) throw invalid("Contact event date is invalid.");
  return {
    date,
    text: text(input.text, 1, MAX_EVENT_TEXT, "Contact event text"),
    source: text(input.source ?? "manual", 1, 64, "Contact event source")
  };
}

function contactSummaryFromRow(row: Row): ContactSummaryRecord {
  return {
    id: entityId(row["id"], "Contact ID"),
    revision: bigint(row["revision"]),
    kind: contactKind(row["kind"]),
    displayName: string(row["display_name"]),
    aliases: aliases(row["aliases_json"]),
    summary: string(row["summary"]),
    status: contactStatus(row["status"]),
    source: contactSource(row["source"]),
    identityCount: integer(row["identity_count"]),
    createdAt: integer(row["created_at"]),
    updatedAt: integer(row["updated_at"])
  };
}

function contactIdentityFromRow(row: Row): ContactIdentityRecord {
  return {
    id: entityId(row["id"], "Contact identity ID"),
    contactId: entityId(row["contact_id"], "Contact ID"),
    revision: bigint(row["revision"]),
    platform: normalizeContactPlatform(string(row["platform"])),
    value: string(row["value"]),
    normalizedValue: string(row["normalized_value"]),
    label: string(row["label"]),
    note: string(row["note"]),
    createdAt: integer(row["created_at"])
  };
}

function contactEventFromRow(row: Row): ContactEventRecord {
  return {
    id: entityId(row["id"], "Contact event ID"),
    contactId: entityId(row["contact_id"], "Contact ID"),
    revision: bigint(row["revision"]),
    date: string(row["event_date"]),
    text: string(row["text"]),
    source: string(row["source"]),
    createdAt: integer(row["created_at"])
  };
}

function contactGroupFromRow(row: Row): ContactGroupRecord {
  return {
    id: entityId(row["id"], "Contact group ID"),
    revision: bigint(row["revision"]),
    name: string(row["name"]),
    description: string(row["description"]),
    memberCount: integer(row["member_count"]),
    createdAt: integer(row["created_at"]),
    updatedAt: integer(row["updated_at"])
  };
}

function contactRelationFromRow(row: Row): ContactRelationRecord {
  return {
    id: entityId(row["id"], "Contact relation ID"),
    revision: bigint(row["revision"]),
    fromContactId: entityId(row["from_contact_id"], "Source contact ID"),
    toContactId: entityId(row["to_contact_id"], "Related contact ID"),
    relation: string(row["relation"]),
    note: string(row["note"]),
    createdAt: integer(row["created_at"])
  };
}

function relatedContactFromRow(row: Row): RelatedContactRecord {
  const relation = contactRelationFromRow(row);
  const directionValue = string(row["direction"]);
  if (directionValue !== "outgoing" && directionValue !== "incoming") throw invalid("Contact relation direction is invalid.");
  return {
    ...relation,
    direction: directionValue,
    relatedContactId: entityId(row["related_contact_id"], "Related contact ID"),
    relatedDisplayName: string(row["related_display_name"]),
    relatedKind: contactKind(row["related_kind"])
  };
}

function contactKind(value: unknown): ContactKind {
  if (value !== "person" && value !== "organization") throw invalid("Contact kind is invalid.");
  return value;
}

function contactStatus(value: unknown): ContactStatus {
  if (value !== "confirmed" && value !== "pending") throw invalid("Contact status is invalid.");
  return value;
}

function contactSource(value: unknown): ContactSource {
  if (value !== "manual" && value !== "agent" && value !== "import") throw invalid("Contact source is invalid.");
  return value;
}

function aliases(value: unknown): readonly string[] {
  if (typeof value !== "string") throw invalid("Contact aliases are invalid.");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid("Contact aliases are invalid."); }
  if (!Array.isArray(parsed)) throw invalid("Contact aliases are invalid.");
  const values = parsed.map((item) => text(item, 1, MAX_DISPLAY_NAME, "Contact alias"));
  if (values.length > MAX_ALIASES || new Set(values.map(folded)).size !== values.length) throw invalid("Contact aliases are invalid.");
  return values;
}

function uniqueNames(values: readonly string[], excluded: string): readonly string[] {
  if (!Array.isArray(values)) throw invalid("Contact aliases are invalid.");
  const excludedKey = folded(excluded);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = text(value, 1, MAX_DISPLAY_NAME, "Contact alias");
    const key = folded(normalized);
    if (key === excludedKey || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

interface NameFacet { readonly normalized: string; readonly cjk: boolean; readonly tokens: ReadonlySet<string> }

function nameFacets(displayName: string, aliasValues: readonly string[]): readonly NameFacet[] {
  return [displayName, ...aliasValues].map((value) => {
    const normalized = folded(value).replace(/[\s·.,_-]+/gu, "");
    return {
      normalized,
      cjk: /[\u3400-\u9fff\uf900-\ufaff]/u.test(normalized),
      tokens: new Set(folded(value).split(/[\s·.,_-]+/gu).filter(Boolean))
    };
  });
}

function facetsSimilar(left: readonly NameFacet[], right: readonly NameFacet[]): boolean {
  return left.some((a) => right.some((b) => facetSimilar(a, b)));
}

function facetSimilar(left: NameFacet, right: NameFacet): boolean {
  if (left.normalized === "" || right.normalized === "") return false;
  if (left.normalized === right.normalized) return true;
  if (left.cjk || right.cjk) {
    const [shorter, longer] = left.normalized.length <= right.normalized.length ? [left, right] : [right, left];
    if (shorter.cjk && shorter.normalized.length >= 2 && longer.normalized.includes(shorter.normalized)) return true;
  }
  const [small, large] = left.tokens.size <= right.tokens.size ? [left.tokens, right.tokens] : [right.tokens, left.tokens];
  return small.size > 0 && [...small].every((token) => large.has(token));
}

function contactFtsQuery(value: string): string {
  const clean = text(value, 1, 256, "Contact search query");
  const tokens = clean.split(/\s+/u).filter(Boolean).slice(0, 12);
  if (tokens.length === 0) throw invalid("Contact search query is empty.");
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function mergeText(left: string, right: string, separator: string, maximum: number, bytes: boolean): string {
  const result = left === "" ? right : right === "" || left === right ? left : `${left}${separator}${right}`;
  const length = bytes ? Buffer.byteLength(result, "utf8") : result.length;
  if (length > maximum) throw invalid("Merge would exceed a contact text limit.");
  return result;
}

function uniqueEntityIds(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 100) throw invalid(`${label} list is invalid.`);
  const result = values.map((value) => entityId(value, label)).sort();
  if (new Set(result).size !== result.length) throw invalid(`${label} list contains duplicates.`);
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function entityId(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || !ENTITY_ID.test(value)) throw invalid(`${label} is invalid.`);
  return value;
}

function text(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < minimum || value.length > maximum || FORBIDDEN_TEXT.test(value)) {
    throw invalid(`${label} is invalid.`);
  }
  return value;
}

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function string(value: unknown): string {
  if (typeof value !== "string") throw invalid("Stored Contacts text is invalid.");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalid("Stored Contacts integer is invalid.");
  return value;
}

function nullableCount(value: unknown): number {
  return value === null ? 0 : integer(value);
}

function bigint(value: unknown): bigint {
  const number = integer(value);
  if (number < 0) throw invalid("Stored Contacts revision is invalid.");
  return BigInt(number);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid(`${label} is invalid.`);
  return value;
}

function invalid(message: string): ContactStoreError {
  return new ContactStoreError("CONTACT_INVALID", message);
}

function notFound(label: string, id: string): ContactStoreError {
  return new ContactStoreError("CONTACT_NOT_FOUND", `${label} ${id} was not found.`);
}
