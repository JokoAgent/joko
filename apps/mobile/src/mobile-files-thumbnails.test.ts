import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { BlobRefSchema, ImageThumbnailSchema } from "@joko/contracts";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bmpBytes, gifBytes } from "./test/image-formats";
import { MobileFilesThumbnailReader, mobileFilesDocumentBytes, type MobileFilesThumbnailContext, type MobileFilesThumbnailInput } from "./mobile-files-thumbnails";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const readers = new Set<MobileFilesThumbnailReader>();
function reader() { const result = new MobileFilesThumbnailReader(); readers.add(result); return result; }
afterEach(() => { for (const result of readers) result.releaseAll(); readers.clear(); vi.useRealTimers(); });
function fixture(key = "source", input: MobileFilesThumbnailInput | undefined = { kind: "text", text: "# actual document\nhello" }) {
  let current = true; const assertCurrent = () => { if (!current) throw new Error("Source retired"); };
  const context: MobileFilesThumbnailContext = { ownerKey: "files-owner", sourceKey: key, assertCurrent,
    revalidate: vi.fn(async () => assertCurrent()), read: vi.fn(async () => input) };
  return { context, retire: () => { current = false; } };
}
function original(bytes = gifBytes(), mediaType = "image/gif"): MobileFilesThumbnailInput & { kind: "image" } {
  return { kind: "image", bytes, mediaType, blob: create(BlobRefSchema, { blobId: "original", fileName: "original", mediaType, byteSize: BigInt(bytes.length), sha256Hex: digest(bytes) }) };
}

