import { createHash } from "node:crypto";
import sharp from "sharp";
import { ImageThumbnailUnavailableReason } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "./artifact-store.js";
import { ImageThumbnailRenderer } from "./image-thumbnail.js";

afterEach(() => vi.useRealTimers());
function source(bytes: Uint8Array, mimeType = "image/png", id = "source"): ArtifactRecord {
  return { id, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, mimeType, fileName: "image",
    storagePath: "service-private-source", createdAt: 1 };
}
async function png(width = 2048, height = 1024) {
  return sharp({ create: { width, height, channels: 4, background: { r: 230, g: 100, b: 20, alpha: 0.5 } } }).png().toBuffer();
}

describe("canonical static image thumbnails", () => {
  it("resizes real raster pixels, preserves alpha and orientation, avoids upscale and isolates cached responses", async () => {
    const bytes = await png(); const readBlob = vi.fn(async () => ({ data: bytes, mimeType: "image/png" }));
    const renderer = new ImageThumbnailRenderer({ readBlob }); const signal = new AbortController().signal;
    const result = await renderer.read(source(bytes), 1024, signal); if (!("thumbnail" in result)) throw new Error("Thumbnail missing");
    expect(result.thumbnail).toMatchObject({ widthPixels: 1024, heightPixels: 512, sourceWidthPixels: 2048, sourceHeightPixels: 1024, mediaType: "image/webp" });
    const pixels = await sharp(result.thumbnail.data).raw().toBuffer({ resolveWithObject: true });
    expect(pixels.info.channels).toBe(4); expect(pixels.data[3]).toBeGreaterThanOrEqual(126); expect(pixels.data[3]).toBeLessThanOrEqual(129);
    expect(result.thumbnail.sha256Hex).toBe(createHash("sha256").update(result.thumbnail.data).digest("hex"));
    result.thumbnail.data.fill(0); const cached = await renderer.read(source(bytes), 1024, signal);
    expect("thumbnail" in cached && cached.thumbnail.data.some((value) => value !== 0)).toBe(true); expect(readBlob).toHaveBeenCalledOnce();
    const rotated = await sharp(await png(20, 10)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const oriented = await new ImageThumbnailRenderer({ readBlob: async () => ({ data: rotated, mimeType: "image/jpeg" }) }).read(source(rotated, "image/jpeg"), 256, signal);
    expect(oriented).toMatchObject({ thumbnail: { widthPixels: 10, heightPixels: 20, sourceWidthPixels: 20, sourceHeightPixels: 10 } });
    const webp = await sharp(await png(40, 20)).webp().toBuffer();
    expect(await new ImageThumbnailRenderer({ readBlob: async () => ({ data: webp, mimeType: "image/webp" }) }).read(source(webp, "image/webp"), 256, signal))
      .toMatchObject({ thumbnail: { widthPixels: 40, heightPixels: 20 } });
  });

  it("keeps animation and unsupported formats on their original path and rejects forged canonical source bytes", async () => {
    const bytes = await png(1, 2);
    const frame = (pixel: number) => [33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, pixel, 1, 0];
    const gif = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, ...frame(68), ...frame(76), 59]);
    const animation = await sharp(gif, { animated: true }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const readBlob = vi.fn(async () => ({ data: animation, mimeType: "image/webp" })); const renderer = new ImageThumbnailRenderer({ readBlob });
    const signal = new AbortController().signal;
    expect(await renderer.read(source(animation, "image/webp"), 1024, signal)).toEqual({ unavailable: ImageThumbnailUnavailableReason.UNSUPPORTED });
    expect(await renderer.read(source(bytes, "image/gif"), 1024, signal)).toEqual({ unavailable: ImageThumbnailUnavailableReason.UNSUPPORTED });
    expect(await renderer.read({ ...source(bytes), byteLength: 48 * 1024 * 1024 + 1 }, 1024, signal)).toEqual({ unavailable: ImageThumbnailUnavailableReason.INPUT_TOO_LARGE });
    expect(readBlob).toHaveBeenCalledOnce();
    const forged = new ImageThumbnailRenderer({ readBlob: async () => ({ data: bytes, mimeType: "image/png" }) });
    await expect(forged.read({ ...source(bytes), sha256: "a".repeat(64) }, 1024, signal)).rejects.toThrow(/canonical.*source changed/u);
    await expect(forged.read(source(bytes, "image/webp"), 1024, signal)).rejects.toThrow(/canonical.*source changed/u);
  });

  it("bounds concurrent processing and deadlines while cancelled raw reads keep their slot", async () => {
    const bytes = await png(1, 1); const finish = new Map<string, () => void>();
    const readBlob = vi.fn((blob: { id: string }) => new Promise<{ data: Uint8Array; mimeType: string }>((resolve) => {
      finish.set(blob.id, () => resolve({ data: bytes, mimeType: "image/png" }));
    }));
    const renderer = new ImageThumbnailRenderer({ readBlob }); const controller = new AbortController();
    const first = renderer.read(source(bytes, "image/png", "one"), 1024, controller.signal); const rejected = expect(first).rejects.toThrow();
    const second = renderer.read(source(bytes, "image/png", "two"), 1024, new AbortController().signal);
    const third = renderer.read(source(bytes, "image/png", "three"), 1024, new AbortController().signal);
    await vi.waitFor(() => expect(readBlob).toHaveBeenCalledTimes(2)); controller.abort(); await rejected;
    const queued = Array.from({ length: 31 }, (_, index) => {
      const pending = new AbortController(); const result = renderer.read(source(bytes, "image/png", `queued-${index}`), 1024, pending.signal);
      return { pending, result };
    });
    const settledQueue = Promise.allSettled(queued.map((value) => value.result));
    expect(await renderer.read(source(bytes, "image/png", "overflow"), 1024, new AbortController().signal))
      .toEqual({ unavailable: ImageThumbnailUnavailableReason.BUSY });
    queued.forEach((value) => value.pending.abort()); expect((await settledQueue).every((value) => value.status === "rejected")).toBe(true);
    expect(readBlob).toHaveBeenCalledTimes(2); finish.get("one")!(); await vi.waitFor(() => expect(readBlob).toHaveBeenCalledTimes(3));
    finish.get("two")!(); finish.get("three")!(); expect(await second).toHaveProperty("thumbnail"); expect(await third).toHaveProperty("thumbnail");
    vi.useFakeTimers(); let late!: () => void;
    const hung = new ImageThumbnailRenderer({ readBlob: () => new Promise((resolve) => { late = () => resolve({ data: bytes, mimeType: "image/png" }); }) });
    const timed = hung.read(source(bytes), 1024, new AbortController().signal); await vi.advanceTimersByTimeAsync(5000);
    await expect(timed).resolves.toEqual({ unavailable: ImageThumbnailUnavailableReason.RENDER_FAILED }); late(); await Promise.resolve();
  });

  it("evicts the least recently used derivative at the bounded cache entry limit", async () => {
    const bytes = await png(1, 1); const readBlob = vi.fn(async () => ({ data: bytes, mimeType: "image/png" }));
    const renderer = new ImageThumbnailRenderer({ readBlob }); const signal = new AbortController().signal;
    for (let index = 0; index < 64; index++) await renderer.read(source(bytes, "image/png", `source-${index}`), 256, signal);
    await renderer.read(source(bytes, "image/png", "source-0"), 256, signal);
    await renderer.read(source(bytes, "image/png", "source-64"), 256, signal); expect(readBlob).toHaveBeenCalledTimes(65);
    await renderer.read(source(bytes, "image/png", "source-0"), 256, signal); expect(readBlob).toHaveBeenCalledTimes(65);
    await renderer.read(source(bytes, "image/png", "source-1"), 256, signal); expect(readBlob).toHaveBeenCalledTimes(66);
  });
});
