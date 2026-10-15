import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { TaskShareStore, type OperationalStore, type TaskShareGuestProof } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { TaskShareLease } from "./task-sharing-host-types.js";

const CHUNK_BYTES = 256 * 1024;
const BUFFER_BYTES = 256 * 1024 * 1024;
const UPLOAD_SCOPE = "task-sharing.uploads.v1";
interface Upload {
  readonly id: string; readonly proof: TaskShareGuestProof; readonly size: number; readonly sha256: string;
  readonly name: string; readonly mediaType: string; readonly expiresAt: number;
  readonly chunks: Buffer[]; readonly writes: Map<number, string>; offset: number; busy: boolean; blob?: contract.BlobRef;
}
/** Finite, member-bound chunks; ordinary Blob tickets never reach guests. */
export class TaskSharingHostMedia {
  readonly #uploads = new Map<string, Upload>();
  constructor(readonly store: OperationalStore, readonly shares: TaskShareStore, readonly artifacts: ArtifactStore) {}
  async transfer(lease: TaskShareLease, transfer: contract.TaskShareAttachmentTransfer, signal: AbortSignal): Promise<contract.TaskShareAttachmentResult> {
    lease.assertCurrent(); signal.throwIfAborted(); this.reconcile();
    const action = transfer.action;
    if (action.case === "read") return this.read(lease, action.value, signal);
    if (action.case === "begin") {
      const input = action.value, size = Number(input.sizeBytes);
      if (!Number.isSafeInteger(size) || size < 0 || size > BUFFER_BYTES || !/^[0-9a-f]{64}$/u.test(input.sha256Hex)
        || !input.name || input.name.length > 512 || /[\u0000-\u001f\u007f/\\]/u.test(input.name)
        || !input.mediaType || input.mediaType.length > 256) throw new ConnectError("The attachment declaration is invalid.", Code.InvalidArgument);
      const receipt = this.store.transaction(() => {
        lease.assertCurrent();
        const previous = this.shares.receipt(lease.proof, input.operationId, input);
        if (previous) return previous;
        const id = `upload-${randomUUID()}`;
        const result = create(contract.TaskShareAttachmentResultSchema, { ticketId: id, offset: 0n });
        this.shares.admit(lease.proof, input.operationId, input);
        this.shares.settle(lease.proof, input.operationId, input, { status: "completed", responseHex: Buffer.from(id).toString("hex") });
        this.#uploads.set(id, { id, proof: lease.proof, size, sha256: input.sha256Hex, name: input.name,
          mediaType: input.mediaType, expiresAt: Date.now() + 15 * 60_000, chunks: [], writes: new Map(), offset: 0, busy: false });
        return { ...this.shares.receipt(lease.proof, input.operationId, input)!, result };
      });
      const id = Buffer.from(receipt.responseHex ?? "", "hex").toString();
      const upload = this.#uploads.get(id);
      if (!upload) throw new ConnectError("This upload expired or the service restarted. Select the attachment again.", Code.FailedPrecondition);
      return create(contract.TaskShareAttachmentResultSchema, { ticketId: upload.id, offset: BigInt(upload.offset), complete: upload.blob !== undefined, blob: upload.blob });
    }
    if (action.case !== "write") throw new ConnectError("A finite attachment action is required.", Code.InvalidArgument);
    const input = action.value, upload = this.#uploads.get(input.ticketId);
    if (!upload || !sameMember(upload.proof, lease.proof)) throw new ConnectError("The upload is unavailable for this participant.", Code.PermissionDenied);
    if (upload.busy) throw new ConnectError("The previous upload chunk is still settling.", Code.Aborted);
    const offset = Number(input.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || input.data.byteLength > CHUNK_BYTES || offset > upload.offset
      || offset + input.data.byteLength > upload.size) throw new ConnectError("The attachment chunk is invalid.", Code.InvalidArgument);
    if (offset < upload.offset) {
      if (offset + input.data.byteLength > upload.offset || upload.writes.get(offset) !== createHash("sha256").update(input.data).digest("hex")) throw new ConnectError("The repeated attachment chunk differs from its original bytes.", Code.Aborted);
      return create(contract.TaskShareAttachmentResultSchema, { ticketId: upload.id, offset: BigInt(upload.offset), complete: upload.blob !== undefined, blob: upload.blob });
    }
    if (upload.blob) return create(contract.TaskShareAttachmentResultSchema, { ticketId: upload.id, offset: BigInt(upload.offset), complete: true, blob: upload.blob });
    const buffered = [...this.#uploads.values()].reduce((sum, row) => sum + row.chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0), 0);
    if (buffered + input.data.byteLength > BUFFER_BYTES) throw new ConnectError("Attachment upload capacity is busy. Retry this chunk later.", Code.ResourceExhausted);
    upload.writes.set(offset, createHash("sha256").update(input.data).digest("hex"));
    upload.chunks.push(Buffer.from(input.data)); upload.offset += input.data.byteLength;
    if (input.finish) {
      if (upload.offset !== upload.size) throw new ConnectError("The attachment is incomplete.", Code.FailedPrecondition);
      upload.busy = true;
      const bytes = Buffer.concat(upload.chunks);
      try {
        if (createHash("sha256").update(bytes).digest("hex") !== upload.sha256) throw new ConnectError("The attachment checksum does not match.", Code.InvalidArgument);
        lease.assertCurrent(); signal.throwIfAborted();
        const artifact = await this.artifacts.ingestBytes(bytes, { fileName: upload.name, mimeType: upload.mediaType });
        lease.assertCurrent(); signal.throwIfAborted();
        const blob = create(contract.BlobRefSchema, { blobId: artifact.id, fileName: artifact.fileName ?? "", mediaType: artifact.mimeType,
          byteSize: BigInt(artifact.byteLength), sha256Hex: artifact.sha256, disposition: contract.BlobDisposition.ATTACHMENT });
        this.store.transaction(() => {
          lease.assertCurrent();
          this.store.setSetting("service", UPLOAD_SCOPE, artifact.id, { format: 1, author: lease.author });
        });
        upload.blob = blob;
        for (const chunk of upload.chunks) chunk.fill(0);
        upload.chunks.length = 0;
      } finally { bytes.fill(0); upload.busy = false; }
    }
    lease.assertCurrent(); signal.throwIfAborted();
    return create(contract.TaskShareAttachmentResultSchema, { ticketId: upload.id, offset: BigInt(upload.offset), complete: upload.blob !== undefined, blob: upload.blob });
  }
  assertVisibleBlob(lease: TaskShareLease, blobId: string): void {
    lease.assertCurrent();
    const artifact = this.store.getArtifact(blobId);
    if (artifact.sessionId === lease.scope.sessionId) return;
    const grant = this.store.findSetting<{ format: 1; author: { shareId: string; memberId: string; memberGeneration: number } }>("service", UPLOAD_SCOPE, blobId)?.value;
    if (grant?.format === 1 && grant.author.shareId === lease.proof.shareId && grant.author.memberId === lease.proof.memberId
      && grant.author.memberGeneration === lease.proof.memberGeneration) return;
    for (let offset = 0;; offset += 500) {
      const queue = this.store.listQueueItems({ sessionId: lease.scope.sessionId, limit: 500, offset });
      if (queue.some(item => item.body.images.some(image => image.blob.id === blobId) || item.body.files.some(file => file.blob.id === blobId))) return;
      if (queue.length < 500) break;
    }
    throw new ConnectError("The attachment does not belong to this shared task.", Code.PermissionDenied);
  }
  reconcile(): void {
    for (const [id, upload] of this.#uploads) {
      let available = upload.expiresAt > Date.now();
      try { this.shares.authorize(upload.proof); } catch { available = false; }
      if (!available) { for (const chunk of upload.chunks) chunk.fill(0); this.#uploads.delete(id); }
    }
  }
  close(): void { for (const upload of this.#uploads.values()) for (const chunk of upload.chunks) chunk.fill(0); this.#uploads.clear(); }
  private async read(lease: TaskShareLease, input: contract.TaskShareAttachmentRead, signal: AbortSignal): Promise<contract.TaskShareAttachmentResult> {
    this.assertVisibleBlob(lease, input.blobId);
    const offset = Number(input.offset), maximum = input.maximumBytes || CHUNK_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || maximum > CHUNK_BYTES) throw new ConnectError("The attachment range is invalid.", Code.InvalidArgument);
    const ticket = await this.artifacts.createDownloadTicket(input.blobId);
    lease.assertCurrent(); signal.throwIfAborted();
    const { artifact, stream } = await this.artifacts.openDownload(ticket.ticketId, ticket.secret);
    const cancel = () => stream.destroy(new Error("The task attachment transfer retired."));
    const combined = AbortSignal.any([lease.signal, signal]);
    combined.addEventListener("abort", cancel, { once: true });
    try {
      if (offset > artifact.byteLength) throw new ConnectError("The attachment range is invalid.", Code.OutOfRange);
      let skipped = 0, count = 0; const chunks: Buffer[] = [];
      for await (const raw of stream) {
        lease.assertCurrent(); combined.throwIfAborted();
        const chunk = Buffer.from(raw as Uint8Array), start = Math.max(offset - skipped, 0);
        skipped += chunk.length;
        if (start >= chunk.length) continue;
        const part = chunk.subarray(start, start + maximum - count);
        chunks.push(Buffer.from(part)); count += part.length;
        if (count >= maximum) break;
      }
      lease.assertCurrent(); combined.throwIfAborted(); this.assertVisibleBlob(lease, input.blobId);
      return create(contract.TaskShareAttachmentResultSchema, { offset: BigInt(offset + count), data: Buffer.concat(chunks),
        complete: offset + count >= artifact.byteLength, blob: create(contract.BlobRefSchema, { blobId: artifact.id,
          fileName: artifact.fileName ?? "", mediaType: artifact.mimeType, byteSize: BigInt(artifact.byteLength), sha256Hex: artifact.sha256 }) });
    } finally { combined.removeEventListener("abort", cancel); stream.destroy(); }
  }
}
function sameMember(left: TaskShareGuestProof, right: TaskShareGuestProof): boolean {
  return left.shareId === right.shareId && left.shareGeneration === right.shareGeneration && left.memberId === right.memberId
    && left.memberGeneration === right.memberGeneration && left.credentialSha256Hex === right.credentialSha256Hex;
}
