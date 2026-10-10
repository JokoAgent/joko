import type { MobileConnectionProfile, MobilePlainStorageDriver } from "./connection-storage";

const REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/u;
export type MobilePartnerCreationScope = Pick<MobileConnectionProfile, "profileId" | "serverId" | "deviceId" | "origin">;

export class MobilePartnerCreationReceipts {
  #tail = Promise.resolve();
  constructor(private readonly storage: MobilePlainStorageDriver) {}

  #key(scope: MobilePartnerCreationScope): string {
    const ids = [scope.serverId, scope.profileId, scope.deviceId];
    if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) || scope.origin.length > 4096) {
      throw new Error("The Partner creation receipt owner is invalid.");
    }
    const origin = new URL(scope.origin);
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error("The Partner creation receipt origin is invalid.");
    }
    return `joko.mobile.partner-creation.v1:${encodeURIComponent(JSON.stringify([...ids, origin.href]))}`;
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action, action);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async load(scope: MobilePartnerCreationScope, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted();
    const requestId = await this.storage.getItem(this.#key(scope));
    signal.throwIfAborted();
    if (requestId === null) return undefined;
    if (!REQUEST_ID.test(requestId)) throw new Error("The retained Partner creation receipt needs recovery.");
    return requestId;
  }

  claim(scope: MobilePartnerCreationScope, requestId: string, signal: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      signal.throwIfAborted();
      if (!REQUEST_ID.test(requestId)) throw new Error("The Partner creation request identity is invalid.");
      const key = this.#key(scope);
      if (await this.storage.getItem(key) !== null) throw new Error("Check the retained Partner creation result before starting another intent.");
      signal.throwIfAborted();
      await this.storage.setItem(key, requestId);
      if (await this.storage.getItem(key) !== requestId) throw new Error("The Partner creation receipt was not saved.");
      signal.throwIfAborted();
    });
  }

  resolve(scope: MobilePartnerCreationScope, requestId: string, signal: AbortSignal): Promise<void> {
    return this.#serialize(async () => {
      signal.throwIfAborted();
      if (!REQUEST_ID.test(requestId)) throw new Error("The Partner creation request identity is invalid.");
      const key = this.#key(scope);
      const retained = await this.storage.getItem(key);
      if (retained === null) return;
      if (retained !== requestId) throw new Error("The Partner creation receipt changed.");
      signal.throwIfAborted();
      await this.storage.removeItem(key);
      if (await this.storage.getItem(key) !== null) throw new Error("The Partner creation receipt remains unresolved.");
      signal.throwIfAborted();
    });
  }
}
