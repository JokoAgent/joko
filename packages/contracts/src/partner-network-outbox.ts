import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { SendPartnerNetworkRequestSchema, type SendPartnerNetworkRequest } from "./gen/joko/v1/partner_network_pb.js";

export interface PartnerNetworkOutboxStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): unknown | Promise<unknown>;
}
export interface PartnerNetworkOutboxEntry {
  readonly request: SendPartnerNetworkRequest;
  readonly createdAt: number;
  readonly messageId?: string;
}
interface StoredEntry { readonly request: string; readonly createdAt: number; readonly messageId?: string; }

/** A retained request is an exact retry identity, never permission to resend automatically. */
export class PartnerNetworkSendJournal {
  readonly #entries = new Map<string, StoredEntry>();
  readonly #key: string;
  #tail = Promise.resolve();
  #loaded = false;
  #loadFlight: Promise<readonly PartnerNetworkOutboxEntry[]> | undefined;
  constructor(readonly storage: PartnerNetworkOutboxStorage, readonly scope: string) {
    if (!scope || scope.length > 2048 || /[\0\r\n]/u.test(scope)) throw new Error("The conversation outbox owner is invalid.");
    this.#key = `joko.conversation-outbox.v1:${scope}`;
  }
  initialize(): Promise<readonly PartnerNetworkOutboxEntry[]> {
    if (this.#loaded) return Promise.resolve(this.list());
    return this.#loadFlight ??= this.#load().catch(error => { this.#loadFlight = undefined; throw error; });
  }
  async #load(): Promise<readonly PartnerNetworkOutboxEntry[]> {
    const text = await this.storage.getItem(this.#key);
    if (text !== null) {
      if (text.length > 4 * 1024 * 1024) throw new Error("The conversation outbox is too large.");
      const disk = JSON.parse(text) as { format: number; scope: string; entries: StoredEntry[] };
      if (disk.format !== 1 || disk.scope !== this.scope || !Array.isArray(disk.entries) || disk.entries.length > 1000) throw new Error("Rebuild incompatible development outbox data.");
      const entries = new Map<string, StoredEntry>();
      for (const entry of disk.entries) {
        const request = fromJsonString(SendPartnerNetworkRequestSchema, entry.request);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(request.operationId) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
          || entries.has(request.operationId) || entry.messageId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(entry.messageId)) throw new Error("The conversation outbox is invalid.");
        entries.set(request.operationId, { ...entry });
      }
      for (const [id, entry] of entries) this.#entries.set(id, entry);
    }
    this.#loaded = true; return this.list();
  }
  list(): readonly PartnerNetworkOutboxEntry[] {
    return [...this.#entries.values()].map(entry => ({ request: fromJsonString(SendPartnerNetworkRequestSchema, entry.request), createdAt: entry.createdAt,
      ...(entry.messageId ? { messageId: entry.messageId } : {}) }));
  }
  async prepare(request: SendPartnerNetworkRequest, createdAt = Date.now()): Promise<void> {
    if (!this.#loaded) throw new Error("Read the original conversation outbox before sending.");
    const value = toJsonString(SendPartnerNetworkRequestSchema, request), previous = this.#entries.get(request.operationId);
    if (previous && previous.request !== value) throw new Error("The send request already names different input.");
    this.#entries.set(request.operationId, previous ?? { request: value, createdAt });
    await this.#save();
  }
  async acknowledge(operationId: string, messageId: string): Promise<void> {
    if (!this.#loaded) await this.initialize();
    const previous = this.#entries.get(operationId); if (!previous || previous.messageId && previous.messageId !== messageId) throw new Error("The send receipt changed identity.");
    this.#entries.set(operationId, { ...previous, messageId }); await this.#save();
  }
  async displayed(messageIds: ReadonlySet<string>): Promise<void> {
    if (!this.#loaded) await this.initialize();
    let changed = false; for (const [id, entry] of this.#entries) if (entry.messageId && messageIds.has(entry.messageId)) { this.#entries.delete(id); changed = true; }
    if (changed) await this.#save();
  }
  #save(): Promise<void> {
    const text = JSON.stringify({ format: 1, scope: this.scope, entries: [...this.#entries.values()] });
    if (text.length > 4 * 1024 * 1024) throw new Error("The conversation outbox is full. Resolve retained messages first.");
    const pending = this.#tail.then(async () => { await this.storage.setItem(this.#key, text);
      if (await this.storage.getItem(this.#key) !== text) throw new Error("The original send identity was not saved."); });
    this.#tail = pending.catch(() => {}); return pending;
  }
}
