import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FileKind, type BlobRef, type ImageThumbnail } from "@joko/contracts";
import { normalizeMediaType, workspaceEntryRevisionKey, type MobileFilesComposerSource } from "./workspace-files";
import { awaitMobileMarkdownResourceRead } from "./mobile-markdown-resources";
import type { MobileFilesThumbnailCache } from "./mobile-files-thumbnail-cache";
import { inspectMobileImageGalleryBytes, mobileImageGalleryDimensionsMatch, mobileImageGalleryMediaType, mobileImageGalleryNativeAnimationMatches, mobileImageGalleryPreviewUri,
  type MobileImageGalleryNativeDecode } from "./mobile-image-gallery";

export const MOBILE_FILES_DOCUMENT_MAXIMUM_BYTES = 96 * 1024;
export const MOBILE_FILES_IMAGE_MAXIMUM_BYTES = 48 * 1024 * 1024;
export type MobileFilesThumbnailContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly uri: string; readonly width: number; readonly height: number; readonly mediaType: string; readonly animated: boolean; readonly nativeQuarterTurn?: true };
export interface MobileFilesThumbnailPreview { readonly leaseId: string; readonly content?: MobileFilesThumbnailContent }
export type MobileFilesThumbnailInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly blob: BlobRef; readonly bytes: Uint8Array; readonly mediaType: string; readonly thumbnail?: ImageThumbnail };
export interface MobileFilesThumbnailContext {
  readonly ownerKey: string; readonly sourceKey: string;
  assertCurrent(signal?: AbortSignal): void;
  revalidate(signal: AbortSignal): Promise<void>;
  read(signal: AbortSignal): Promise<MobileFilesThumbnailInput | undefined>;
}
export interface MobileFilesThumbnailAccess {
  prepareFilesThumbnail(ownerKey: string, source: MobileFilesComposerSource, signal: AbortSignal): Promise<MobileFilesThumbnailPreview>;
  confirmFilesThumbnail(leaseId: string, native: MobileImageGalleryNativeDecode): void;
  releaseFilesThumbnail(leaseId: string, discard?: boolean): void;
}
interface Cached { readonly content?: MobileFilesThumbnailContent; readonly cost: number; readonly pixels: number; readonly pins: Set<string> }
interface Lease { readonly id: string; readonly context: MobileFilesThumbnailContext; readonly controller: AbortController; readonly detach: () => void; cached?: Cached }

export function mobileFilesThumbnailKind(source: MobileFilesComposerSource): "image" | "text" | undefined {
  if (source.kind === "search-result" || source.kind === "workspace-entry" && source.entry.kind !== FileKind.REGULAR) return undefined;
  const mediaType = normalizeMediaType(source.kind === "workspace-entry" ? source.entry.mediaType : source.artifact.blob?.mediaType ?? "");
  if (mobileImageGalleryMediaType(mediaType)) return "image";
  const name = source.kind === "workspace-entry" ? source.entry.relativePath : source.artifact.blob?.fileName ?? "";
  if (mediaType.startsWith("text/") || ["application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml"].includes(mediaType)
    || /\.(?:md|mdx|txt|log|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|conf|js|jsx|ts|tsx|css|html?|py|rb|rs|go|java|c|cc|cpp|h|hpp|sh|ps1|sql)$/iu.test(name)) return "text";
  return undefined;
}
export function mobileFilesThumbnailSourceKey(source: MobileFilesComposerSource): string {
  if (source.kind === "workspace-entry" && source.entry.revision) return JSON.stringify(["workspace", source.entry.workspaceId, source.entry.relativePath,
    source.entry.kind, source.entry.mediaType, workspaceEntryRevisionKey(source.entry.revision)]);
  if (source.kind === "artifact" && source.artifact.blob) {
    const artifact = source.artifact; const blob = artifact.blob!;
    return JSON.stringify(["artifact", artifact.sessionId, artifact.artifactId, blob.blobId, blob.mediaType, blob.fileName, blob.byteSize.toString(), blob.sha256Hex]);
  }
  throw new Error("The file miniature has no canonical source identity.");
}
export function mobileFilesDocumentBytes(blob: BlobRef, download: { readonly bytes: Uint8Array; readonly mediaType: string }): string | undefined {
  assertOriginalBytes(blob, download);
  if (download.bytes.length > MOBILE_FILES_DOCUMENT_MAXIMUM_BYTES) return undefined;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(download.bytes); } catch { return undefined; }
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text) ? undefined : text;
}

