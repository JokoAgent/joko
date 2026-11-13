import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { MessageRole, ModelSelectionSchema, PermissionMode, QueueDeliveryMode, QueueSourceKind,
  type Event, type QueueItem, type Session } from "@joko/contracts";
import type { MobileConnectionProfile, MobilePlainStorageDriver } from "./connection-storage";
import { normalizeMobileComposerDraft, type MobileComposerDraft } from "./mobile-composer-document";

export type MobileTaskOutboxOwner = Pick<MobileConnectionProfile, "profileId" | "origin" | "serverId" | "connectionId" | "deviceId">;

export interface MobileTaskOutboxRecord {
  readonly id: string;
  readonly operationId: string;
  readonly owner: MobileTaskOutboxOwner;
  readonly sessionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly runtimeGeneration: string;
  readonly createdAt: number;
  readonly deliveryMode: QueueDeliveryMode;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly modelJson?: string;
  readonly input: MobileComposerDraft;
  /** Only this enqueue owns these copied local files, even after composer edits. */
  readonly storageIds: readonly string[];
  /** Reconciled before delivery, including after an interrupted composer handoff. */
  readonly sourceDraft?: MobileComposerDraft;
  readonly state: "staging" | "queued" | "confirming" | "failed" | "restoring" | "accepted" | "settled";
  readonly attempted: boolean;
  /** The node owns delivery. Keep the local input until its exact history is saved. */
  readonly queueReceipt?: {
    readonly queueItemId: string;
    readonly runId: string;
    readonly inputKey?: string;
    readonly historyEventId?: string;
  };
  readonly failureKind?: "preparation" | "not-admitted" | "rejected";
  readonly error?: string;
  /** The actual current upload slot, retained on a preparation failure. */
  readonly uploadAttachmentId?: string;
  readonly providerGroupRebalance?: { readonly suggestionKey: string; readonly remember: boolean };
}

const storageKey = "joko.mobile.task-outbox.v1";
const maximumRecords = 200;
const maximumStoredCharacters = 24_200_000;

/** Write-through ownership: an input is visible only after its durable write. */
export class MobileTaskOutboxStore {
  #records: readonly MobileTaskOutboxRecord[] = [];
  #unreadable: readonly UnreadableOutboxRecord[] = [];
  #loaded = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(readonly driver: MobilePlainStorageDriver) {}

