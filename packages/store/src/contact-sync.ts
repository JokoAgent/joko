import { createHash } from "node:crypto";

import type { ContactKind, ContactSource, ContactStatus } from "./contact-types.js";

export const CONTACT_SYNC_VERSION = 1;
export const CONTACT_SYNC_MAX_ROWS_PER_TABLE = 50_000;

const MAX_CLOCKS = 256;
const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME = 100;
const MAX_ALIASES = 20;
const MAX_SUMMARY = 300;
const MAX_NARRATIVE_BYTES = 16_384;
const MAX_AGENT_NOTES = 1_000;
const MAX_IDENTITY_VALUE = 320;
const MAX_EVENT_TEXT = 1_000;
const MAX_GROUP_NAME = 60;
const MAX_RELATION = 30;
const MAX_NOTE = 1_000;
const MAX_COUNTER = 9_007_199_254_740_991;
const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLATFORM = /^[a-z0-9_-]{1,32}$/u;
const EVENT_DATE = /^\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?$/u;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface ContactSyncStamp {
  readonly counter: number;
  readonly nodeId: string;
}

export interface ContactSyncClock {
  readonly nodeId: string;
  readonly counter: number;
}

export interface ContactStampedValue<T> {
  readonly value: T;
  readonly stamp: ContactSyncStamp;
}

export interface ContactSyncConflictMembership {
  readonly platform: string;
  readonly normalizedValue: string;
  readonly membershipHash: string;
}

export interface ContactSyncStatusValue extends ContactStampedValue<ContactStatus> {
  readonly acknowledgedConflicts?: readonly ContactSyncConflictMembership[];
}

export interface ContactSyncContact {
  readonly id: string;
  readonly kind: ContactStampedValue<ContactKind>;
  readonly displayName: ContactStampedValue<string>;
  readonly aliases: ContactStampedValue<readonly string[]>;
  readonly summary: ContactStampedValue<string>;
  readonly narrative: ContactStampedValue<string>;
  readonly agentNotes: ContactStampedValue<string>;
  readonly status: ContactSyncStatusValue;
  readonly source: ContactStampedValue<ContactSource>;
  readonly createdAt: ContactStampedValue<number>;
  readonly updatedAt: ContactStampedValue<number>;
  readonly deleted?: ContactSyncStamp;
}

export interface ContactSyncEntity<T> {
  readonly id: string;
  readonly value: ContactStampedValue<T>;
  readonly deleted?: ContactSyncStamp;
}

export interface ContactSyncIdentityValue {
  readonly contactId: string;
  readonly platform: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly label: string;
  readonly note: string;
  readonly createdAt: number;
}

export interface ContactSyncEventValue {
  readonly contactId: string;
  readonly date: string;
  readonly text: string;
  readonly source: string;
  readonly createdAt: number;
}

export interface ContactSyncGroupValue {
  readonly name: string;
  readonly description: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactSyncMembershipValue {
  readonly groupId: string;
  readonly contactId: string;
}

export interface ContactSyncRelationValue {
  readonly fromContactId: string;
  readonly toContactId: string;
  readonly relation: string;
  readonly note: string;
  readonly createdAt: number;
}

export interface ContactSyncState {
  readonly version: typeof CONTACT_SYNC_VERSION;
  readonly clocks: readonly ContactSyncClock[];
  readonly contacts: readonly ContactSyncContact[];
  readonly identities: readonly ContactSyncEntity<ContactSyncIdentityValue>[];
  readonly events: readonly ContactSyncEntity<ContactSyncEventValue>[];
  readonly groups: readonly ContactSyncEntity<ContactSyncGroupValue>[];
  readonly memberships: readonly ContactSyncEntity<ContactSyncMembershipValue>[];
  readonly relations: readonly ContactSyncEntity<ContactSyncRelationValue>[];
}

export interface ContactSnapshotContact {
  readonly id: string;
  readonly kind: ContactKind;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly narrative: string;
  readonly agentNotes: string;
  readonly status: ContactStatus;
  readonly source: ContactSource;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactSnapshotIdentity extends ContactSyncIdentityValue {
  readonly id: string;
}

export interface ContactSnapshotEvent extends ContactSyncEventValue {
  readonly id: string;
}

export interface ContactSnapshotGroup extends ContactSyncGroupValue {
  readonly id: string;
}

export interface ContactSnapshotMembership extends ContactSyncMembershipValue {
  readonly id: string;
}

export interface ContactSnapshotRelation extends ContactSyncRelationValue {
  readonly id: string;
}

export interface ContactDataSnapshot {
  readonly contacts: readonly ContactSnapshotContact[];
  readonly identities: readonly ContactSnapshotIdentity[];
  readonly events: readonly ContactSnapshotEvent[];
  readonly groups: readonly ContactSnapshotGroup[];
  readonly memberships: readonly ContactSnapshotMembership[];
  readonly relations: readonly ContactSnapshotRelation[];
}

export interface ContactIdentityConflict {
  readonly platform: string;
  readonly normalizedValue: string;
  readonly owners: ReadonlySet<string>;
  readonly membershipHash: string;
}

export function createEmptyContactSyncState(): ContactSyncState {
  return {
    version: CONTACT_SYNC_VERSION,
    clocks: [],
    contacts: [],
    identities: [],
    events: [],
    groups: [],
    memberships: [],
    relations: []
  };
}

export function createEmptyContactSnapshot(): ContactDataSnapshot {
  return { contacts: [], identities: [], events: [], groups: [], memberships: [], relations: [] };
}

export function contactMembershipSyncId(groupId: string, contactId: string): string {
  return `${groupId}\u0000${contactId}`;
}

export function compareContactSyncText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableContactSyncJson(value: unknown): string {
  type Frame = { readonly kind: "value"; readonly value: unknown } | { readonly kind: "text"; readonly text: string };
  const output: string[] = [];
  const stack: Frame[] = [{ kind: "value", value }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "text") {
      output.push(frame.text);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      output.push(JSON.stringify(current) ?? "null");
      continue;
    }
    if (seen.has(current)) {
      output.push('"[circular]"');
      continue;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      output.push("[");
      stack.push({ kind: "text", text: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: "value", value: current[index] });
        if (index > 0) stack.push({ kind: "text", text: "," });
      }
      continue;
    }
    const record = current as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareContactSyncText);
    output.push("{");
    stack.push({ kind: "text", text: "}" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({ kind: "value", value: record[key] });
      stack.push({ kind: "text", text: `:${JSON.stringify(key)}` });
      if (index > 0) stack.push({ kind: "text", text: "," });
    }
  }
  return output.join("");
}

