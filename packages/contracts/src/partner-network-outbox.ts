import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { SendPartnerNetworkRequestSchema, type SendPartnerNetworkRequest } from "./gen/joko/v1/partner_network_pb.js";
import { serializeLocalReceipt } from "./local-receipt-lock.js";

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
const validId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const maximumCharacters = 4 * 1024 * 1024;
const maximumEntries = 1000;

/** A retained request is an exact retry identity, never permission to resend automatically. */
export class PartnerNetworkSendJournal {
  #entries = new Map<string, StoredEntry>();
  readonly #key: string;
  #lastRead: string | null = null;
  #loaded = false;
  #loadFlight: Promise<readonly PartnerNetworkOutboxEntry[]> | undefined;
  constructor(readonly storage: PartnerNetworkOutboxStorage, readonly scope: string,
    private readonly exclusive: (key: string, update: () => Promise<void>) => Promise<void> = serializeLocalReceipt) {
    if (!scope || scope.length > 2048 || /[\0\r\n]/u.test(scope)) throw new Error("The conversation outbox owner is invalid.");
    this.#key = `joko.conversation-outbox.v1:${scope}`;
  }
  initialize(): Promise<readonly PartnerNetworkOutboxEntry[]> {
    if (this.#loaded) return Promise.resolve(this.list());
    return this.#loadFlight ??= this.#refresh().then(() => {
      this.#loaded = true;
      return this.list();
    }).finally(() => { this.#loadFlight = undefined; });
  }
  async #refresh(): Promise<void> {
    const text = await this.storage.getItem(this.#key);
    if (text === this.#lastRead) return;
    const entries = new Map<string, StoredEntry>();
    if (text !== null) {
      if (text.length > maximumCharacters) throw new Error("The conversation outbox is too large.");
      const disk = JSON.parse(text) as { format: number; scope: string; entries: StoredEntry[] };
      if (disk.format !== 1 || disk.scope !== this.scope || !Array.isArray(disk.entries)) throw new Error("Rebuild incompatible development outbox data.");
      for (const entry of disk.entries) {
        const request = fromJsonString(SendPartnerNetworkRequestSchema, entry.request);
        if (!validId.test(request.operationId) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
          || entries.has(request.operationId) || entry.messageId !== undefined && !validId.test(entry.messageId)) throw new Error("The conversation outbox is invalid.");
        entries.set(request.operationId, entry);
      }
    }
    this.#entries = entries;
    this.#lastRead = text;
  }
  list(): readonly PartnerNetworkOutboxEntry[] {
    return [...this.#entries.values()].map(entry => ({ request: fromJsonString(SendPartnerNetworkRequestSchema, entry.request), createdAt: entry.createdAt,
      ...(entry.messageId ? { messageId: entry.messageId } : {}) }));
  }
  has(operationId: string): boolean { return this.#entries.has(operationId); }
  async prepare(request: SendPartnerNetworkRequest, createdAt = Date.now()): Promise<void> {
    if (!this.#loaded) throw new Error("Read the original conversation outbox before sending.");
    const id = request.operationId, value = toJsonString(SendPartnerNetworkRequestSchema, request);
    if (!validId.test(id) || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("The conversation outbox is invalid.");
    await this.#update(entries => {
      const previous = entries.get(id);
      if (previous && previous.request !== value) throw new Error("The send request already names different input.");
      if (previous) return false;
      // Older writers could exceed this count. Keep those entries readable and allow settlement.
      if (entries.size >= maximumEntries) throw new Error("The conversation outbox is full. Resolve retained messages first.");
      entries.set(id, { request: value, createdAt });
      return true;
    });
  }
  async acknowledge(operationId: string, messageId: string): Promise<void> {
    if (!this.#loaded) await this.initialize();
    await this.#update(entries => {
      const previous = entries.get(operationId);
      if (!validId.test(operationId) || !validId.test(messageId) || previous?.messageId && previous.messageId !== messageId) throw new Error("The send receipt changed identity.");
      // A peer may already have displayed this host receipt and removed its pending entry.
      if (!previous || previous.messageId === messageId) return false;
      entries.set(operationId, { ...previous, messageId });
      return true;
    });
  }
  async displayed(messageIds: ReadonlySet<string>, room?: Pick<SendPartnerNetworkRequest, "roomId" | "joinId">): Promise<void> {
    if (!this.#loaded) await this.initialize();
    if (!this.#entries.size) return;
    const hasReceipt = [...this.#entries.values()].some(entry => entry.messageId && messageIds.has(entry.messageId));
    if (!hasReceipt && await this.storage.getItem(this.#key) === this.#lastRead) return;
    await this.#update(entries => {
      let changed = false;
      for (const [id, entry] of entries) {
        if (!entry.messageId || !messageIds.has(entry.messageId)) continue;
        if (room) {
          const request = fromJsonString(SendPartnerNetworkRequestSchema, entry.request);
          if (request.roomId !== room.roomId || request.joinId !== room.joinId) continue;
        }
        entries.delete(id);
        changed = true;
      }
      return changed;
    });
  }
  #update(change: (entries: Map<string, StoredEntry>) => boolean): Promise<void> {
    return this.exclusive(this.#key, async () => {
      await this.#refresh();
      const entries = new Map(this.#entries);
      if (!change(entries)) return;
      const text = JSON.stringify({ format: 1, scope: this.scope, entries: [...entries.values()] });
      if (text.length > maximumCharacters) throw new Error("The conversation outbox is full. Resolve retained messages first.");
      await this.storage.setItem(this.#key, text);
      if (await this.storage.getItem(this.#key) !== text) throw new Error("The original send identity was not saved.");
      this.#lastRead = text;
      this.#entries = entries;
    });
  }
}