  get records(): readonly MobileTaskOutboxRecord[] { return this.#records; }

  load(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#loaded) return;
      const raw = await this.driver.getItem(storageKey);
      if (raw !== null) {
        if (raw.length > maximumStoredCharacters) throw new Error("The retained task outbox exceeds its storage limit.");
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || (parsed as { format?: unknown }).format !== 1 || !Array.isArray((parsed as { records?: unknown }).records)) {
          throw new Error("The retained task outbox is damaged.");
        }
        const stored = (parsed as { records: unknown[] }).records;
        if (stored.length > maximumRecords) {
          throw new Error("The retained task outbox contains invalid identities.");
        }
        const ids = new Set<string>(), operationIds = new Set<string>();
        const records: MobileTaskOutboxRecord[] = [], unreadableIndexes: number[] = [];
        for (const [index, value] of stored.entries()) {
          const recordId = storedIdentity(value, "id"), operationId = storedIdentity(value, "operationId");
          if ((recordId !== undefined && ids.has(recordId)) || (operationId !== undefined && operationIds.has(operationId))) {
            throw new Error("The retained task outbox contains invalid identities.");
          }
          if (recordId !== undefined) ids.add(recordId);
          if (operationId !== undefined) operationIds.add(operationId);
          try { records.push(readRecord(value)); }
          catch { unreadableIndexes.push(index); }
        }
        const sources = unreadableIndexes.length === 0 ? [] : taskOutboxRecordSources(raw, stored.length, new Set(unreadableIndexes));
        this.#records = records;
        this.#unreadable = unreadableIndexes.map((index, offset) => ({
          id: storedIdentity(stored[index], "id"), operationId: storedIdentity(stored[index], "operationId"),
          profileId: storedIdentity(storedProperty(stored[index], "owner"), "profileId"), source: sources[offset]!
        }));
      }
      this.#loaded = true;
    });
  }

  add(record: MobileTaskOutboxRecord): Promise<MobileTaskOutboxRecord> {
    return this.#mutate((records) => {
      const exact = readRecord(record);
      if (records.some((value) => value.id === exact.id || value.operationId === exact.operationId)) {
        throw new Error("This task input is already retained.");
      }
      return { records: [...records, exact], result: exact };
    });
  }

  update(record: MobileTaskOutboxRecord, patch: Partial<Pick<MobileTaskOutboxRecord,
    "operationId" | "input" | "sourceDraft" | "state" | "attempted" | "queueReceipt" | "failureKind" | "error" | "uploadAttachmentId">>): Promise<MobileTaskOutboxRecord> {
    return this.#mutate((records) => {
      if (!records.includes(record)) throw new Error("The retained task input changed.");
      const next = readRecord({ ...record, ...patch });
      if (records.some((value) => value !== record && value.operationId === next.operationId)) {
        throw new Error("This task operation is already retained.");
      }
      return { records: records.map((value) => value === record ? next : value), result: next };
    });
  }

  remove(record: MobileTaskOutboxRecord): Promise<void> {
    return this.#mutate((records) => {
      if (!records.includes(record)) throw new Error("The retained task input changed.");
      return { records: records.filter((value) => value !== record), result: undefined };
    });
  }

  clearProfile(profileId: string): Promise<void> {
    return this.#mutate((records) => ({ records: records.filter((record) => record.owner.profileId !== profileId), result: undefined }), profileId);
  }

  async #mutate<T>(change: (records: readonly MobileTaskOutboxRecord[]) => { records: readonly MobileTaskOutboxRecord[]; result: T }, clearProfileId?: string): Promise<T> {
    await this.load();
    return this.#serialize(async () => {
      const next = change(this.#records);
      const unreadable = clearProfileId === undefined ? this.#unreadable
        : this.#unreadable.filter(record => record.profileId !== clearProfileId);
      if (next.records.length + unreadable.length > maximumRecords) throw new Error("The task outbox is full. Remove an unsent input before adding another.");
      let body: string;
      if (unreadable.length > 0) {
        const reservedIds = new Set(unreadable.map(record => record.id));
        const reservedOperations = new Set(unreadable.map(record => record.operationId));
        if (next.records.some(record => reservedIds.has(record.id) || reservedOperations.has(record.operationId))) {
          throw new Error("This task input conflicts with a retained unreadable record.");
        }
        const entries = next.records.map(record => JSON.stringify(record));
        for (const record of unreadable) entries.push(record.source);
        body = `{"format":1,"records":[${entries.join(",")}]}`;
      } else {
        body = JSON.stringify({ format: 1, records: next.records });
      }
      if (body.length > maximumStoredCharacters) throw new Error("The task outbox exceeds its storage limit.");
      await this.driver.setItem(storageKey, body);
      this.#records = next.records;
      this.#unreadable = unreadable;
      return next.result;
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface UnreadableOutboxRecord {
  readonly id: string | undefined;
  readonly operationId: string | undefined;
  readonly profileId: string | undefined;
  readonly source: string;
}

/** Retain the exact JSON of a damaged entry when another entry advances. */
function taskOutboxRecordSources(raw: string, recordCount: number, unreadableIndexes: ReadonlySet<number>): string[] {
  // The envelope already passed JSON.parse. Only find its entry boundaries.
  let arrayStart: number | undefined;
  let cursor = afterJsonSpace(raw, afterJsonSpace(raw, 0) + 1);
  while (raw[cursor] !== "}") {
    const keyEnd = afterJsonString(raw, cursor);
    const key = JSON.parse(raw.slice(cursor, keyEnd)) as string;
    const start = afterJsonSpace(raw, afterJsonSpace(raw, keyEnd) + 1);
    if (key === "records") arrayStart = raw[start] === "[" ? start : undefined;
    const delimiter = afterJsonSpace(raw, afterJsonValue(raw, start));
    cursor = raw[delimiter] === "," ? afterJsonSpace(raw, delimiter + 1) : delimiter;
  }
  const sources: string[] = [];
  let count = 0;
  if (arrayStart !== undefined) {
    let start = afterJsonSpace(raw, arrayStart + 1);
    while (raw[start] !== "]") {
      const end = afterJsonValue(raw, start);
      if (unreadableIndexes.has(count)) sources.push(raw.slice(start, end));
      count += 1;
      const delimiter = afterJsonSpace(raw, end);
      start = raw[delimiter] === "," ? afterJsonSpace(raw, delimiter + 1) : delimiter;
    }
  }
  if (count !== recordCount) throw new Error("The retained task outbox record positions are invalid.");
  return sources;
}

function afterJsonSpace(raw: string, start: number): number {
  let cursor = start;
  while (cursor < raw.length && " \r\n\t".includes(raw[cursor]!)) cursor += 1;
  return cursor;
}

function afterJsonString(raw: string, start: number): number {
  let cursor = start + 1;
  while (cursor < raw.length) {
    const character = raw[cursor++];
    if (character === '"') return cursor;
    if (character === "\\") cursor += 1;
  }
  throw new Error("The retained task outbox string is incomplete.");
}

function afterJsonValue(raw: string, start: number): number {
  let depth = 0, cursor = start;
  while (cursor < raw.length) {
    const character = raw[cursor]!;
    if (character === '"') { cursor = afterJsonString(raw, cursor); continue; }
    if (character === "{" || character === "[") depth += 1;
    else if (depth === 0 && ",}] \r\n\t".includes(character)) return cursor;
    else if (character === "}" || character === "]") depth -= 1;
    cursor += 1;
  }
  return cursor;
}

function storedProperty(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function storedIdentity(value: unknown, key: string): string | undefined {
  const property = storedProperty(value, key);
  return validIdentity(property) ? property : undefined;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 1_024 && !/[\u0000-\u001f]/u.test(value);
}

export function mobileTaskOutboxOwnerMatches(left: MobileTaskOutboxOwner, right: MobileTaskOutboxOwner): boolean {
  return left.profileId === right.profileId && left.origin === right.origin && left.serverId === right.serverId
    && left.connectionId === right.connectionId && left.deviceId === right.deviceId;
}

export function mobileTaskOutboxModel(session: Session): string | undefined {
  return session.model === undefined ? undefined : toJsonString(ModelSelectionSchema, session.model);
}

export function mobileTaskOutboxSessionMatches(record: MobileTaskOutboxRecord, session: Session): boolean {
  return session.sessionId === record.sessionId && session.backendId === record.backendId && session.targetId === record.targetId
    && session.nativeBinding?.runtimeGeneration.toString() === record.runtimeGeneration;
}

export function mobileTaskOutboxQueueMatches(record: MobileTaskOutboxRecord, item: QueueItem): boolean {
  return item.sourceId === record.operationId && item.sourceKind === QueueSourceKind.UI
    && item.sessionId === record.sessionId && item.backendId === record.backendId && item.targetId === record.targetId
    && validIdentity(item.queueItemId) && validIdentity(item.runId)
    && (!record.queueReceipt || item.queueItemId === record.queueReceipt.queueItemId && item.runId === record.queueReceipt.runId);
}

export function mobileTaskOutboxHistoryMatches(record: MobileTaskOutboxRecord, event: Event): boolean {
  const receipt = record.queueReceipt, identity = event.identity, payload = event.payload?.kind;
  return receipt !== undefined && event.eventId !== "" && identity !== undefined && identity.operationId === record.operationId
    && identity.queueItemId === receipt.queueItemId && identity.runId === receipt.runId
    && identity.sessionId === record.sessionId && identity.backendId === record.backendId && identity.targetId === record.targetId
    && identity.generation.toString() === record.runtimeGeneration && payload?.case === "messageStarted"
    && payload.value.role === MessageRole.USER && payload.value.userInputAccepted && payload.value.userInput !== undefined;
}

export function mobileTaskOutboxHistoryDeleted(record: MobileTaskOutboxRecord, event: Event): boolean {
  const eventId = record.queueReceipt?.historyEventId, identity = event.identity, payload = event.payload?.kind;
  return eventId !== undefined && identity?.sessionId === record.sessionId && identity.backendId === record.backendId
    && identity.targetId === record.targetId && identity.generation.toString() === record.runtimeGeneration
    && payload?.case === "messageDeleted" && payload.value.productSessionId === record.sessionId
    && payload.value.deletedEventIds.includes(eventId);
}

function readRecord(value: unknown): MobileTaskOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The retained task input is damaged.");
  const record = value as MobileTaskOutboxRecord;
  for (const id of [record.id, record.operationId, record.sessionId, record.backendId, record.targetId,
    record.owner?.profileId, record.owner?.serverId, record.owner?.connectionId, record.owner?.deviceId]) {
    if (!validIdentity(id)) {
      throw new Error("The retained task input has an invalid owner.");
    }
  }
  if (typeof record.owner.origin !== "string" || record.owner.origin.length > 2_048
    || !/^https?:\/\//u.test(record.owner.origin) || new URL(record.owner.origin).origin !== record.owner.origin
    || !/^[1-9]\d*$/u.test(record.runtimeGeneration) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || ![QueueDeliveryMode.PROMPT, QueueDeliveryMode.STEER, QueueDeliveryMode.FOLLOW_UP].includes(record.deliveryMode)
    || !Number.isSafeInteger(record.permissionMode) || !Object.values(PermissionMode).includes(record.permissionMode)
    || typeof record.planMode !== "boolean" || typeof record.attempted !== "boolean"
    || !["staging", "queued", "confirming", "failed", "restoring", "accepted", "settled"].includes(record.state)
    || !Array.isArray(record.storageIds) || record.storageIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(id))
    || new Set(record.storageIds).size !== record.storageIds.length
    || record.state === "confirming" && !record.attempted
    || record.state === "staging" && record.attempted
    || record.failureKind !== undefined && !["preparation", "not-admitted", "rejected"].includes(record.failureKind)
    || (record.state === "failed") !== (record.failureKind !== undefined)
    || record.error !== undefined && (typeof record.error !== "string" || record.error.length > 4_096)) {
    throw new Error("The retained task input contains invalid delivery state.");
  }
  const receipt = record.queueReceipt;
  if ((record.state === "accepted") !== (receipt !== undefined) || receipt !== undefined
    && (!receipt || !record.attempted || !validIdentity(receipt.queueItemId) || !validIdentity(receipt.runId)
      || receipt.inputKey !== undefined && !/^[a-f0-9]{64}$/u.test(receipt.inputKey)
      || receipt.historyEventId !== undefined && !validIdentity(receipt.historyEventId))) {
    throw new Error("The retained task input has an invalid queue receipt.");
  }
  if (record.modelJson !== undefined) fromJsonString(ModelSelectionSchema, record.modelJson);
  const rebalance = record.providerGroupRebalance;
  if (rebalance !== undefined && (!rebalance || typeof rebalance !== "object" || Array.isArray(rebalance)
    || Object.keys(rebalance).sort().join(",") !== "remember,suggestionKey" || !/^rebalance_[a-f0-9]{64}$/u.test(rebalance.suggestionKey)
    || typeof rebalance.remember !== "boolean")) throw new Error("The retained account switch does not match its original confirmation.");
  const input = normalizeMobileComposerDraft(record.input);
  if (record.uploadAttachmentId !== undefined && (typeof record.uploadAttachmentId !== "string" || record.attempted
    || !["queued", "failed"].includes(record.state) || record.state === "failed" && record.failureKind !== "preparation"
    || input.attachments.filter(item => item.attachmentId === record.uploadAttachmentId && item.state === "local").length !== 1)) {
    throw new Error("The retained task input has an invalid upload slot.");
  }
  if (!input.text.trim() && input.attachments.length === 0) throw new Error("The retained task input is empty.");
  if (record.attempted && input.attachments.some((attachment) => attachment.state !== "uploaded")) {
    throw new Error("A dispatched task input must retain its exact committed attachments.");
  }
  return {
    id: record.id, operationId: record.operationId, owner: { profileId: record.owner.profileId, origin: record.owner.origin,
      serverId: record.owner.serverId, connectionId: record.owner.connectionId, deviceId: record.owner.deviceId },
    sessionId: record.sessionId, backendId: record.backendId, targetId: record.targetId, runtimeGeneration: record.runtimeGeneration,
    createdAt: record.createdAt, deliveryMode: record.deliveryMode, permissionMode: record.permissionMode, planMode: record.planMode,
    ...(record.modelJson === undefined ? {} : { modelJson: record.modelJson }), input, storageIds: [...record.storageIds],
    ...(record.sourceDraft === undefined ? {} : { sourceDraft: normalizeMobileComposerDraft(record.sourceDraft) }),
    state: record.state, attempted: record.attempted,
    ...(receipt === undefined ? {} : { queueReceipt: { queueItemId: receipt.queueItemId, runId: receipt.runId,
      ...(receipt.inputKey === undefined ? {} : { inputKey: receipt.inputKey }),
      ...(receipt.historyEventId === undefined ? {} : { historyEventId: receipt.historyEventId }) } }),
    ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(rebalance ? { providerGroupRebalance: { suggestionKey: rebalance.suggestionKey, remember: rebalance.remember } } : {}),
    ...(record.uploadAttachmentId === undefined ? {} : { uploadAttachmentId: record.uploadAttachmentId })
  };
}