export function compareContactSyncStamp(left: ContactSyncStamp, right: ContactSyncStamp): number {
  if (left.counter !== right.counter) return left.counter < right.counter ? -1 : 1;
  return compareContactSyncText(left.nodeId, right.nodeId);
}

function maxStamp(left: ContactSyncStamp | undefined, right: ContactSyncStamp | undefined): ContactSyncStamp | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return compareContactSyncStamp(left, right) >= 0 ? left : right;
}

function mergeStamped<T>(left: ContactStampedValue<T>, right: ContactStampedValue<T>): ContactStampedValue<T> {
  const order = compareContactSyncStamp(left.stamp, right.stamp);
  if (order > 0) return left;
  if (order < 0) return right;
  return stableContactSyncJson(left) >= stableContactSyncJson(right) ? left : right;
}

function mergeContact(left: ContactSyncContact, right: ContactSyncContact): ContactSyncContact {
  const deleted = maxStamp(left.deleted, right.deleted);
  return {
    id: left.id,
    kind: mergeStamped(left.kind, right.kind),
    displayName: mergeStamped(left.displayName, right.displayName),
    aliases: mergeStamped(left.aliases, right.aliases),
    summary: mergeStamped(left.summary, right.summary),
    narrative: mergeStamped(left.narrative, right.narrative),
    agentNotes: mergeStamped(left.agentNotes, right.agentNotes),
    status: mergeStamped(left.status, right.status),
    source: mergeStamped(left.source, right.source),
    createdAt: mergeStamped(left.createdAt, right.createdAt),
    updatedAt: mergeStamped(left.updatedAt, right.updatedAt),
    ...(deleted === undefined ? {} : { deleted })
  };
}

function mergeEntities<T>(
  left: readonly ContactSyncEntity<T>[],
  right: readonly ContactSyncEntity<T>[]
): readonly ContactSyncEntity<T>[] {
  const records = new Map<string, ContactSyncEntity<T>>();
  for (const record of [...left, ...right]) {
    const current = records.get(record.id);
    if (current === undefined) {
      records.set(record.id, record);
      continue;
    }
    const deleted = maxStamp(current.deleted, record.deleted);
    records.set(record.id, {
      id: record.id,
      value: mergeStamped(current.value, record.value),
      ...(deleted === undefined ? {} : { deleted })
    });
  }
  return [...records.values()].sort((a, b) => compareContactSyncText(a.id, b.id));
}

function mergeClocks(left: readonly ContactSyncClock[], right: readonly ContactSyncClock[]): readonly ContactSyncClock[] {
  const clocks = new Map<string, number>();
  for (const clock of [...left, ...right]) clocks.set(clock.nodeId, Math.max(clocks.get(clock.nodeId) ?? 0, clock.counter));
  return [...clocks.entries()].map(([nodeId, counter]) => ({ nodeId, counter }))
    .sort((a, b) => compareContactSyncText(a.nodeId, b.nodeId));
}

