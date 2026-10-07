import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BlobRef, ImageThumbnail } from "@joko/contracts";
import { normalizeMediaType } from "./workspace-files";
import { awaitMobileMarkdownResourceRead } from "./mobile-markdown-resources";
import { confirmMobileImageGalleryCanvas, inspectMobileImageGalleryBytes, mobileImageGalleryDimensionsMatch,
  mobileImageGalleryNativeAnimationMatches, mobileImageGalleryPreviewUri,
  type MobileImageGalleryDecodedImage, type MobileImageGalleryNativeDecode, type MobileImageGalleryPage } from "./mobile-image-gallery";

export interface MobileTimelineImagePreview {
  readonly leaseId: string;
  readonly uri: string;
  readonly width: number;
  readonly height: number;
  readonly mediaType: string;
  readonly animated: boolean;
  readonly nativeQuarterTurn?: true;
}
export interface MobileTimelineImageContext {
  readonly ownerKey: string;
  readonly page: MobileImageGalleryPage;
  assertCurrent(signal?: AbortSignal): void;
  revalidate(signal: AbortSignal): Promise<void>;
  download(blob: BlobRef, signal: AbortSignal): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string; readonly thumbnail?: ImageThumbnail }>;
}
interface CachedImage {
  readonly uri: string;
  decoded: MobileImageGalleryDecodedImage;
  readonly cost: number;
  readonly pixels: number;
  readonly nativeQuarterTurn?: true;
  readonly pins: Set<string>;
}
interface ImageLease {
  readonly id: string;
  readonly key: string;
  readonly context: Pick<MobileTimelineImageContext, "ownerKey" | "page" | "assertCurrent">;
  readonly controller: AbortController;
  readonly detach: () => void;
  image?: CachedImage;
}

/** Private presentation cache. Every cache hit still needs a current canonical source lease. */
export class MobileTimelineImageReader {
  #ownerKey: string | undefined;
  #nextId = 0;
  #leases = new Map<string, ImageLease>();
  #cache = new Map<string, CachedImage>();
  #active = 0;
  #waiting: { grant(): void; cancel(): void; signal: AbortSignal }[] = [];

