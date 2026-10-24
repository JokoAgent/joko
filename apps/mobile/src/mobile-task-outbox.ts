import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ModelSelectionSchema, PermissionMode, QueueDeliveryMode, type Session } from "@joko/contracts";
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
  readonly state: "staging" | "queued" | "confirming" | "failed" | "restoring" | "settled";
  readonly attempted: boolean;
  readonly failureKind?: "preparation" | "not-admitted" | "rejected";
  readonly error?: string;
}

const storageKey = "joko.mobile.task-outbox.v1";
const maximumRecords = 200;
const maximumStoredCharacters = 24_200_000;

/** Write-through ownership: an input is visible only after its durable write. */
export class MobileTaskOutboxStore {
  #records: readonly MobileTaskOutboxRecord[] = [];
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
        const records = (parsed as { records: unknown[] }).records.map(readRecord);
        if (records.length > maximumRecords || new Set(records.map((record) => record.id)).size !== records.length
          || new Set(records.map((record) => record.operationId)).size !== records.length) {
          throw new Error("The retained task outbox contains invalid identities.");
        }
        this.#records = records;
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
    "operationId" | "input" | "sourceDraft" | "state" | "attempted" | "failureKind" | "error">>): Promise<MobileTaskOutboxRecord> {
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
    return this.#mutate((records) => ({ records: records.filter((record) => record.owner.profileId !== profileId), result: undefined }));
  }

  async #mutate<T>(change: (records: readonly MobileTaskOutboxRecord[]) => { records: readonly MobileTaskOutboxRecord[]; result: T }): Promise<T> {
    await this.load();
    return this.#serialize(async () => {
      const next = change(this.#records);
      if (next.records.length > maximumRecords) throw new Error("The task outbox is full. Remove an unsent input before adding another.");
      const body = JSON.stringify({ format: 1, records: next.records });
      if (body.length > maximumStoredCharacters) throw new Error("The task outbox exceeds its storage limit.");
      await this.driver.setItem(storageKey, body);
      this.#records = next.records;
      return next.result;
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function mobileTaskOutboxOwnerMatches(left: MobileTaskOutboxOwner, right: MobileTaskOutboxOwner): boolean {
  return left.profileId === right.profileId && left.origin === right.origin && left.serverId === right.serverId
    && left.connectionId === right.connectionId && left.deviceId === right.deviceId;
}

export function mobileTaskOutboxModel(session: Session): string | undefined {
  return session.model === undefined ? undefined : toJsonString(ModelSelectionSchema, session.model);
}

function readRecord(value: unknown): MobileTaskOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The retained task input is damaged.");
  const record = value as MobileTaskOutboxRecord;
  for (const id of [record.id, record.operationId, record.sessionId, record.backendId, record.targetId,
    record.owner?.profileId, record.owner?.serverId, record.owner?.connectionId, record.owner?.deviceId]) {
    if (typeof id !== "string" || !id.trim() || id.length > 1_024 || /[\u0000-\u001f]/u.test(id)) {
      throw new Error("The retained task input has an invalid owner.");
    }
  }
  if (typeof record.owner.origin !== "string" || record.owner.origin.length > 2_048
    || !/^https?:\/\//u.test(record.owner.origin) || new URL(record.owner.origin).origin !== record.owner.origin
    || !/^[1-9]\d*$/u.test(record.runtimeGeneration) || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || ![QueueDeliveryMode.PROMPT, QueueDeliveryMode.STEER, QueueDeliveryMode.FOLLOW_UP].includes(record.deliveryMode)
    || !Number.isSafeInteger(record.permissionMode) || !Object.values(PermissionMode).includes(record.permissionMode)
    || typeof record.planMode !== "boolean" || typeof record.attempted !== "boolean"
    || !["staging", "queued", "confirming", "failed", "restoring", "settled"].includes(record.state)
    || !Array.isArray(record.storageIds) || record.storageIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(id))
    || new Set(record.storageIds).size !== record.storageIds.length
    || record.state === "confirming" && !record.attempted
    || record.state === "staging" && record.attempted
    || record.failureKind !== undefined && !["preparation", "not-admitted", "rejected"].includes(record.failureKind)
    || (record.state === "failed") !== (record.failureKind !== undefined)
    || record.error !== undefined && (typeof record.error !== "string" || record.error.length > 4_096)) {
    throw new Error("The retained task input contains invalid delivery state.");
  }
  if (record.modelJson !== undefined) fromJsonString(ModelSelectionSchema, record.modelJson);
  const input = normalizeMobileComposerDraft(record.input);
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
    ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
    ...(record.error === undefined ? {} : { error: record.error })
  };
}
