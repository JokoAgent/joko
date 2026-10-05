import { createHash } from "node:crypto";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import { ImageThumbnailUnavailableReason, type ImageThumbnail } from "@joko/contracts";
import type { ArtifactRecord, ArtifactStore } from "./artifact-store.js";

export const IMAGE_THUMBNAIL_MAXIMUM_BYTES = 700 * 1_024;
const maximumInputBytes = 48 * 1_024 * 1_024;
const maximumPixels = 64 * 1_024 * 1_024;
type Thumbnail = Omit<ImageThumbnail, "$typeName">;
export type ImageThumbnailResult = { readonly thumbnail: Thumbnail } | { readonly unavailable: ImageThumbnailUnavailableReason };

/** Service-private presentation cache. Source authority is checked by the authenticated caller on every read. */
export class ImageThumbnailRenderer {
  #active = 0;
  #waiting: { readonly signal: AbortSignal; grant(): void; cancel(): void }[] = [];
  #cache = new Map<string, Thumbnail>();
  constructor(readonly artifacts: Pick<ArtifactStore, "readBlob">) {}

  async read(source: ArtifactRecord, edge: number, signal: AbortSignal): Promise<ImageThumbnailResult> {
    signal.throwIfAborted();
    if (!["image/png", "image/jpeg", "image/webp"].includes(source.mimeType)) return { unavailable: ImageThumbnailUnavailableReason.UNSUPPORTED };
    if (source.byteLength < 1 || source.byteLength > maximumInputBytes) return { unavailable: ImageThumbnailUnavailableReason.INPUT_TOO_LARGE };
    const key = JSON.stringify([source.id, source.sha256, source.byteLength, source.mimeType, edge]);
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key); this.#cache.set(key, cached); return { thumbnail: copy(cached) };
    }
    if (this.#waiting.length >= 32) return { unavailable: ImageThumbnailUnavailableReason.BUSY };
    const controller = new AbortController(); const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, 5_000);
    try {
      await this.#acquire(controller.signal);
      const raw = this.#render(source, edge, controller.signal);
      // A cancelled native decoder retains its slot until it actually settles.
      void raw.then(() => this.#release(), () => this.#release());
      const result = await cancelledRead(raw, controller.signal);
      signal.throwIfAborted(); controller.signal.throwIfAborted();
      if ("thumbnail" in result) {
        while (this.#cache.size >= 64 || result.thumbnail.data.length + [...this.#cache.values()].reduce((sum, value) => sum + value.data.length, 0) > 16 * 1_024 * 1_024) {
          this.#cache.delete(this.#cache.keys().next().value!);
        }
        this.#cache.set(key, result.thumbnail); return { thumbnail: copy(result.thumbnail) };
      }
      return result;
    } catch (failure) {
      signal.throwIfAborted();
      // Decode failures and soft deadlines have the same explicit original-file fallback.
      if (failure instanceof ThumbnailSourceError) throw failure;
      return { unavailable: ImageThumbnailUnavailableReason.RENDER_FAILED };
    } finally { clearTimeout(deadline); signal.removeEventListener("abort", abort); }
  }

  async #render(source: ArtifactRecord, edge: number, signal: AbortSignal): Promise<ImageThumbnailResult> {
    const input = await this.artifacts.readBlob(source).catch(() => { throw new ThumbnailSourceError(); });
    signal.throwIfAborted();
    if (input.mimeType !== source.mimeType || input.data.length !== source.byteLength || digest(input.data) !== source.sha256) throw new ThumbnailSourceError();
    const detected = await fileTypeFromBuffer(input.data.subarray(0, 65_536)).catch(() => undefined);
    if (detected?.mime !== source.mimeType) throw new ThumbnailSourceError();
    if (animatedRaster(input.data, source.mimeType)) return { unavailable: ImageThumbnailUnavailableReason.UNSUPPORTED };
    const decoder = sharp(Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength), { failOn: "warning", limitInputPixels: maximumPixels }).timeout({ seconds: 5 });
    const metadata = await decoder.metadata(); signal.throwIfAborted();
    if (`image/${metadata.format}` !== source.mimeType || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1
      || metadata.width > 16_384 || metadata.height > 16_384 || metadata.width * metadata.height > maximumPixels) {
      return { unavailable: ImageThumbnailUnavailableReason.UNSUPPORTED };
    }
    const output = await decoder.rotate().resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    signal.throwIfAborted();
    if (!output.data.length || output.data.length > IMAGE_THUMBNAIL_MAXIMUM_BYTES || output.info.width < 1 || output.info.height < 1
      || output.info.width > edge || output.info.height > edge || output.info.format !== "webp") return { unavailable: ImageThumbnailUnavailableReason.RENDER_FAILED };
    return { thumbnail: { data: Uint8Array.from(output.data), mediaType: "image/webp", sha256Hex: digest(output.data),
      widthPixels: output.info.width, heightPixels: output.info.height, sourceWidthPixels: metadata.width, sourceHeightPixels: metadata.height } };
  }
  #acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); if (this.#active < 2 && !this.#waiting.length) { this.#active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const item = { signal, grant: () => { signal.removeEventListener("abort", item.cancel); resolve(); }, cancel: () => {
        signal.removeEventListener("abort", item.cancel); this.#waiting = this.#waiting.filter((value) => value !== item); reject(new Error("Thumbnail read cancelled."));
      } };
      this.#waiting.push(item); signal.addEventListener("abort", item.cancel, { once: true });
    });
  }
  #release(): void {
    this.#active--; while (this.#active < 2 && this.#waiting.length) {
      const next = this.#waiting.shift()!; if (next.signal.aborted) next.cancel(); else { this.#active++; next.grant(); }
    }
  }
}

export class ThumbnailSourceError extends Error { constructor() { super("The canonical thumbnail source changed."); } }
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function copy(value: Thumbnail): Thumbnail { return { ...value, data: Uint8Array.from(value.data) }; }
function animatedRaster(bytes: Uint8Array, mime: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (mime === "image/png") {
    let offset = 8; let count = 0;
    while (offset + 12 <= bytes.length && count++ < 16_384) {
      const length = view.getUint32(offset); if (offset + length + 12 > bytes.length) return true;
      if (bytes[offset + 4] === 97 && bytes[offset + 5] === 99 && bytes[offset + 6] === 84 && bytes[offset + 7] === 76) return true;
      offset += length + 12;
    }
    return offset !== bytes.length;
  }
  if (mime === "image/webp") {
    let offset = 12; let count = 0;
    while (offset + 8 <= bytes.length && count++ < 16_384) {
      const length = view.getUint32(offset + 4, true); if (offset + length + 8 > bytes.length) return true;
      if (bytes[offset] === 86 && bytes[offset + 1] === 80 && bytes[offset + 2] === 56 && bytes[offset + 3] === 88 && length >= 10 && (bytes[offset + 8]! & 2)) return true;
      offset += length + 8 + (length & 1);
    }
    return offset !== bytes.length;
  }
  return false;
}
async function cancelledRead<T>(raw: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  try { return await Promise.race([raw, new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Thumbnail read cancelled.")); signal.addEventListener("abort", abort, { once: true });
  })]); } finally { signal.removeEventListener("abort", abort); }
}
