// Artifacts and streamed uploads remain Joko-owned.
import { createHash, randomUUID } from "node:crypto";
import type { BlobRef } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { ArtifactStore } from "../artifact-store.js";
import type { BlobTransferCoordinator, UploadTransfer } from "../blob-transfers.js";
import type { CredentialVault, EncryptedCredential } from "../credential-vault.js";
import type { ExtensionCardScope, ExtensionCardRow } from "./service.js";
import { sniffMediaMime } from "./media-sniff.js";

const MAX_ATTACHMENT = 16 * 1024 * 1024, MAX_PREVIEW = 2 * 1024 * 1024;
const MAX_MEDIA = 256 * 1024 * 1024;
const MEDIA_EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg", "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "model/gltf-binary": "glb" };
const OWNER = "extension-card-media";
interface Upload {
  readonly scope: ExtensionCardRow; readonly connectionId: string; readonly transfer: UploadTransfer;
  readonly name: string; readonly mimeType: string; readonly sha256: string; readonly bytes: number; readonly inline: boolean;
}
interface MediaEntry { readonly blob: BlobRef; readonly uri: string }
interface Media { readonly version: 1; readonly scope: ExtensionCardScope; readonly entries: readonly MediaEntry[] }
interface Options { readonly store: OperationalStore; readonly vault: CredentialVault; readonly artifacts: ArtifactStore; readonly transfers: BlobTransferCoordinator }
export interface ExtensionMailAttachment { readonly path: string; readonly filename: string; readonly mimeType: string; readonly bytes: number; readonly sha256: string; readonly contentId?: string }
export interface ExtensionMailUploadMetadata { readonly name: string; readonly mimeType: string; readonly sha256: string; readonly bytes: number; readonly inline: boolean }

/** A fingerprint grants no global read. Every URI is owned by the exact source
 * installation and task occurrence that selected or produced those bytes. */
