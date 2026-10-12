import type { ConnectionProfile } from "./model.js";

const PREFIX = "joko.partner.creation.v1:";
const REQUEST_ID = /^[A-Za-z0-9_-]{16,80}$/u;
const MAX_PENDING = 32;

/** Only opaque request IDs are retained; never persist a creation draft or credentials. */
export class PartnerCreationReceipts {
  readonly #storage: Storage;
  readonly #prefix: string;

  constructor(storage: Storage, profile: ConnectionProfile | undefined) {
    if (profile === undefined || !profile.id || !profile.serverId || !profile.deviceId) {
      throw new Error("The partner creation owner is unavailable.");
    }
    const origin = new URL(profile.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error("The partner creation owner is invalid.");
    }
    this.#storage = storage;
    this.#prefix = `${PREFIX}${encodeURIComponent(JSON.stringify([profile.serverId, profile.id, profile.deviceId, origin.href]))}:`;
  }

  list(): readonly string[] {
    const result: string[] = [];
    for (let index = 0; index < this.#storage.length; index += 1) {
      const key = this.#storage.key(index);
      if (key === null || !key.startsWith(this.#prefix)) continue;
      const requestId = key.slice(this.#prefix.length);
      if (!REQUEST_ID.test(requestId) || this.#storage.getItem(key) !== requestId || result.length >= MAX_PENDING) {
        throw new Error("The pending partner creation receipts require recovery.");
      }
      result.push(requestId);
    }
    return result.sort();
  }

  claim(requestId: string): void {
    if (!REQUEST_ID.test(requestId) || this.list().length >= MAX_PENDING) {
      throw new Error("A partner creation receipt could not be saved.");
    }
    const key = this.#prefix + requestId;
    this.#storage.setItem(key, requestId);
    if (this.#storage.getItem(key) !== requestId) throw new Error("The partner creation receipt was not saved.");
  }

  resolve(requestId: string): void {
    if (!REQUEST_ID.test(requestId)) throw new Error("The partner creation receipt is invalid.");
    const key = this.#prefix + requestId;
    this.#storage.removeItem(key);
    if (this.#storage.getItem(key) !== null) throw new Error("The partner creation receipt remains pending.");
  }
}
