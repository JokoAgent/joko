import { create } from "@bufbuild/protobuf";
import { BlobRefSchema, ImageThumbnailSchema } from "@joko/contracts";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mobileImageGalleryPage } from "./mobile-image-gallery";
import { gifBytes, iconBytes, iconDibBytes, tiffBytes } from "./test/image-formats";
import { MobileTimelineImageReader, type MobileTimelineImageContext } from "./mobile-timeline-images";

const readers: MobileTimelineImageReader[] = [];
afterEach(() => { readers.splice(0).forEach((reader) => reader.releaseAll()); });
function reader() { const value = new MobileTimelineImageReader(); readers.push(value); return value; }
function fixture(id = "one", bytes = gifBytes(), mediaType = "image/gif") {
  let current = true;
  const page = mobileImageGalleryPage({ pageId: id, title: id, blob: create(BlobRefSchema, { blobId: id, fileName: id,
    mediaType, byteSize: BigInt(bytes.length), sha256Hex: createHash("sha256").update(bytes).digest("hex") }),
    source: { kind: "timeline", eventId: id, messageId: id, contentKind: "block", contentIndex: 0 } })!;
  const assertCurrent = () => { if (!current) throw new Error("Source changed"); };
  const context: MobileTimelineImageContext = { ownerKey: "task", page, assertCurrent,
    revalidate: vi.fn(async () => assertCurrent()), download: vi.fn(async () => ({ bytes, mediaType })) };
  return { context, retire: () => { current = false; } };
}