export function mergeContactSyncStates(left: ContactSyncState, right: ContactSyncState): ContactSyncState {
  return {
    version: CONTACT_SYNC_VERSION,
    clocks: mergeClocks(left.clocks, right.clocks),
    contacts: mergeContacts(left.contacts, right.contacts),
    identities: mergeEntities(left.identities, right.identities),
    events: mergeEntities(left.events, right.events),
    groups: mergeEntities(left.groups, right.groups),
    memberships: mergeEntities(left.memberships, right.memberships),
    relations: mergeEntities(left.relations, right.relations)
  };
}

function mergeContacts(left: readonly ContactSyncContact[], right: readonly ContactSyncContact[]): readonly ContactSyncContact[] {
  const records = new Map<string, ContactSyncContact>();
  for (const contact of [...left, ...right]) {
    const current = records.get(contact.id);
    records.set(contact.id, current === undefined ? contact : mergeContact(current, contact));
  }
  return [...records.values()].sort((a, b) => compareContactSyncText(a.id, b.id));
}

export function nextContactSyncStamp(
  state: ContactSyncState,
  nodeId: string
): { readonly state: ContactSyncState; readonly stamp: ContactSyncStamp } {
  let maximum = 0;
  for (const clock of state.clocks) maximum = Math.max(maximum, clock.counter);
  if (maximum >= MAX_COUNTER) throw new Error("The Contacts sync Lamport clock is exhausted.");
  const counter = maximum + 1;
  const clocks = state.clocks.filter((clock) => clock.nodeId !== nodeId).map((clock) => ({ ...clock }));
  clocks.push({ nodeId, counter });
  clocks.sort((a, b) => compareContactSyncText(a.nodeId, b.nodeId));
  return { state: { ...state, clocks }, stamp: { nodeId, counter } };
}

export function createContactSyncDelta(state: ContactSyncState, knownClocks: readonly ContactSyncClock[]): ContactSyncState {
  const known = new Map(knownClocks.map((clock) => [clock.nodeId, clock.counter]));
  const isNew = (stamp: ContactSyncStamp | undefined): boolean =>
    stamp !== undefined && stamp.counter > (known.get(stamp.nodeId) ?? 0);
  const contactIsNew = (contact: ContactSyncContact): boolean =>
    isNew(contact.kind.stamp) || isNew(contact.displayName.stamp) || isNew(contact.aliases.stamp) ||
    isNew(contact.summary.stamp) || isNew(contact.narrative.stamp) || isNew(contact.agentNotes.stamp) ||
    isNew(contact.status.stamp) || isNew(contact.source.stamp) || isNew(contact.createdAt.stamp) ||
    isNew(contact.updatedAt.stamp) || isNew(contact.deleted);
  const entityIsNew = <T>(entity: ContactSyncEntity<T>): boolean => isNew(entity.value.stamp) || isNew(entity.deleted);
  return {
    version: CONTACT_SYNC_VERSION,
    clocks: state.clocks.map((clock) => ({ ...clock })),
    contacts: state.contacts.filter(contactIsNew),
    identities: state.identities.filter(entityIsNew),
    events: state.events.filter(entityIsNew),
    groups: state.groups.filter(entityIsNew),
    memberships: state.memberships.filter(entityIsNew),
    relations: state.relations.filter(entityIsNew)
  };
}

function equal(left: unknown, right: unknown): boolean {
  return stableContactSyncJson(left) === stableContactSyncJson(right);
}

function stamped<T>(value: T, stamp: ContactSyncStamp): ContactStampedValue<T> {
  return { value, stamp };
}

function newContact(row: ContactSnapshotContact, stamp: ContactSyncStamp): ContactSyncContact {
  return {
    id: row.id,
    kind: stamped(row.kind, stamp),
    displayName: stamped(row.displayName, stamp),
    aliases: stamped(row.aliases, stamp),
    summary: stamped(row.summary, stamp),
    narrative: stamped(row.narrative, stamp),
    agentNotes: stamped(row.agentNotes, stamp),
    status: stamped(row.status, stamp),
    source: stamped(row.source, stamp),
    createdAt: stamped(row.createdAt, stamp),
    updatedAt: stamped(row.updatedAt, stamp)
  };
}

function updateContact(
  existing: ContactSyncContact,
  previous: ContactSnapshotContact,
  current: ContactSnapshotContact,
  stamp: ContactSyncStamp
): ContactSyncContact {
  return {
    ...existing,
    ...(previous.kind === current.kind ? {} : { kind: stamped(current.kind, stamp) }),
    ...(previous.displayName === current.displayName ? {} : { displayName: stamped(current.displayName, stamp) }),
    ...(equal(previous.aliases, current.aliases) ? {} : { aliases: stamped(current.aliases, stamp) }),
    ...(previous.summary === current.summary ? {} : { summary: stamped(current.summary, stamp) }),
    ...(previous.narrative === current.narrative ? {} : { narrative: stamped(current.narrative, stamp) }),
    ...(previous.agentNotes === current.agentNotes ? {} : { agentNotes: stamped(current.agentNotes, stamp) }),
    ...(previous.status === current.status ? {} : { status: stamped(current.status, stamp) }),
    ...(previous.source === current.source ? {} : { source: stamped(current.source, stamp) }),
    ...(previous.createdAt === current.createdAt ? {} : { createdAt: stamped(current.createdAt, stamp) }),
    ...(previous.updatedAt === current.updatedAt ? {} : { updatedAt: stamped(current.updatedAt, stamp) })
  };
}

