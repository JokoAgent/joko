import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { BlobRef } from "@joko/core";

import { ArtifactStore, type ArtifactRecord } from "./artifact-store.js";

interface PendingUpload {
  readonly uploadId: string;
  readonly ticketId: string;
  readonly secret: string;
  readonly expiresAt: number;
  artifact?: ArtifactRecord;
}

export interface UploadTransfer {
  readonly uploadId: string;
  readonly ticketId: string;
  readonly expiresAt: number;
  readonly relativeEndpoint: string;
}

export interface DownloadTransfer {
  readonly ticketId: string;
  readonly blobId: string;
  readonly expiresAt: number;
  readonly relativeEndpoint: string;
}

/** Coordinates the Connect metadata calls with the separately streamed Blob API. */
export class BlobTransferCoordinator {
  readonly #artifacts: ArtifactStore;
  readonly #uploads = new Map<string, PendingUpload>();
  readonly #uploadByTicket = new Map<string, PendingUpload>();

  constructor(artifacts: ArtifactStore) {
    this.#artifacts = artifacts;
  }

  async beginUpload(input: {
    readonly expectedSha256?: string;
    readonly expectedSize?: number;
    readonly maximumSize?: number;
    readonly mimeType?: string;
    readonly fileName?: string;
  }): Promise<UploadTransfer> {
    this.prune();
    const ticket = await this.#artifacts.createUploadTicket(input);
    const pending: PendingUpload = {
      uploadId: randomUUID(),
      ticketId: ticket.ticketId,
      secret: ticket.secret,
      expiresAt: ticket.expiresAt
    };
    this.#uploads.set(pending.uploadId, pending);
    this.#uploadByTicket.set(pending.ticketId, pending);
    return {
      uploadId: pending.uploadId,
      ticketId: pending.ticketId,
      expiresAt: pending.expiresAt,
      relativeEndpoint: `/v1/blobs/upload/${encodeURIComponent(pending.ticketId)}/${encodeURIComponent(pending.secret)}`
    };
  }

  async acceptUpload(ticketId: string, secret: string, stream: Readable): Promise<ArtifactRecord> {
    this.prune();
    const pending = this.#uploadByTicket.get(ticketId);
    if (pending === undefined || pending.secret !== secret || pending.expiresAt <= Date.now()) {
      throw new Error("Blob upload transfer is invalid or expired.");
    }
    if (pending.artifact !== undefined) throw new Error("Blob upload ticket was already consumed.");
    pending.artifact = await this.#artifacts.acceptUpload(ticketId, secret, stream);
    return pending.artifact;
  }

  completeUpload(uploadId: string): ArtifactRecord {
    this.prune();
    const pending = this.#uploads.get(uploadId);
    if (pending?.artifact === undefined) throw new Error("Blob upload has not been streamed successfully.");
    return pending.artifact;
  }

  async beginDownload(blob: BlobRef | string): Promise<DownloadTransfer> {
    const blobId = typeof blob === "string" ? blob : blob.id;
    const ticket = await this.#artifacts.createDownloadTicket(blobId);
    return {
      ticketId: ticket.ticketId,
      blobId,
      expiresAt: ticket.expiresAt,
      relativeEndpoint: `/v1/blobs/download/${encodeURIComponent(ticket.ticketId)}/${encodeURIComponent(ticket.secret)}`
    };
  }

  openDownload(ticketId: string, secret: string) {
    return this.#artifacts.openDownload(ticketId, secret);
  }

  private prune(at = Date.now()): void {
    for (const [uploadId, pending] of this.#uploads) {
      if (pending.expiresAt > at) continue;
      this.#uploads.delete(uploadId);
      this.#uploadByTicket.delete(pending.ticketId);
    }
  }
}
