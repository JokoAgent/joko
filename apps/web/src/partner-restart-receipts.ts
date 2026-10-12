import type { ConnectionProfile } from "./model.js";

/** Only opaque IDs are persisted, before a destructive request can be sent. */
export class PartnerRestartReceipts {
  readonly #prefix: string;
  constructor(private readonly storage: Storage, profile: ConnectionProfile | undefined) {
    if (!profile?.id || !profile.serverId || !profile.deviceId) throw new Error("The Partner restart owner is unavailable.");
    const origin = new URL(profile.origin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error("The Partner restart origin is invalid.");
    }
    this.#prefix = `joko.partner.restart.v1:${encodeURIComponent(JSON.stringify([profile.serverId, profile.id, profile.deviceId, origin.href]))}:`;
  }
  list(): readonly string[] {
    const ids: string[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.#prefix)) continue;
      const id = key.slice(this.#prefix.length);
      if (!/^[A-Za-z0-9_-]{16,80}$/u.test(id) || this.storage.getItem(key) !== id || ids.length >= 32) {
        throw new Error("The Partner restart receipts need recovery.");
      }
      ids.push(id);
    }
    return ids.sort();
  }
  claim(id: string): void {
    if (!/^[A-Za-z0-9_-]{16,80}$/u.test(id) || this.list().length >= 32) throw new Error("The Partner restart receipt could not be saved.");
    this.storage.setItem(this.#prefix + id, id);
    if (this.storage.getItem(this.#prefix + id) !== id) throw new Error("The Partner restart receipt was not saved.");
  }
  resolve(id: string): void {
    if (!/^[A-Za-z0-9_-]{16,80}$/u.test(id)) throw new Error("The Partner restart request identity is invalid.");
    this.storage.removeItem(this.#prefix + id);
    if (this.storage.getItem(this.#prefix + id) !== null) throw new Error("The Partner restart receipt is still pending.");
  }
}