export class ExtensionCardMedia {
  readonly #uploads = new Map<string, Upload>(); #admitting = 0;
  constructor(private readonly options: Options) {}
  #key(scope: ExtensionCardScope, hash: string): string {
    return createHash("sha256").update(JSON.stringify([scope.extensionId, scope.authorityKey, scope.sessionId, scope.sessionCreatedAt, scope.targetId, hash])).digest("hex");
  }
  async begin(scope: ExtensionCardRow, connectionId: string, input: ExtensionMailUploadMetadata, current: () => void): Promise<UploadTransfer> {
    current();
    for (const [id, upload] of this.#uploads) if (upload.transfer.expiresAt <= Date.now()) this.#uploads.delete(id);
    if (!input.name || input.name.length > 255 || /[\\/\u0000-\u001f\u007f]/u.test(input.name) || !/^[a-f0-9]{64}$/u.test(input.sha256)
      || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > MAX_ATTACHMENT || !/^[\w.+-]+\/[\w.+-]+$/u.test(input.mimeType)
      || input.inline && !imageExtension(input.mimeType) || this.#uploads.size + this.#admitting >= 32) throw new Error("Mail attachment selection invalid or busy.");
    this.#admitting++;
    try {
      const transfer = await this.options.transfers.beginUpload({ fileName: input.name, mimeType: input.mimeType, expectedSha256: input.sha256, expectedSize: input.bytes, maximumSize: MAX_ATTACHMENT });
      current(); this.#uploads.set(transfer.uploadId, { scope: { ...scope }, connectionId, transfer, ...input }); return transfer;
    } finally { this.#admitting--; }
  }
  selection(scope: ExtensionCardRow, connectionId: string, uploadId: string): Upload {
    const upload = this.#uploads.get(uploadId);
    if (!upload || upload.connectionId !== connectionId || upload.transfer.expiresAt <= Date.now()
      || upload.scope.callId !== scope.callId || this.#key(scope, upload.sha256) !== this.#key(upload.scope, upload.sha256)) throw new Error("Mail attachment upload unavailable.");
    return upload;
  }
  async complete(scope: ExtensionCardRow, connectionId: string, uploadId: string, current: () => void): Promise<ExtensionMailAttachment> {
    current(); const upload = this.selection(scope, connectionId, uploadId);
    // Claim once before any asynchronous verification. An uncertain delivered
    // provider write never reuses an attachment receipt automatically.
    this.#uploads.delete(uploadId);
    const blob = this.options.transfers.completeUpload(uploadId);
    if (blob.sha256 !== upload.sha256 || blob.byteLength !== upload.bytes || blob.mimeType !== upload.mimeType || blob.fileName !== upload.name) throw new Error("Mail attachment snapshot changed.");
    const bytes = await this.options.artifacts.readBlob(blob); current();
    if (upload.inline && sniffImage(bytes.data) !== upload.mimeType) throw new Error("Inline attachment is not a supported image.");
    const uri = this.grant(scope, blob, current);
    return { path: uri, filename: upload.name, mimeType: blob.mimeType, bytes: blob.byteLength, sha256: blob.sha256,
      ...(upload.inline ? { contentId: `${randomUUID()}@joko.local` } : {}) };
  }
  grant(scope: ExtensionCardScope, blob: BlobRef, current: () => void): string {
    current();
    const uri = `joko-media://blobs/${blob.sha256}.${MEDIA_EXTENSIONS[blob.mimeType] ?? "bin"}`, key = this.#key(scope, blob.sha256);
    const entry: MediaEntry = { blob: { id: blob.id, sha256: blob.sha256, byteLength: blob.byteLength, mimeType: blob.mimeType, ...(blob.fileName ? { fileName: blob.fileName } : {}) }, uri };
    this.options.store.transaction(store => {
      current(); const session = store.getSession(scope.sessionId).descriptor;
      const sealed = store.findSetting<EncryptedCredential>("service", OWNER, key)?.value;
      const existing = sealed ? JSON.parse(this.options.vault.open(sealed, key)) as Media : undefined;
      if (existing && (existing.version !== 1 || !Array.isArray(existing.entries) || existing.entries.length > 13)) throw new Error("Extension media record invalid.");
      const media: Media = { version: 1, scope: { ...scope }, entries: [...(existing?.entries ?? []).filter(value => value.uri !== uri), entry] };
      store.setSetting("service", OWNER, key, this.options.vault.seal(JSON.stringify(media), key));
      store.appendEvent({ id: `extension-media:${randomUUID()}`, sessionId: scope.sessionId, backendId: session.backendId, targetId: scope.targetId,
        generation: session.binding.generation, traceId: `extension-media:${scope.extensionId}`, payload: { type: "artifact", artifact: entry.blob, purpose: "Extension media", embeddedInExtensionCard: true } });
    });
    return uri;
  }
  async ingest(scope: ExtensionCardScope, data: Uint8Array, declaredMime: string, current: () => void): Promise<{ url: string; hash: string; ext: string }> {
    current();
    const mimeType = sniffMediaMime(data, declaredMime), extension = mimeType ? MEDIA_EXTENSIONS[mimeType] : undefined;
    if (!mimeType || !extension || data.byteLength > MAX_MEDIA) throw new Error("Unsupported extension media response.");
    const blob = await this.options.artifacts.ingestBytes(data, { mimeType, fileName: `extension-media.${extension}` }); current();
    return { url: this.grant(scope, blob, current), hash: blob.sha256, ext: `.${extension}` };
  }
  async describe(scope: ExtensionCardScope, hash: string, current: () => void, uri?: string): Promise<MediaEntry> {
    current(); if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Extension media unavailable.");
    const key = this.#key(scope, hash), sealed = this.options.store.findSetting<EncryptedCredential>("service", OWNER, key)?.value;
    if (!sealed) throw new Error("Extension media unavailable.");
    const media = JSON.parse(this.options.vault.open(sealed, key)) as Media;
    if (media.version !== 1 || !Array.isArray(media.entries) || media.entries.length > 13
      || this.#key(media.scope, hash) !== key) throw new Error("Extension media unavailable.");
    const entry = uri ? media.entries.find(entry => entry.uri === uri) : media.entries.at(-1);
    if (!entry || entry.blob.sha256 !== hash || entry.blob.byteLength > MAX_MEDIA) throw new Error("Extension media unavailable.");
    const blob = await this.options.artifacts.get(entry.blob.id); current();
    if (blob.sha256 !== entry.blob.sha256 || blob.byteLength !== entry.blob.byteLength || blob.mimeType !== entry.blob.mimeType) throw new Error("Extension media changed.");
    return entry;
  }
  async read(scope: ExtensionCardScope, hash: string, current: () => void, uri?: string): Promise<{ data: Uint8Array; mimeType: string; fileName: string; uri: string }> {
    const entry = await this.describe(scope, hash, current, uri);
    const result = await this.options.artifacts.readBlob(entry.blob); current();
    return { ...result, uri: entry.uri, fileName: entry.blob.fileName ?? `${hash.slice(0, 16)}.bin` };
  }
  async image(scope: ExtensionCardScope, uri: string, current: () => void): Promise<string> {
    const match = /^joko-media:\/\/blobs\/([a-f0-9]{64})\.(png|jpg|jpeg|gif|webp)$/u.exec(uri);
    if (!match) throw new Error("Extension image unavailable.");
    const key = this.#key(scope, match[1]!), sealed = this.options.store.findSetting<EncryptedCredential>("service", OWNER, key)?.value;
    if (!sealed) throw new Error("Extension image unavailable.");
    const metadata = JSON.parse(this.options.vault.open(sealed, key)) as Media;
    const entry = metadata.entries?.find(entry => entry.uri === uri);
    if (!entry || entry.blob.byteLength > MAX_PREVIEW) throw new Error("Extension image exceeds preview limit.");
    const media = await this.read(scope, match[1]!, current, uri);
    if (sniffImage(media.data) !== media.mimeType || media.uri !== uri) throw new Error("Extension image is not a supported image.");
    return `data:${media.mimeType};base64,${Buffer.from(media.data).toString("base64")}`;
  }
}
export function extensionCardMediaUris(html: string): string[] {
  return [...new Set(html.match(/joko-media:\/\/blobs\/[a-f0-9]{64}\.(?:png|jpg|jpeg|gif|webp|glb|mp3|wav|m4a)\b/gu) ?? [])].slice(0, 24);
}
function imageExtension(mime: string): string | undefined { return ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[mime]; }
function sniffImage(bytes: Uint8Array): string | undefined {
  const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "image/jpeg";
  if (value.subarray(0, 6).toString("ascii") === "GIF87a" || value.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return;
}
