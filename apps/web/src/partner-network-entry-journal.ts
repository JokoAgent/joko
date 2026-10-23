import type { PartnerNetworkOutboxStorage } from "@joko/contracts";

/** Only the input digest and operation identity survive; invitation secrets stay out of browser storage. */
export class PartnerNetworkEntryJournal {
  constructor(readonly storage: PartnerNetworkOutboxStorage, readonly owner: string) {}
  async #key(body: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([this.owner, body]))));
    return `joko.conversation-entry.v1:${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("")}`;
  }
  async read(body: string): Promise<string | undefined> {
    const saved = await this.storage.getItem(await this.#key(body)); if (!saved) return undefined;
    const row = JSON.parse(saved) as { format: number; operationId: string; confirmed: boolean };
    if (row.format !== 1 || !/^[A-Za-z0-9-]{1,100}$/u.test(row.operationId) || typeof row.confirmed !== "boolean") throw new Error("The original group entry receipt is invalid.");
    return row.confirmed ? undefined : row.operationId;
  }
  async prepare(body: string): Promise<string> {
    const existing = await this.read(body); if (existing) return existing;
    const key = await this.#key(body), id = crypto.randomUUID(), value = JSON.stringify({ format: 1, operationId: id, confirmed: false });
    await this.storage.setItem(key, value); if (await this.storage.getItem(key) !== value) throw new Error("The group entry identity was not saved."); return id;
  }
  async confirm(body: string, id: string): Promise<void> {
    if (await this.read(body) !== id) throw new Error("The original group entry identity changed.");
    await this.storage.setItem(await this.#key(body), JSON.stringify({ format: 1, operationId: id, confirmed: true }));
  }
}