function captureContacts(
  state: readonly ContactSyncContact[],
  previous: readonly ContactSnapshotContact[],
  current: readonly ContactSnapshotContact[],
  stamp: ContactSyncStamp
): readonly ContactSyncContact[] {
  const records = new Map(state.map((record) => [record.id, record]));
  const before = new Map(previous.map((row) => [row.id, row]));
  const after = new Map(current.map((row) => [row.id, row]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldRow = before.get(id);
    const newRow = after.get(id);
    const existing = records.get(id);
    if (newRow !== undefined && oldRow === undefined) {
      if (existing === undefined) records.set(id, newContact(newRow, stamp));
      continue;
    }
    if (newRow !== undefined && oldRow !== undefined) {
      records.set(id, existing === undefined ? newContact(newRow, stamp) : updateContact(existing, oldRow, newRow, stamp));
      continue;
    }
    if (oldRow !== undefined && existing !== undefined && existing.deleted === undefined) {
      records.set(id, { ...existing, deleted: stamp });
    }
  }
  return [...records.values()].sort((a, b) => compareContactSyncText(a.id, b.id));
}

type RowWithId = { readonly id: string };

function withoutId<T extends RowWithId>(row: T): Omit<T, "id"> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id")) as Omit<T, "id">;
}

function captureEntities<T extends RowWithId>(
  state: readonly ContactSyncEntity<Omit<T, "id">>[],
  previous: readonly T[],
  current: readonly T[],
  stamp: ContactSyncStamp,
  reusableId = false
): readonly ContactSyncEntity<Omit<T, "id">>[] {
  const records = new Map(state.map((record) => [record.id, record]));
  const before = new Map(previous.map((row) => [row.id, row]));
  const after = new Map(current.map((row) => [row.id, row]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const oldRow = before.get(id);
    const newRow = after.get(id);
    const existing = records.get(id);
    if (newRow !== undefined && (oldRow === undefined || !equal(oldRow, newRow))) {
      records.set(id, {
        id,
        value: stamped(withoutId(newRow), stamp),
        ...(existing?.deleted === undefined ? {} : { deleted: existing.deleted })
      });
      continue;
    }
    if (oldRow !== undefined && newRow === undefined && existing !== undefined &&
      (existing.deleted === undefined || reusableId)) {
      records.set(id, { ...existing, deleted: stamp });
    }
  }
  return [...records.values()].sort((a, b) => compareContactSyncText(a.id, b.id));
}

export function captureContactSnapshot(
  state: ContactSyncState,
  previous: ContactDataSnapshot,
  current: ContactDataSnapshot,
  nodeId: string
): { readonly state: ContactSyncState; readonly changed: boolean } {
  const snapshotChanged = !equal(previous, current);
  let captured = state;
  if (snapshotChanged) {
    const next = nextContactSyncStamp(state, nodeId);
    const stamp = next.stamp;
    captured = {
      ...next.state,
      contacts: captureContacts(state.contacts, previous.contacts, current.contacts, stamp),
      identities: captureEntities(state.identities, previous.identities, current.identities, stamp),
      events: captureEntities(state.events, previous.events, current.events, stamp),
      groups: captureEntities(state.groups, previous.groups, current.groups, stamp),
      memberships: captureEntities(state.memberships, previous.memberships, current.memberships, stamp, true),
      relations: captureEntities(state.relations, previous.relations, current.relations, stamp)
    };
  }
  const before = new Map(previous.contacts.map((contact) => [contact.id, contact]));
  const after = new Map(current.contacts.map((contact) => [contact.id, contact]));
  const explicitlyConfirmed = new Set([...after.keys()].filter((id) =>
    before.get(id)?.status === "pending" && after.get(id)?.status === "confirmed"));
  if (explicitlyConfirmed.size === 0) return { state: captured, changed: snapshotChanged };
  const membershipsByContact = new Map<string, ContactSyncConflictMembership[]>();
  for (const conflict of collectContactIdentityConflicts(captured)) {
    for (const contactId of conflict.owners) {
      if (!explicitlyConfirmed.has(contactId)) continue;
      const memberships = membershipsByContact.get(contactId) ?? [];
      memberships.push({
        platform: conflict.platform,
        normalizedValue: conflict.normalizedValue,
        membershipHash: conflict.membershipHash
      });
      membershipsByContact.set(contactId, memberships);
    }
  }
  return {
    changed: true,
    state: {
      ...captured,
      contacts: captured.contacts.map((contact) => {
        if (!explicitlyConfirmed.has(contact.id)) return contact;
        const acknowledgedConflicts = (membershipsByContact.get(contact.id) ?? []).sort((a, b) =>
          compareContactSyncText(`${a.platform}\u0000${a.normalizedValue}`, `${b.platform}\u0000${b.normalizedValue}`));
        return {
          ...contact,
          status: {
            ...contact.status,
            ...(acknowledgedConflicts.length === 0 ? {} : { acknowledgedConflicts })
          }
        };
      })
    }
  };
}

export function collectContactIdentityConflicts(state: ContactSyncState): readonly ContactIdentityConflict[] {
  const contactIds = new Set(state.contacts.filter((contact) => contact.deleted === undefined).map((contact) => contact.id));
  const records = new Map<string, ContactSyncEntity<ContactSyncIdentityValue>[]>();
  for (const identity of state.identities) {
    if (identity.deleted !== undefined || !contactIds.has(identity.value.value.contactId)) continue;
    const value = identity.value.value;
    const key = `${value.platform}\u0000${value.normalizedValue}`;
    const group = records.get(key) ?? [];
    group.push(identity);
    records.set(key, group);
  }
  const conflicts: ContactIdentityConflict[] = [];
  for (const group of records.values()) {
    const owners = new Set(group.map((identity) => identity.value.value.contactId));
    if (owners.size <= 1) continue;
    const first = group[0]!.value.value;
    conflicts.push({
      platform: first.platform,
      normalizedValue: first.normalizedValue,
      owners,
      membershipHash: createHash("sha256").update(JSON.stringify([...owners].sort(compareContactSyncText))).digest("hex")
    });
  }
  return conflicts.sort((a, b) => compareContactSyncText(
    `${a.platform}\u0000${a.normalizedValue}`,
    `${b.platform}\u0000${b.normalizedValue}`
  ));
}

function liveEntities<T>(records: readonly ContactSyncEntity<T>[]): readonly ContactSyncEntity<T>[] {
  return records.filter((record) => record.deleted === undefined);
}

function liveReusableEntities<T>(records: readonly ContactSyncEntity<T>[]): readonly ContactSyncEntity<T>[] {
  return records.filter((record) => record.deleted === undefined || compareContactSyncStamp(record.value.stamp, record.deleted) > 0);
}

function uniqueBy<T>(records: readonly ContactSyncEntity<T>[], key: (value: T) => string): readonly ContactSyncEntity<T>[] {
  const ordered = [...records].sort((a, b) => {
    const stamp = compareContactSyncStamp(b.value.stamp, a.value.stamp);
    return stamp === 0 ? compareContactSyncText(a.id, b.id) : stamp;
  });
  const seen = new Set<string>();
  return ordered.filter((record) => {
    const candidate = key(record.value.value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function byId<T extends { readonly id: string }>(left: T, right: T): number {
  return compareContactSyncText(left.id, right.id);
}

export function materializeContactSyncState(state: ContactSyncState): ContactDataSnapshot {
  const contacts = state.contacts.filter((record) => record.deleted === undefined).map<ContactSnapshotContact>((record) => ({
    id: record.id,
    kind: record.kind.value,
    displayName: record.displayName.value,
    aliases: [...record.aliases.value],
    summary: record.summary.value,
    narrative: record.narrative.value,
    agentNotes: record.agentNotes.value,
    status: record.status.value,
    source: record.source.value,
    createdAt: record.createdAt.value,
    updatedAt: record.updatedAt.value
  })).sort(byId);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const contactIds = new Set(contactsById.keys());
  const acknowledgements = new Map<string, Map<string, ContactSyncConflictMembership>>();
  for (const contact of state.contacts) {
    if (contact.status.acknowledgedConflicts === undefined) continue;
    acknowledgements.set(contact.id, new Map(contact.status.acknowledgedConflicts.map((value) =>
      [`${value.platform}\u0000${value.normalizedValue}`, value])));
  }
  const groups = uniqueBy(liveEntities(state.groups), (value) => folded(value.name))
    .map<ContactSnapshotGroup>((record) => ({ id: record.id, ...record.value.value })).sort(byId);
  const groupIds = new Set(groups.map((group) => group.id));
  const identities = uniqueBy(
    liveEntities(state.identities).filter((record) => contactIds.has(record.value.value.contactId)),
    (value) => `${value.platform}\u0000${value.normalizedValue}`
  ).map<ContactSnapshotIdentity>((record) => ({ id: record.id, ...record.value.value })).sort(byId);
  for (const conflict of collectContactIdentityConflicts(state)) {
    const conflictKey = `${conflict.platform}\u0000${conflict.normalizedValue}`;
    for (const contactId of conflict.owners) {
      const contact = contactsById.get(contactId);
      if (contact === undefined) continue;
      const acknowledgement = acknowledgements.get(contactId)?.get(conflictKey);
      if (contact.status === "confirmed" && acknowledgement?.membershipHash === conflict.membershipHash) continue;
      (contact as { status: ContactStatus }).status = "pending";
    }
  }
  const events = liveEntities(state.events).filter((record) => contactIds.has(record.value.value.contactId))
    .map<ContactSnapshotEvent>((record) => ({ id: record.id, ...record.value.value })).sort(byId);
  const memberships = liveReusableEntities(state.memberships).filter((record) =>
    contactIds.has(record.value.value.contactId) && groupIds.has(record.value.value.groupId))
    .map<ContactSnapshotMembership>((record) => ({ id: record.id, ...record.value.value })).sort(byId);
  const relations = uniqueBy(liveEntities(state.relations).filter((record) => {
    const value = record.value.value;
    return value.fromContactId !== value.toContactId && contactIds.has(value.fromContactId) && contactIds.has(value.toContactId);
  }), (value) => `${value.fromContactId}\u0000${value.toContactId}\u0000${value.relation}`)
    .map<ContactSnapshotRelation>((record) => ({ id: record.id, ...record.value.value })).sort(byId);
  return { contacts, identities, events, groups, memberships, relations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= minimum && value.length <= maximum && !FORBIDDEN_TEXT.test(value);
}

function isStamp(value: unknown): value is ContactSyncStamp {
  return isRecord(value) && hasOnlyKeys(value, ["counter", "nodeId"]) && isSafeInteger(value.counter) &&
    value.counter >= 1 && value.counter <= MAX_COUNTER && isEntityId(value.nodeId);
}

function isStamped<T>(value: unknown, validator: (candidate: unknown) => candidate is T): value is ContactStampedValue<T> {
  return isRecord(value) && hasOnlyKeys(value, ["value", "stamp"]) && validator(value.value) && isStamp(value.stamp);
}

function isKind(value: unknown): value is ContactKind {
  return value === "person" || value === "organization";
}

function isStatus(value: unknown): value is ContactStatus {
  return value === "confirmed" || value === "pending";
}

function isSource(value: unknown): value is ContactSource {
  return value === "manual" || value === "agent" || value === "import";
}

function isAliases(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ALIASES) return false;
  const seen = new Set<string>();
  for (const alias of value) {
    if (!isText(alias, 1, MAX_DISPLAY_NAME)) return false;
    const key = folded(alias);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isAcknowledgement(value: unknown): value is ContactSyncConflictMembership {
  return isRecord(value) && hasOnlyKeys(value, ["platform", "normalizedValue", "membershipHash"]) &&
    typeof value.platform === "string" && PLATFORM.test(value.platform) && isText(value.normalizedValue, 1, MAX_IDENTITY_VALUE * 2) &&
    typeof value.membershipHash === "string" && /^[a-f0-9]{64}$/u.test(value.membershipHash);
}

function isStatusStamped(value: unknown): value is ContactSyncStatusValue {
  if (!isRecord(value) || !hasOnlyKeys(value, ["value", "stamp"], ["acknowledgedConflicts"]) ||
    !isStatus(value.value) || !isStamp(value.stamp)) return false;
  if (value.acknowledgedConflicts === undefined) return true;
  if (!Array.isArray(value.acknowledgedConflicts) || value.acknowledgedConflicts.length > CONTACT_SYNC_MAX_ROWS_PER_TABLE) return false;
  const keys = new Set<string>();
  for (const acknowledgement of value.acknowledgedConflicts) {
    if (!isAcknowledgement(acknowledgement)) return false;
    const key = `${acknowledgement.platform}\u0000${acknowledgement.normalizedValue}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function isContact(value: unknown): value is ContactSyncContact {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "id", "kind", "displayName", "aliases", "summary", "narrative", "agentNotes", "status", "source", "createdAt", "updatedAt"
  ], ["deleted"]) || !isEntityId(value.id)) return false;
  return isStamped(value.kind, isKind) && isStamped(value.displayName, (item): item is string => isText(item, 1, MAX_DISPLAY_NAME)) &&
    isStamped(value.aliases, isAliases) && isStamped(value.summary, (item): item is string => isText(item, 0, MAX_SUMMARY)) &&
    isStamped(value.narrative, (item): item is string => isText(item, 0, Number.MAX_SAFE_INTEGER) && Buffer.byteLength(item, "utf8") <= MAX_NARRATIVE_BYTES) &&
    isStamped(value.agentNotes, (item): item is string => isText(item, 0, MAX_AGENT_NOTES)) && isStatusStamped(value.status) &&
    isStamped(value.source, isSource) && isStamped(value.createdAt, isSafeInteger) && isStamped(value.updatedAt, isSafeInteger) &&
    (value.deleted === undefined || isStamp(value.deleted));
}

function isIdentityValue(value: unknown): value is ContactSyncIdentityValue {
  return isRecord(value) && hasOnlyKeys(value, ["contactId", "platform", "value", "normalizedValue", "label", "note", "createdAt"]) &&
    isEntityId(value.contactId) && typeof value.platform === "string" && PLATFORM.test(value.platform) &&
    isText(value.value, 1, MAX_IDENTITY_VALUE) && isText(value.normalizedValue, 1, MAX_IDENTITY_VALUE * 2) &&
    isText(value.label, 0, MAX_NOTE) && isText(value.note, 0, MAX_NOTE) && isSafeInteger(value.createdAt);
}

function isEventValue(value: unknown): value is ContactSyncEventValue {
  return isRecord(value) && hasOnlyKeys(value, ["contactId", "date", "text", "source", "createdAt"]) &&
    isEntityId(value.contactId) && typeof value.date === "string" && EVENT_DATE.test(value.date) &&
    isText(value.text, 1, MAX_EVENT_TEXT) && isText(value.source, 0, MAX_NOTE) && isSafeInteger(value.createdAt);
}

function isGroupValue(value: unknown): value is ContactSyncGroupValue {
  return isRecord(value) && hasOnlyKeys(value, ["name", "description", "createdAt", "updatedAt"]) &&
    isText(value.name, 1, MAX_GROUP_NAME) && isText(value.description, 0, MAX_SUMMARY) &&
    isSafeInteger(value.createdAt) && isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

function isMembershipValue(value: unknown): value is ContactSyncMembershipValue {
  return isRecord(value) && hasOnlyKeys(value, ["groupId", "contactId"]) && isEntityId(value.groupId) && isEntityId(value.contactId);
}

function isRelationValue(value: unknown): value is ContactSyncRelationValue {
  return isRecord(value) && hasOnlyKeys(value, ["fromContactId", "toContactId", "relation", "note", "createdAt"]) &&
    isEntityId(value.fromContactId) && isEntityId(value.toContactId) && value.fromContactId !== value.toContactId &&
    isText(value.relation, 1, MAX_RELATION) && isText(value.note, 0, MAX_NOTE) && isSafeInteger(value.createdAt);
}

function isEntityArray<T>(
  value: unknown,
  validateValue: (candidate: unknown) => candidate is T,
  validateId: (candidate: unknown) => candidate is string = isEntityId
): value is readonly ContactSyncEntity<T>[] {
  if (!Array.isArray(value) || value.length > CONTACT_SYNC_MAX_ROWS_PER_TABLE) return false;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["id", "value"], ["deleted"]) || !validateId(candidate.id) ||
      ids.has(candidate.id) || !isStamped(candidate.value, validateValue) ||
      (candidate.deleted !== undefined && !isStamp(candidate.deleted))) return false;
    ids.add(candidate.id);
  }
  return true;
}

function clocksCover(state: ContactSyncState): boolean {
  const clocks = new Map(state.clocks.map((clock) => [clock.nodeId, clock.counter]));
  const covered = (stamp: ContactSyncStamp | undefined): boolean => stamp === undefined || (clocks.get(stamp.nodeId) ?? 0) >= stamp.counter;
  for (const contact of state.contacts) {
    if (![contact.kind.stamp, contact.displayName.stamp, contact.aliases.stamp, contact.summary.stamp,
      contact.narrative.stamp, contact.agentNotes.stamp, contact.status.stamp, contact.source.stamp,
      contact.createdAt.stamp, contact.updatedAt.stamp, contact.deleted].every(covered)) return false;
  }
  for (const records of [state.identities, state.events, state.groups, state.memberships, state.relations]) {
    for (const record of records) if (!covered(record.value.stamp) || !covered(record.deleted)) return false;
  }
  return true;
}

export function isValidContactSyncState(value: unknown): value is ContactSyncState {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "clocks", "contacts", "identities", "events", "groups", "memberships", "relations"]) ||
    value.version !== CONTACT_SYNC_VERSION || !Array.isArray(value.clocks) || value.clocks.length > MAX_CLOCKS) return false;
  const clockIds = new Set<string>();
  for (const clock of value.clocks) {
    if (!isRecord(clock) || !hasOnlyKeys(clock, ["nodeId", "counter"]) || !isEntityId(clock.nodeId) || !isSafeInteger(clock.counter) ||
      clock.counter < 1 || clock.counter > MAX_COUNTER || clockIds.has(clock.nodeId)) return false;
    clockIds.add(clock.nodeId);
  }
  if (!Array.isArray(value.contacts) || value.contacts.length > CONTACT_SYNC_MAX_ROWS_PER_TABLE) return false;
  const contactIds = new Set<string>();
  let acknowledgementCount = 0;
  for (const contact of value.contacts) {
    if (!isContact(contact) || contactIds.has(contact.id)) return false;
    acknowledgementCount += contact.status.acknowledgedConflicts?.length ?? 0;
    if (acknowledgementCount > CONTACT_SYNC_MAX_ROWS_PER_TABLE) return false;
    contactIds.add(contact.id);
  }
  const membershipId = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.length >= 3 && candidate.length <= MAX_ID_LENGTH * 2 + 1;
  if (!isEntityArray(value.identities, isIdentityValue) || !isEntityArray(value.events, isEventValue) ||
    !isEntityArray(value.groups, isGroupValue) || !isEntityArray(value.memberships, isMembershipValue, membershipId) ||
    !isEntityArray(value.relations, isRelationValue)) return false;
  for (const membership of value.memberships) {
    if (membership.id !== contactMembershipSyncId(membership.value.value.groupId, membership.value.value.contactId)) return false;
  }
  return clocksCover(value as unknown as ContactSyncState);
}

function isSnapshotArray<T extends RowWithId>(
  value: unknown,
  validator: (candidate: unknown) => candidate is T,
  validateId: (candidate: unknown) => candidate is string = isEntityId
): value is readonly T[] {
  if (!Array.isArray(value) || value.length > CONTACT_SYNC_MAX_ROWS_PER_TABLE) return false;
  const ids = new Set<string>();
  for (const row of value) {
    if (!validator(row) || !validateId(row.id) || ids.has(row.id)) return false;
    ids.add(row.id);
  }
  return true;
}

function isSnapshotContact(value: unknown): value is ContactSnapshotContact {
  return isRecord(value) && hasOnlyKeys(value, ["id", "kind", "displayName", "aliases", "summary", "narrative", "agentNotes", "status", "source", "createdAt", "updatedAt"]) &&
    isEntityId(value.id) && isKind(value.kind) && isText(value.displayName, 1, MAX_DISPLAY_NAME) && isAliases(value.aliases) &&
    isText(value.summary, 0, MAX_SUMMARY) && isText(value.narrative, 0, Number.MAX_SAFE_INTEGER) && Buffer.byteLength(value.narrative, "utf8") <= MAX_NARRATIVE_BYTES &&
    isText(value.agentNotes, 0, MAX_AGENT_NOTES) && isStatus(value.status) && isSource(value.source) &&
    isSafeInteger(value.createdAt) && isSafeInteger(value.updatedAt) && value.updatedAt >= value.createdAt;
}

function snapshotEntity<T>(validator: (candidate: unknown) => candidate is T) {
  return (value: unknown): value is T & RowWithId => {
    if (!isRecord(value) || !isEntityId(value.id)) return false;
    const { id: _id, ...payload } = value;
    return validator(payload);
  };
}

export function isValidContactDataSnapshot(value: unknown): value is ContactDataSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, ["contacts", "identities", "events", "groups", "memberships", "relations"])) return false;
  const membershipId = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.length >= 3 && candidate.length <= MAX_ID_LENGTH * 2 + 1;
  if (!isSnapshotArray(value.contacts, isSnapshotContact) ||
    !isSnapshotArray(value.identities, snapshotEntity(isIdentityValue)) ||
    !isSnapshotArray(value.events, snapshotEntity(isEventValue)) ||
    !isSnapshotArray(value.groups, snapshotEntity(isGroupValue)) ||
    !isSnapshotArray(value.memberships, snapshotEntity(isMembershipValue), membershipId) ||
    !isSnapshotArray(value.relations, snapshotEntity(isRelationValue))) return false;
  const snapshot = value as unknown as ContactDataSnapshot;
  const contactIds = new Set(snapshot.contacts.map((contact) => contact.id));
  const groupIds = new Set(snapshot.groups.map((group) => group.id));
  const groupNames = new Set<string>();
  for (const group of snapshot.groups) {
    const key = folded(group.name);
    if (groupNames.has(key)) return false;
    groupNames.add(key);
  }
  const identities = new Set<string>();
  for (const identity of snapshot.identities) {
    if (!contactIds.has(identity.contactId)) return false;
    const key = `${identity.platform}\u0000${identity.normalizedValue}`;
    if (identities.has(key)) return false;
    identities.add(key);
  }
  if (snapshot.events.some((event) => !contactIds.has(event.contactId))) return false;
  for (const membership of snapshot.memberships) {
    if (membership.id !== contactMembershipSyncId(membership.groupId, membership.contactId) ||
      !contactIds.has(membership.contactId) || !groupIds.has(membership.groupId)) return false;
  }
  const relations = new Set<string>();
  for (const relation of snapshot.relations) {
    if (!contactIds.has(relation.fromContactId) || !contactIds.has(relation.toContactId)) return false;
    const key = `${relation.fromContactId}\u0000${relation.toContactId}\u0000${relation.relation}`;
    if (relations.has(key)) return false;
    relations.add(key);
  }
  return true;
}

function folded(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}
