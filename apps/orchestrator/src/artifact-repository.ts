import type { OperationalStore } from "@joko/store";
import type { ArtifactRecord as StoredArtifactRecord } from "@joko/store";
import type { ArtifactRecord, ArtifactRepository, TransferTicket } from "./artifact-store.js";

export class OperationalArtifactRepository implements ArtifactRepository {
  readonly #store: OperationalStore;
  readonly #tickets = new Map<string, TransferTicket>();

  constructor(store: OperationalStore) {
    this.#store = store;
  }

  async putArtifact(record: ArtifactRecord): Promise<void> {
    this.#store.putArtifact({
      id: record.id,
      sha256: record.sha256,
      byteLength: record.byteLength,
      mimeType: record.mimeType,
      ...(record.fileName === undefined ? {} : { fileName: record.fileName }),
      storageKey: record.storagePath,
      metadata: {
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt })
      },
      createdAt: record.createdAt
    });
  }

  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    const record = this.#store.findArtifact(id);
    return record === undefined ? undefined : fromStored(record);
  }

  async findPermanentArtifact(input: {
    readonly storagePath: string;
    readonly mimeType: string;
    readonly fileName?: string;
  }): Promise<ArtifactRecord | undefined> {
    const record = this.#store.findPermanentArtifactByStorage(input.storagePath, input.mimeType, input.fileName);
    return record === undefined ? undefined : fromStored(record);
  }

  async createTransferTicket(ticket: TransferTicket): Promise<void> {
    if (this.#tickets.has(ticket.id)) throw new Error("Transfer ticket already exists.");
    this.#tickets.set(ticket.id, ticket);
  }

  async consumeTransferTicket(
    id: string,
    secretDigest: string,
    direction: TransferTicket["direction"],
    now: number
  ): Promise<TransferTicket | undefined> {
    const ticket = this.#tickets.get(id);
    if (
      ticket === undefined ||
      ticket.secretDigest !== secretDigest ||
      ticket.direction !== direction ||
      ticket.expiresAt <= now ||
      ticket.consumedAt !== undefined
    ) return undefined;
    const consumed = { ...ticket, consumedAt: now };
    this.#tickets.set(id, consumed);
    return consumed;
  }

  async deleteExpiredArtifacts(now: number): Promise<readonly ArtifactRecord[]> {
    for (const [id, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) this.#tickets.delete(id);
    }
    return this.#store.expireArtifacts(now).map(fromStored);
  }

  async hasLiveStorageReference(storagePath: string): Promise<boolean> {
    return this.#store.hasLiveArtifactStorageKey(storagePath);
  }
}

function fromStored(record: StoredArtifactRecord): ArtifactRecord {
  const metadata = record.metadata as { readonly expiresAt?: unknown };
  return {
    ...record.blob,
    storagePath: record.storageKey,
    createdAt: record.createdAt,
    ...(typeof metadata.expiresAt === "number" ? { expiresAt: metadata.expiresAt } : {})
  };
}
