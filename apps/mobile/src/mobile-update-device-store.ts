import type { MobilePlainStorageDriver } from "./connection-storage";
import {
  mobileUpdateIdentityMaximumCharacters,
  mobileUpdateReloadMaximum,
  type MobileUpdateChannel
} from "./mobile-update";

export interface MobileUpdateDeviceState {
  readonly status: "loading" | "ready" | "error";
  readonly channel: MobileUpdateChannel;
  readonly reloadTargetId?: string;
  readonly reloadCount: number;
  readonly error?: string;
}

interface MobileUpdateDeviceRecord {
  readonly version: 1;
  readonly channel: MobileUpdateChannel;
  readonly reloadTargetId: string | null;
  readonly reloadCount: number;
}

const STORAGE_KEY = "joko.mobile.update.v1";
const DEFAULT_RECORD: MobileUpdateDeviceRecord = Object.freeze({
  version: 1,
  channel: "stable",
  reloadTargetId: null,
  reloadCount: 0
});

export class MobileUpdateDeviceStore {
  #record: MobileUpdateDeviceRecord = DEFAULT_RECORD;
  #state: MobileUpdateDeviceState = { status: "loading", channel: "stable", reloadCount: 0 };
  #hydrate?: Promise<void>;
  #mutation: Promise<void> = Promise.resolve();

  constructor(private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">) {}

  get snapshot(): MobileUpdateDeviceState { return this.#state; }

  hydrate(): Promise<void> {
    if (this.#state.status !== "loading") {
      return this.#state.status === "ready"
        ? Promise.resolve()
        : Promise.reject(new Error(this.#state.error ?? "The mobile update settings are unavailable."));
    }
    if (this.#hydrate) return this.#hydrate;
    this.#hydrate = this.#read();
    return this.#hydrate;
  }

  async setChannel(channel: MobileUpdateChannel): Promise<void> {
    this.#assertReady();
    if (channel !== "stable" && channel !== "beta") throw new Error("The mobile update channel is invalid.");
    await this.#mutate((record) => record.channel === channel ? record : { ...record, channel });
  }

  isReloadBlocked(targetUpdateId: string): boolean {
    this.#assertReady();
    return this.#record.reloadTargetId === targetUpdateId
      && this.#record.reloadCount >= mobileUpdateReloadMaximum;
  }

  async recordReload(targetUpdateId: string): Promise<void> {
    this.#assertReady();
    if (!isUpdateId(targetUpdateId)) throw new Error("The mobile update identity is invalid.");
    await this.#mutate((record) => ({
      ...record,
      reloadTargetId: targetUpdateId,
      reloadCount: record.reloadTargetId === targetUpdateId
        ? Math.min(mobileUpdateReloadMaximum, record.reloadCount + 1)
        : 1
    }));
  }

  async cancelReload(targetUpdateId: string): Promise<void> {
    this.#assertReady();
    if (!isUpdateId(targetUpdateId)) throw new Error("The mobile update identity is invalid.");
    await this.#mutate((record) => {
      if (record.reloadTargetId !== targetUpdateId) return record;
      if (record.reloadCount <= 1) return { ...record, reloadTargetId: null, reloadCount: 0 };
      return { ...record, reloadCount: record.reloadCount - 1 };
    });
  }

  async clearReloadIfLaunched(currentUpdateId: string | undefined): Promise<void> {
    this.#assertReady();
    if (currentUpdateId === undefined) return;
    await this.#mutate((record) => record.reloadTargetId !== currentUpdateId
      ? record
      : { ...record, reloadTargetId: null, reloadCount: 0 });
  }

  async reset(): Promise<void> {
    await this.#enqueue(async () => {
      await this.storage.setItem(STORAGE_KEY, serialize(DEFAULT_RECORD));
      this.#record = DEFAULT_RECORD;
      this.#state = stateFromRecord(DEFAULT_RECORD);
    });
  }

  async #read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      const record = raw === null ? DEFAULT_RECORD : parse(raw);
      this.#record = record;
      this.#state = stateFromRecord(record);
    } catch (cause) {
      const error = `The saved mobile update settings are unavailable: ${errorText(cause)}`;
      this.#state = { status: "error", channel: "stable", reloadCount: 0, error };
      throw new Error(error);
    }
  }

  #mutate(change: (record: MobileUpdateDeviceRecord) => MobileUpdateDeviceRecord): Promise<void> {
    return this.#enqueue(async () => {
      const record = change(this.#record);
      if (record === this.#record) return;
      await this.storage.setItem(STORAGE_KEY, serialize(record));
      this.#record = Object.freeze(record);
      this.#state = stateFromRecord(this.#record);
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  #assertReady(): void {
    if (this.#state.status !== "ready") throw new Error("The mobile update settings are not ready.");
  }
}

function parse(raw: string): MobileUpdateDeviceRecord {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("the record is not an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys[0] !== "channel" || keys[1] !== "reloadCount"
    || keys[2] !== "reloadTargetId" || keys[3] !== "version" || record.version !== 1
    || record.channel !== "stable" && record.channel !== "beta"
    || !Number.isInteger(record.reloadCount) || (record.reloadCount as number) < 0
    || (record.reloadCount as number) > mobileUpdateReloadMaximum
    || !(record.reloadTargetId === null || isUpdateId(record.reloadTargetId))
    || (record.reloadTargetId === null) !== (record.reloadCount === 0)) {
    throw new Error("the record is not the current v1 shape");
  }
  return Object.freeze({
    version: 1,
    channel: record.channel,
    reloadTargetId: record.reloadTargetId,
    reloadCount: record.reloadCount
  }) as MobileUpdateDeviceRecord;
}

function serialize(record: MobileUpdateDeviceRecord): string {
  return JSON.stringify(record);
}

function stateFromRecord(record: MobileUpdateDeviceRecord): MobileUpdateDeviceState {
  return Object.freeze({
    status: "ready",
    channel: record.channel,
    ...(record.reloadTargetId === null ? {} : { reloadTargetId: record.reloadTargetId }),
    reloadCount: record.reloadCount
  });
}

function isUpdateId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= mobileUpdateIdentityMaximumCharacters
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function errorText(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "storage failed";
}

export const mobileUpdateDeviceStorageKey = STORAGE_KEY;