describe("canonical Timeline image resources", () => {
  it.each(["png", "webp"] as const)("retains the first confirmed EXIF %s canvas across cached previews", async (format) => {
    const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "orange" } })
      .withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const value = reader(); const { context } = fixture("portrait", bytes, "image/" + format);
    const first = await value.prepare(context, new AbortController().signal);
    expect(first).toMatchObject({ width: 6, height: 4, nativeQuarterTurn: true });
    expect(value.confirm(first.leaseId, { width: 4, height: 6, mediaType: "image/" + format, isAnimated: false }))
      .toMatchObject({ leaseId: first.leaseId, uri: first.uri, width: 4, height: 6 });
    value.release(first.leaseId);
    const cached = await value.prepare(context, new AbortController().signal);
    expect(cached).toMatchObject({ width: 4, height: 6, nativeQuarterTurn: true });
    expect(context.download).toHaveBeenCalledOnce();
    expect(() => value.confirm(cached.leaseId, { width: 6, height: 4, isAnimated: false })).toThrow(/canonical source/u);
  });
  it("verifies independent thumbnail bytes and native dimensions while retaining the original Blob as its cache identity", async () => {
    const value = reader(); const bytes = await sharp({ create: { width: 800, height: 400, channels: 3, background: "orange" } }).webp().toBuffer();
    const original = fixture("large-image"); const context = { ...original.context, page: { ...original.context.page, widthPixels: 1600, heightPixels: 800 } };
    const thumbnail = create(ImageThumbnailSchema, { data: bytes, mediaType: "image/webp", sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      widthPixels: 800, heightPixels: 400, sourceWidthPixels: 1600, sourceHeightPixels: 800 });
    context.download = vi.fn(async () => ({ bytes, mediaType: "image/webp", thumbnail }));
    const preview = await value.prepare(context, new AbortController().signal);
    expect(preview).toMatchObject({ width: 800, height: 400, mediaType: "image/webp", animated: false });
    value.confirm(preview.leaseId, { width: 800, height: 400, mediaType: "image/webp", isAnimated: false }); value.release(preview.leaseId);
    const pin = value.pinCached(context, new AbortController().signal); expect(pin?.uri).toBe(preview.uri); expect(context.download).toHaveBeenCalledOnce();
    value.releaseAll();
    for (const changed of [{ ...thumbnail, sourceWidthPixels: 800 }, { ...thumbnail, widthPixels: 400 }, { ...thumbnail, sha256Hex: "a".repeat(64) }]) {
      context.download = vi.fn(async () => ({ bytes, mediaType: "image/webp", thumbnail: changed }));
      await expect(value.prepare(context, new AbortController().signal)).rejects.toThrow(/dimensions|metadata|bytes/u);
    }
  });
  it("pins only an exact cached page independently of its inline consumer, without starting another read", async () => {
    const value = reader(); const source = fixture(); const inlineController = new AbortController();
    const inline = await value.prepare(source.context, inlineController.signal);
    const galleryController = new AbortController(); const pinned = value.pinCached(source.context, galleryController.signal)!;
    expect(pinned.leaseId).not.toBe(inline.leaseId); expect(pinned.uri).toBe(inline.uri);
    inlineController.abort(); value.confirm(pinned.leaseId, { width: 1, height: 1, isAnimated: false });
    expect(source.context.download).toHaveBeenCalledOnce(); expect(source.context.revalidate).toHaveBeenCalledOnce();
    expect(value.pinCached(fixture("another-page").context, galleryController.signal)).toBeUndefined();
    expect(value.pinCached({ ...source.context, page: { ...source.context.page, sha256Hex: "b".repeat(64) } }, galleryController.signal)).toBeUndefined();
    source.retire(); value.retireStale(); expect(() => value.confirm(pinned.leaseId, { width: 1, height: 1 })).toThrow(/released/u);
  });
  it("reauthorizes cache hits, confirms actual native MIME and drops a rejected icon preview before retry", async () => {
    const value = reader(); const { context } = fixture("icon", iconBytes([{ bytes: iconDibBytes(3, 2), width: 3, height: 2 }]), "image/x-icon");
    const first = await value.prepare(context, new AbortController().signal);
    expect(first).toMatchObject({ mediaType: "image/png", width: 3, height: 2, animated: false }); expect(first.uri).toMatch(/^data:image\/png;/u);
    value.confirm(first.leaseId, { width: 3, height: 2, mediaType: "image/png", isAnimated: false }); value.release(first.leaseId);
    const cached = await value.prepare(context, new AbortController().signal);
    expect(context.download).toHaveBeenCalledOnce(); expect(context.revalidate).toHaveBeenCalledTimes(2);
    expect(() => value.confirm(first.leaseId, { width: 3, height: 2 })).toThrow(/released/u);
    expect(() => value.confirm(cached.leaseId, { width: 1, height: 1, mediaType: "image/png", isAnimated: false })).toThrow(/canonical source/u);
    await value.prepare(context, new AbortController().signal); expect(context.download).toHaveBeenCalledTimes(2);
    value.releaseAll(); await value.prepare(context, new AbortController().signal); expect(context.download).toHaveBeenCalledTimes(3);
  });

  it("rejects bad length, MIME and SHA bytes, and never lends cached bytes to a retired source", async () => {
    const value = reader();
    for (const mismatch of ["length", "MIME", "SHA"]) {
      const { context } = fixture(mismatch);
      vi.mocked(context.download).mockResolvedValue({ bytes: mismatch === "length" ? gifBytes().slice(0, -1)
        : mismatch === "SHA" ? Uint8Array.from(gifBytes(), (byte, index) => index === 12 ? byte + 1 : byte) : gifBytes(),
        mediaType: mismatch === "MIME" ? "image/png" : "image/gif" });
      await expect(value.prepare(context, new AbortController().signal)).rejects.toThrow(/bytes changed/u);
    }
    const source = fixture(); const image = await value.prepare(source.context, new AbortController().signal);
    source.retire(); value.retireStale(); expect(() => value.confirm(image.leaseId, { width: 1, height: 1 })).toThrow(/released/u);
    await expect(value.prepare(source.context, new AbortController().signal)).rejects.toThrow(/Source changed/u);
    const live = fixture("fresh"); const ready = await value.prepare(live.context, new AbortController().signal); value.release(ready.leaseId);
    vi.mocked(live.context.revalidate).mockRejectedValue(new Error("Remote replacement"));
    await expect(value.prepare(live.context, new AbortController().signal)).rejects.toThrow(/Remote replacement/u);
    expect(live.context.download).toHaveBeenCalledOnce();
  });

  it("limits source revalidation and download to two pipelines even when a cancelled transport settles late", async () => {
    const value = reader(); const sources = [fixture("one"), fixture("two"), fixture("three")];
    const finish: (() => void)[] = [];
    sources.forEach(({ context }, index) => vi.mocked(context.download).mockImplementation(() => new Promise((resolve) => {
      finish[index] = () => resolve({ bytes: gifBytes(), mediaType: "image/gif" });
    })));
    const controller = new AbortController();
    const first = value.prepare(sources[0]!.context, controller.signal); const rejected = expect(first).rejects.toThrow(/cancelled/u);
    const second = value.prepare(sources[1]!.context, new AbortController().signal); const third = value.prepare(sources[2]!.context, new AbortController().signal);
    await vi.waitFor(() => expect(sources[1]!.context.download).toHaveBeenCalledOnce());
    expect(sources[2]!.context.revalidate).not.toHaveBeenCalled(); controller.abort(); await rejected;
    expect(sources[2]!.context.download).not.toHaveBeenCalled(); finish[0]!();
    await vi.waitFor(() => expect(sources[2]!.context.download).toHaveBeenCalledOnce()); finish[1]!(); finish[2]!();
    const results = await Promise.all([second, third]); expect(results.map((image) => image.width)).toEqual([1, 1]);
  });

  it("bounds pinned entries and pixels, evicts released entries, and isolates the next task's cache", async () => {
    const value = reader(); const images = [];
    for (let index = 0; index < 16; index++) images.push(await value.prepare(fixture(String(index)).context, new AbortController().signal));
    await expect(value.prepare(fixture("seventeen").context, new AbortController().signal)).rejects.toThrow(/memory limit/u);
    value.release(images[0]!.leaseId); await value.prepare(fixture("seventeen").context, new AbortController().signal);
    value.releaseAll();
    const large = await value.prepare(fixture("large", tiffBytes(16_384, 4_096), "image/tiff").context, new AbortController().signal);
    await expect(value.prepare(fixture("small").context, new AbortController().signal)).rejects.toThrow(/memory limit/u);
    value.release(large.leaseId); await value.prepare(fixture("small").context, new AbortController().signal);
    const other = fixture("small"); const context = { ...other.context, ownerKey: "other-task" };
    await value.prepare(context, new AbortController().signal); expect(other.context.download).toHaveBeenCalledOnce();
    value.retainOwner(undefined); expect(() => value.confirm(large.leaseId, { width: 16_384, height: 4_096 })).toThrow(/released/u);
  });
});
