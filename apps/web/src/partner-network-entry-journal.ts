import type { PartnerNetworkOutboxStorage } from "@joko/contracts";
import { withLocalReceiptLock } from "./local-state.js";

interface EntryReceipt { readonly format: 1; readonly operationId: string; readonly confirmed: boolean; }

/** Only the input digest and operation identity survive; invitation secrets stay out of browser storage. */
export class PartnerNetworkEntryJournal {
  constructor(readonly storage: PartnerNetworkOutboxStorage, readonly owner: string) {}
  async #key(body: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([this.owner, body]))));
    return `joko.conversation-entry.v1:${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("")}`;
  }
  async #read(key: string): Promise<EntryReceipt | undefined> {
    const saved = await this.storage.getItem(key);
    if (saved === null) return undefined;
    const row = JSON.parse(saved) as Partial<EntryReceipt> | null;
    if (row?.format !== 1 || typeof row.operationId !== "string" || !/^[A-Za-z0-9-]{1,100}$/u.test(row.operationId)
      || typeof row.confirmed !== "boolean") throw new Error("The original group entry receipt is invalid.");
    return { format: 1, operationId: row.operationId, confirmed: row.confirmed };
  }
  async #save(key: string, row: EntryReceipt): Promise<void> {
    const value = JSON.stringify(row);
    await this.storage.setItem(key, value);
    if (await this.storage.getItem(key) !== value) throw new Error("The group entry identity was not saved.");
  }
  async read(body: string): Promise<string | undefined> {
    const row = await this.#read(await this.#key(body));
    return row?.confirmed ? undefined : row?.operationId;
  }
  async prepare(body: string): Promise<string> {
    const key = await this.#key(body);
    return withLocalReceiptLock(window, key, async () => {
      const row = await this.#read(key);
      if (row && !row.confirmed) return row.operationId;
      const operationId = crypto.randomUUID();
      await this.#save(key, { format: 1, operationId, confirmed: false });
      return operationId;
    });
  }
  async confirm(body: string, id: string): Promise<void> {
    const key = await this.#key(body);
    await withLocalReceiptLock(window, key, async () => {
      const row = await this.#read(key);
      if (!row) throw new Error("The original group entry identity changed.");
      if (row.operationId !== id || row.confirmed) return;
      await this.#save(key, { ...row, confirmed: true });
    });
  }
}
