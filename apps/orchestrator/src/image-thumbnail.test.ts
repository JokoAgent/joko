import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
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
  it("uses a static first frame for File256 GIF, animated WebP/APNG and multi-page TIFF, with decoded raster AVIF support", async () => {
    const signal = new AbortController().signal;
    const frame = (pixel: number) => [33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, pixel, 1, 0];
    const gif = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255, ...frame(68), ...frame(76), 59]);
    const animation = await sharp(gif, { animated: true }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    const tiff = await sharp({ create: { width: 40, height: 40, pageHeight: 20, channels: 3, background: "red" } }).tiff().toBuffer();
    expect((await sharp(tiff).metadata()).pages).toBe(2);
    const avif = await sharp(await png(40, 20)).avif().toBuffer();
    for (const [bytes, mime, width, height] of [[gif, "image/gif", 1, 1], [animation, "image/webp", 1, 1], [apng(), "image/apng", 1, 2],
      [apng(), "image/png", 1, 2], [tiff, "image/tiff", 40, 20], [avif, "image/avif", 40, 20]] as const) {
      const renderer = new ImageThumbnailRenderer({ readBlob: async () => ({ data: bytes, mimeType: mime }) });
      const result = await renderer.read(source(bytes, mime), 256, signal);
      expect(result).toMatchObject({ thumbnail: { widthPixels: width, heightPixels: height, sourceWidthPixels: width, sourceHeightPixels: height, mediaType: "image/webp" } });
      if (!("thumbnail" in result)) throw new Error("File thumbnail missing");
      const metadata = await sharp(result.thumbnail.data).metadata(); expect(metadata.pages ?? 1).toBe(1);
      if (mime === "image/gif" || mime === "image/webp" || mime === "image/png" || mime === "image/apng") {
        const pixel = await sharp(result.thumbnail.data).removeAlpha().raw().toBuffer(); expect(pixel[0]).toBeGreaterThan(230); expect(pixel[2]).toBeLessThan(30);
      }
      if (mime !== "image/avif") expect(await renderer.read(source(bytes, mime), 1024, signal)).toEqual({ unavailable: ImageThumbnailUnavailableReason.UNSUPPORTED });
    }
    const bytes = await png(600, 300); const renderer = new ImageThumbnailRenderer({ readBlob: async () => ({ data: bytes, mimeType: "image/png" }) });
    const result = await renderer.read(source(bytes), 256, signal); if (!("thumbnail" in result)) throw new Error("File thumbnail missing");
    const expected = await sharp(bytes, { page: 0, pages: 1, animated: false, failOn: "warning" }).rotate().resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    expect(Buffer.from(result.thumbnail.data)).toEqual(expected);
  });
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

function apng(): Uint8Array {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const control = Buffer.alloc(8); control.writeUInt32BE(2);
  const frame = (sequence: number) => { const bytes = Buffer.alloc(26); bytes.writeUInt32BE(sequence); bytes.writeUInt32BE(1, 4); bytes.writeUInt32BE(2, 8); bytes.writeUInt16BE(1, 20); bytes.writeUInt16BE(10, 22); return bytes; };
  const second = Buffer.concat([Buffer.from([0, 0, 0, 2]), deflateSync(Buffer.from([0, 0, 0, 255, 255, 0, 0, 0, 255, 255]))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header), pngChunk("acTL", control), pngChunk("fcTL", frame(0)),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 0, 255]))), pngChunk("fcTL", frame(1)), pngChunk("fdAT", second), pngChunk("IEND", Buffer.alloc(0))]);
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const result = Buffer.alloc(body.length + 8); result.writeUInt32BE(data.length); body.copy(result, 4);
  let crc = 0xffff_ffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1; }
  result.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, result.length - 4); return result;
}