/** A bounded, private decoration cache; it grants no file actions or offline authority. */
export class MobileFilesThumbnailReader {
  #ownerKey: string | undefined; #nextId = 0; #active = 0;
  #leases = new Map<string, Lease>(); #cache = new Map<string, Cached>();
  #waiting: { grant(): void; cancel(): void; signal: AbortSignal }[] = [];
  constructor(private readonly disk?: Pick<MobileFilesThumbnailCache, "get" | "put" | "remove">) {}
  async prepare(context: MobileFilesThumbnailContext, signal: AbortSignal): Promise<MobileFilesThumbnailPreview> {
    context.assertCurrent(signal); signal.throwIfAborted(); this.retainOwner(context.ownerKey);
    if (this.#leases.size >= 64) throw new Error("The visible file miniature limit was reached.");
    const id = `file-miniature-${++this.#nextId}`; const controller = new AbortController(); const abort = () => this.release(id);
    const lease: Lease = { id, context, controller, detach: () => signal.removeEventListener("abort", abort) };
    this.#leases.set(id, lease); signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      await this.#acquire(controller.signal);
      const raw = (async () => {
        this.#assert(lease);
        await context.revalidate(controller.signal); this.#assert(lease);
        const cached = this.#cache.get(context.sourceKey);
        if (cached) return { cached };
        const assertCurrent = () => this.#assert(lease);
        const stored = await this.disk?.get(context.ownerKey, context.sourceKey, assertCurrent).catch(() => undefined); this.#assert(lease);
        if (stored) return { content: stored };
        const input = await context.read(controller.signal); this.#assert(lease); const content = thumbnailContent(input);
        if (content) await this.disk?.put(context.ownerKey, context.sourceKey, content, assertCurrent).catch(() => undefined);
        this.#assert(lease); return { content };
      })();
      void raw.then(() => this.#releaseRead(), () => this.#releaseRead());
      const result = await awaitMobileMarkdownResourceRead(raw, controller.signal); this.#assert(lease);
      let cached = "cached" in result ? result.cached : undefined;
      if (!cached) {
        const content = "content" in result ? result.content : undefined;
        cached = this.#cache.get(context.sourceKey);
        if (!cached) {
          cached = { content, cost: content?.kind === "image" ? content.uri.length * 2 : content?.text.length ? content.text.length * 2 : 0,
            pixels: content?.kind === "image" ? content.width * content.height : 0, pins: new Set() };
          this.#makeRoom(cached); this.#cache.set(context.sourceKey, cached);
        }
      }
      this.#assert(lease); this.#cache.delete(context.sourceKey); this.#cache.set(context.sourceKey, cached);
      lease.cached = cached; cached.pins.add(id); return { leaseId: id, content: cached.content };
    } catch (error) { this.release(id); throw error; } finally { clearTimeout(deadline); }
  }
  confirm(id: string, native: MobileImageGalleryNativeDecode): void {
    const lease = this.#leases.get(id); if (!lease || lease.cached?.content?.kind !== "image") throw new Error("The file miniature was released.");
    this.#assert(lease); const expected = lease.cached.content;
    if (!mobileImageGalleryDimensionsMatch(expected, native.width, native.height) || native.mediaType && normalizeMediaType(native.mediaType) !== expected.mediaType
      || !mobileImageGalleryNativeAnimationMatches(expected.mediaType, expected.animated, native.isAnimated)) {
      this.release(id, true); throw new Error("The native file miniature changed its canonical dimensions.");
    }
  }
  release(id: string, discard = false): void {
    const lease = this.#leases.get(id); if (!lease) return;
    this.#leases.delete(id); lease.detach(); lease.controller.abort(); lease.cached?.pins.delete(id);
    if (discard && this.#cache.get(lease.context.sourceKey) === lease.cached) {
      this.#cache.delete(lease.context.sourceKey);
      void this.disk?.remove(lease.context.ownerKey, lease.context.sourceKey).catch(() => undefined);
    }
  }
  retainOwner(ownerKey: string | undefined): void { if (ownerKey !== this.#ownerKey) { this.releaseAll(); this.#ownerKey = ownerKey; } }
  retireStale(): void { for (const lease of this.#leases.values()) { try { this.#assert(lease); } catch { this.release(lease.id); } } }
  releaseAll(): void { for (const id of this.#leases.keys()) this.release(id); this.#cache.clear(); this.#ownerKey = undefined; }
  #assert(lease: Lease): void {
    lease.controller.signal.throwIfAborted();
    if (this.#leases.get(lease.id) !== lease || this.#ownerKey !== lease.context.ownerKey) throw new Error("The file miniature owner changed.");
    lease.context.assertCurrent(lease.controller.signal);
  }
  #makeRoom(incoming: Cached): void {
    const fits = () => this.#cache.size < 300 && incoming.cost + [...this.#cache.values()].reduce((sum, value) => sum + value.cost, 0) <= 16 * 1024 * 1024
      && incoming.pixels + [...this.#cache.values()].reduce((sum, value) => sum + value.pixels, 0) <= 64 * 1024 * 1024;
    for (const [key, value] of this.#cache) { if (fits()) return; if (value.pins.size === 0) this.#cache.delete(key); }
    if (!fits()) throw new Error("The visible file miniature memory limit was reached.");
  }
  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (this.#active < 3 && this.#waiting.length === 0) { this.#active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiting = { signal, grant: () => { signal.removeEventListener("abort", waiting.cancel); resolve(); }, cancel: () => {
        signal.removeEventListener("abort", waiting.cancel); this.#waiting = this.#waiting.filter((value) => value !== waiting); reject(new Error("The file miniature read was cancelled."));
      } };
      this.#waiting.push(waiting); signal.addEventListener("abort", waiting.cancel, { once: true });
    });
  }
  #releaseRead(): void {
    this.#active--; while (this.#active < 3 && this.#waiting.length) {
      const waiting = this.#waiting.shift()!; if (waiting.signal.aborted) waiting.cancel(); else { this.#active++; waiting.grant(); }
    }
  }
}

function assertOriginalBytes(blob: BlobRef, download: { readonly bytes: Uint8Array; readonly mediaType: string }): void {
  if (!blob.blobId || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_FILES_IMAGE_MAXIMUM_BYTES) || BigInt(download.bytes.length) !== blob.byteSize
    || normalizeMediaType(download.mediaType) !== normalizeMediaType(blob.mediaType) || bytesToHex(sha256(download.bytes)) !== blob.sha256Hex) throw new Error("The file miniature bytes changed.");
}
function thumbnailContent(input: MobileFilesThumbnailInput | undefined): MobileFilesThumbnailContent | undefined {
  if (!input) return undefined;
  if (input.kind === "text") {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.text)) return undefined;
    const text = input.text.replace(/\r\n?/gu, "\n").slice(0, 2000); return text ? { kind: "text", text } : undefined;
  }
  const thumbnail = input.thumbnail;
  if (thumbnail) {
    if (!input.blob.blobId || !/^[0-9a-f]{64}$/u.test(input.blob.sha256Hex) || input.mediaType !== "image/webp"
      || input.bytes.length > 700 * 1024 || bytesToHex(sha256(input.bytes)) !== thumbnail.sha256Hex
      || thumbnail.sourceWidthPixels < 1 || thumbnail.sourceHeightPixels < 1 || thumbnail.sourceWidthPixels > 16_384 || thumbnail.sourceHeightPixels > 16_384
      || thumbnail.sourceWidthPixels * thumbnail.sourceHeightPixels > 64 * 1024 * 1024) throw new Error("The file miniature thumbnail changed.");
  } else assertOriginalBytes(input.blob, input);
  const decoded = inspectMobileImageGalleryBytes(input.bytes, thumbnail ? "image/webp" : normalizeMediaType(input.blob.mediaType));
  if (thumbnail && (decoded.animated || decoded.width > 256 || decoded.height > 256 || decoded.width !== thumbnail.widthPixels || decoded.height !== thumbnail.heightPixels
    || Math.max(decoded.width, decoded.height) > Math.max(thumbnail.sourceWidthPixels, thumbnail.sourceHeightPixels))) throw new Error("The file miniature thumbnail dimensions changed.");
  return { kind: "image", uri: mobileImageGalleryPreviewUri(input.bytes, decoded), width: decoded.width, height: decoded.height,
    ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}),
    mediaType: decoded.previewMediaType ?? decoded.mediaType, animated: decoded.animated === true };
}