  /** An independently pinned, cached-only presentation. It cannot authorize original-file actions. */
  pinCached(context: Pick<MobileTimelineImageContext, "ownerKey" | "page" | "assertCurrent">, signal: AbortSignal): MobileTimelineImagePreview | undefined {
    context.assertCurrent(signal); signal.throwIfAborted();
    if (this.#ownerKey !== context.ownerKey || this.#leases.size >= 64) return undefined;
    const key = imageKey(context.page); const image = this.#cache.get(key);
    if (!image) return undefined;
    const id = `timeline-image-${++this.#nextId}`; const controller = new AbortController();
    const abort = () => this.release(id);
    const lease: ImageLease = { id, key, context, controller, image, detach: () => signal.removeEventListener("abort", abort) };
    this.#leases.set(id, lease); image.pins.add(id); signal.addEventListener("abort", abort, { once: true });
    return this.#preview(lease, image);
  }

  async prepare(context: MobileTimelineImageContext, signal: AbortSignal): Promise<MobileTimelineImagePreview> {
    context.assertCurrent(signal);
    this.retainOwner(context.ownerKey);
    if (this.#leases.size >= 64) throw new Error("The visible image limit was reached.");
    const { page } = context;
    const key = imageKey(page);
    const id = `timeline-image-${++this.#nextId}`;
    const controller = new AbortController();
    const abort = () => this.release(id);
    const lease: ImageLease = { id, key, context, controller, detach: () => signal.removeEventListener("abort", abort) };
    this.#leases.set(id, lease); signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      this.#assert(lease, signal);
      await this.#acquire(controller.signal);
      const raw = (async () => {
        this.#assert(lease, signal); await context.revalidate(controller.signal); this.#assert(lease, signal);
        const cached = this.#cache.get(key);
        return cached ? { kind: "cached" as const, image: cached }
          : { kind: "downloaded" as const, download: await context.download(page.blob, controller.signal) };
      })();
      void raw.then(() => this.#releaseRead(), () => this.#releaseRead());
      const result = await awaitMobileMarkdownResourceRead(raw, controller.signal);
      this.#assert(lease, signal);
      let image = result.kind === "cached" ? result.image : undefined;
      if (result.kind === "downloaded") {
        const { download } = result;
        const thumbnail = download.thumbnail;
        if (thumbnail ? download.mediaType !== "image/webp" || download.bytes.length > 700 * 1024 || bytesToHex(sha256(download.bytes)) !== thumbnail.sha256Hex
          : normalizeMediaType(download.mediaType) !== page.mediaType || download.bytes.length !== page.byteSize || bytesToHex(sha256(download.bytes)) !== page.sha256Hex) {
          throw new Error("The canonical inline image bytes changed.");
        }
        const decoded = inspectMobileImageGalleryBytes(download.bytes, thumbnail ? "image/webp" : page.mediaType);
        if (thumbnail && (decoded.animated || decoded.width !== thumbnail.widthPixels || decoded.height !== thumbnail.heightPixels
          || decoded.width > 1024 || decoded.height > 1024)) throw new Error("The inline thumbnail decoder changed its presentation metadata.");
        if (page.widthPixels !== undefined && (thumbnail ? thumbnail.sourceWidthPixels !== page.widthPixels || thumbnail.sourceHeightPixels !== page.heightPixels
          : !mobileImageGalleryDimensionsMatch(decoded, page.widthPixels, page.heightPixels!))) {
          throw new Error("The canonical inline image dimensions changed.");
        }
        this.#assert(lease, signal);
        const uri = mobileImageGalleryPreviewUri(download.bytes, decoded);
        // A second visible consumer may have completed the exact source while this download was running.
        image = this.#cache.get(key);
        if (!image) {
          image = { uri, decoded: { mediaType: decoded.mediaType, width: decoded.width, height: decoded.height,
            ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}),
            ...(decoded.animated ? { animated: true } : {}), ...(decoded.previewMediaType ? { previewMediaType: decoded.previewMediaType } : {}) },
            cost: uri.length * 2, pixels: decoded.width * decoded.height, pins: new Set(),
            ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}) };
          this.#makeRoom(image); this.#cache.set(key, image);
        }
      }
      if (!image) throw new Error("The inline image was not prepared.");
      this.#assert(lease, signal);
      this.#cache.delete(key); this.#cache.set(key, image);
      image.pins.add(id); lease.image = image;
      return this.#preview(lease, image);
    } catch (error) { this.release(id); throw error; }
    finally { clearTimeout(deadline); }
  }

  confirm(id: string, native: MobileImageGalleryNativeDecode): MobileTimelineImagePreview {
    const lease = this.#leases.get(id);
    if (!lease?.image) throw new Error("The inline image was released.");
    this.#assert(lease);
    const expected = lease.image.decoded;
    if (!mobileImageGalleryDimensionsMatch(expected, native.width, native.height)
      || native.mediaType && normalizeMediaType(native.mediaType) !== (expected.previewMediaType ?? expected.mediaType)
      || !mobileImageGalleryNativeAnimationMatches(expected.mediaType, expected.animated === true, native.isAnimated)) {
      this.release(id, true); throw new Error("The native image does not match its canonical source.");
    }
    lease.image.decoded = confirmMobileImageGalleryCanvas(expected, native);
    return this.#preview(lease, lease.image);
  }

  release(id: string, discard = false): void {
    const lease = this.#leases.get(id); if (!lease) return;
    this.#leases.delete(id); lease.detach(); lease.controller.abort(); lease.image?.pins.delete(id);
    if (discard && this.#cache.get(lease.key) === lease.image) this.#cache.delete(lease.key);
  }

  retainOwner(ownerKey: string | undefined): void {
    if (ownerKey !== this.#ownerKey) { this.releaseAll(); this.#ownerKey = ownerKey; }
  }
  retireStale(): void {
    for (const lease of this.#leases.values()) { try { this.#assert(lease); } catch { this.release(lease.id, true); } }
  }
  releaseAll(): void { for (const id of this.#leases.keys()) this.release(id); this.#cache.clear(); this.#ownerKey = undefined; }

  #assert(lease: ImageLease, signal?: AbortSignal): void {
    signal?.throwIfAborted(); lease.controller.signal.throwIfAborted();
    if (this.#leases.get(lease.id) !== lease || this.#ownerKey !== lease.context.ownerKey) throw new Error("The inline image owner changed.");
    lease.context.assertCurrent(signal);
  }
  #preview(lease: ImageLease, image: CachedImage): MobileTimelineImagePreview {
    return { leaseId: lease.id, uri: image.uri, width: image.decoded.width, height: image.decoded.height,
      mediaType: image.decoded.previewMediaType ?? image.decoded.mediaType, animated: image.decoded.animated === true,
      ...(image.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}) };
  }
  #makeRoom(incoming: CachedImage): void {
    const fits = () => this.#cache.size < 16 && incoming.cost + [...this.#cache.values()].reduce((sum, entry) => sum + entry.cost, 0) <= 128 * 1_024 * 1_024
      && incoming.pixels + [...this.#cache.values()].reduce((sum, entry) => sum + entry.pixels, 0) <= 64 * 1_024 * 1_024;
    for (const [key, entry] of this.#cache) { if (fits()) return; if (entry.pins.size === 0) this.#cache.delete(key); }
    if (!fits()) throw new Error("The visible image memory limit was reached.");
  }
  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#active < 2 && this.#waiting.length === 0) { this.#active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiting = { signal, grant: () => { signal.removeEventListener("abort", waiting.cancel); resolve(); }, cancel: () => {
        signal.removeEventListener("abort", waiting.cancel); this.#waiting = this.#waiting.filter((item) => item !== waiting);
        reject(new Error("The inline image read was cancelled."));
      } };
      this.#waiting.push(waiting); signal.addEventListener("abort", waiting.cancel, { once: true });
    });
  }
  #releaseRead(): void {
    this.#active--;
    while (this.#active < 2 && this.#waiting.length) {
      const waiting = this.#waiting.shift()!;
      if (waiting.signal.aborted) waiting.cancel(); else { this.#active++; waiting.grant(); }
    }
  }
}

function imageKey(page: MobileImageGalleryPage): string {
  return JSON.stringify([page.pageId, page.mediaType, page.blob.blobId, page.sha256Hex, page.byteSize, page.widthPixels, page.heightPixels]);
}