describe("canonical Files image and document miniature resources", () => {
  it("verifies a real 256px derivative and original fallback, reauthorizes cache hits and rejects a changed native decoder or bytes", async () => {
    const value = reader(); const bytes = await sharp({ create: { width: 256, height: 128, channels: 4, background: "orange" } }).webp().toBuffer();
    const thumbnail = create(ImageThumbnailSchema, { data: bytes, mediaType: "image/webp", sha256Hex: digest(bytes),
      widthPixels: 256, heightPixels: 128, sourceWidthPixels: 1200, sourceHeightPixels: 600 });
    const sourceBytes = await sharp({ create: { width: 1200, height: 600, channels: 4, background: "orange" } }).png().toBuffer();
    const input = { ...original(sourceBytes, "image/png"), bytes, mediaType: "image/webp", thumbnail }; const source = fixture("derivative", input);
    const first = await value.prepare(source.context, new AbortController().signal);
    expect(first.content).toMatchObject({ kind: "image", width: 256, height: 128, mediaType: "image/webp", animated: false });
    value.confirm(first.leaseId, { width: 256, height: 128, mediaType: "image/webp", isAnimated: false }); value.release(first.leaseId);
    const cached = await value.prepare(source.context, new AbortController().signal);
    expect(source.context.revalidate).toHaveBeenCalledTimes(2); expect(source.context.read).toHaveBeenCalledOnce();
    expect(() => value.confirm(cached.leaseId, { width: 128, height: 128 })).toThrow(/dimensions/u);
    await value.prepare(source.context, new AbortController().signal); expect(source.context.read).toHaveBeenCalledTimes(2);
    vi.mocked(source.context.revalidate).mockRejectedValue(new Error("Authenticated source changed"));
    await expect(value.prepare(source.context, new AbortController().signal)).rejects.toThrow(/Authenticated/u);
    for (const change of [{ sha256Hex: "a".repeat(64) }, { widthPixels: 128 }, { sourceWidthPixels: 0 }]) {
      await expect(value.prepare(fixture(JSON.stringify(change), { ...input, thumbnail: { ...thumbnail, ...change } }).context, new AbortController().signal)).rejects.toThrow(/thumbnail/u);
    }
    const fallback = fixture("fallback", original()); const image = await value.prepare(fallback.context, new AbortController().signal);
    expect(image.content).toMatchObject({ kind: "image", width: 1, height: 1, mediaType: "image/gif" });
    value.confirm(image.leaseId, { width: 1, height: 1, mediaType: "image/gif", isAnimated: false });
    fallback.retire(); value.retireStale(); expect(() => value.confirm(image.leaseId, { width: 1, height: 1 })).toThrow(/released/u);
    await expect(value.prepare(fixture("forged", { ...original(), bytes: gifBytes(true) }).context, new AbortController().signal)).rejects.toThrow(/bytes changed/u);
  });
  it("uses real bounded text, distinguishes unavailable from transport failure and rejects forged or binary document bytes", async () => {
    const value = reader(); const source = fixture("doc", { kind: "text", text: "# heading\r\n" + "a".repeat(3000) });
    const text = await value.prepare(source.context, new AbortController().signal);
    expect(text.content).toEqual({ kind: "text", text: ("# heading\n" + "a".repeat(3000)).slice(0, 2000) }); value.release(text.leaseId);
    const unavailable = fixture("unsupported", undefined); vi.mocked(unavailable.context.read).mockResolvedValue(undefined);
    const empty = await value.prepare(unavailable.context, new AbortController().signal); expect(empty.content).toBeUndefined(); value.release(empty.leaseId);
    await value.prepare(unavailable.context, new AbortController().signal); expect(unavailable.context.read).toHaveBeenCalledOnce();
    const transient = fixture("transient"); vi.mocked(transient.context.read).mockRejectedValueOnce(new Error("Transport failed"));
    await expect(value.prepare(transient.context, new AbortController().signal)).rejects.toThrow(/Transport/u);
    expect((await value.prepare(transient.context, new AbortController().signal)).content?.kind).toBe("text"); expect(transient.context.read).toHaveBeenCalledTimes(2);
    const bytes = new TextEncoder().encode("actual\n文件内容"); const blob = original(bytes, "text/plain").blob;
    expect(mobileFilesDocumentBytes(blob, { bytes, mediaType: "text/plain" })).toBe("actual\n文件内容");
    expect(() => mobileFilesDocumentBytes({ ...blob, sha256Hex: "b".repeat(64) }, { bytes, mediaType: "text/plain" })).toThrow(/bytes/u);
    const binary = new Uint8Array([255, 0, 1]); expect(mobileFilesDocumentBytes(original(binary, "text/plain").blob, { bytes: binary, mediaType: "text/plain" })).toBeUndefined();
  });
  it("keeps three raw pipelines occupied until cancelled reads actually settle and rejects late source adoption", async () => {
    const value = reader(); const sources = Array.from({ length: 4 }, (_, index) => fixture(String(index)));
    const finish: (() => void)[] = []; sources.forEach((source, index) => vi.mocked(source.context.read).mockImplementation(() => new Promise((resolve) => { finish[index] = () => resolve({ kind: "text", text: "late " + index }); })));
    const controllers = sources.map(() => new AbortController());
    const results = sources.map((source, index) => value.prepare(source.context, controllers[index]!.signal).then((preview) => preview, () => undefined));
    await vi.waitFor(() => expect(finish.filter(Boolean)).toHaveLength(3)); controllers[0]!.abort(); await results[0];
    expect(sources[3]!.context.read).not.toHaveBeenCalled(); finish[0]!(); await vi.waitFor(() => expect(finish.filter(Boolean)).toHaveLength(4));
    sources[1]!.retire(); value.retireStale(); finish[1]!(); finish[2]!(); finish[3]!();
    expect(await results[1]).toBeUndefined(); expect((await results[2])?.content).toEqual({ kind: "text", text: "late 2" });
    expect((await results[3])?.content).toEqual({ kind: "text", text: "late 3" });
  });
  it("evicts unpinned entries after 300 items and refuses a single image beyond the private memory budget", async () => {
    const value = reader(); const first = fixture("first"); let preview = await value.prepare(first.context, new AbortController().signal); value.release(preview.leaseId);
    for (let index = 0; index < 300; index++) { preview = await value.prepare(fixture(String(index)).context, new AbortController().signal); value.release(preview.leaseId); }
    await value.prepare(first.context, new AbortController().signal); expect(first.context.read).toHaveBeenCalledTimes(2);
    await expect(value.prepare(fixture("large", original(bmpBytes(2000, 2000), "image/bmp")).context, new AbortController().signal)).rejects.toThrow(/memory limit/u);
    value.retainOwner("another-owner"); expect(() => value.confirm(preview.leaseId, { width: 1, height: 1 })).toThrow(/released/u);
  });
});
