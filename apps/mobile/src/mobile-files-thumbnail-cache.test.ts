import { copyFile, mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileFilesThumbnailCache, MOBILE_FILES_CACHE_MAXIMUM_BYTES, MOBILE_FILES_CACHE_MAXIMUM_ENTRIES,
  type MobileFilesThumbnailCacheDriver } from "./mobile-files-thumbnail-cache";
import { MobileFilesThumbnailReader, type MobileFilesThumbnailContent, type MobileFilesThumbnailContext } from "./mobile-files-thumbnails";
import { bmpBytes, gifBytes, iconBytes, iconDibBytes, paddedPngBytes, svgBytes } from "./test/image-formats";
import { inspectMobileImageGalleryBytes, mobileImageGalleryPreviewUri } from "./mobile-image-gallery";

const roots: string[] = []; const readers = new Set<MobileFilesThumbnailReader>();
afterEach(async () => {
  for (const value of readers) value.releaseAll(); readers.clear();
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(resolve(tmpdir()) + sep + "joko-files-miniatures-")) throw new Error("The test cache cleanup escaped its owned directory.");
    await rm(root, { recursive: true, force: true });
  }
});
function textDigest(text: string) { return createHash("sha256").update(text).digest("hex"); }
function source(ownerKey = "owner", sourceKey = "file"): MobileFilesThumbnailContext {
  return { ownerKey, sourceKey, assertCurrent: vi.fn(), revalidate: vi.fn(async () => undefined), read: vi.fn(async () => ({ kind: "text" as const, text: "actual file source" })) };
}
function reader(cache: MobileFilesThumbnailCache) { const value = new MobileFilesThumbnailReader(cache); readers.add(value); return value; }
async function fixture() {
  const root = resolve(await mkdtemp(join(tmpdir(), "joko-files-miniatures-"))); roots.push(root);
  let clock = Date.now(); let peakBytes = 0; let peakEntries = 0;
  let beforePublish: (() => Promise<void>) | undefined;
  const path = (name: string) => {
    if (!/^[^\\/\u0000-\u001f]{1,255}$/u.test(name) || name === "." || name === "..") throw new Error("Bad cache name");
    const value = resolve(root, name); if (dirname(value) !== root) throw new Error("Escaped test cache"); return value;
  };
  const list = async () => Promise.all((await readdir(root)).map(async (name) => { const file = await stat(path(name)); return { name, byteSize: file.size, modifiedAt: file.mtimeMs }; }));
  const measure = async () => { const files = await list(); peakEntries = Math.max(peakEntries, files.length); peakBytes = Math.max(peakBytes, files.reduce((sum, file) => sum + file.byteSize, 0)); };
  const remove = async (name: string) => { try { await unlink(path(name)); } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; } };
  const driver: MobileFilesThumbnailCacheDriver = { list,
    read: async (name, maximum) => { try { const file = await stat(path(name)); if (file.size > maximum) throw new Error("Cache file too large"); return new Uint8Array(await readFile(path(name))); }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") return undefined; throw error; } },
    write: async (name, bytes, assertCurrent) => {
      const temporary = name + ".tmp";
      try {
        assertCurrent(); await writeFile(path(temporary), bytes); await measure(); await beforePublish?.(); assertCurrent();
        // Exercise the conservative two-copy budget using real disk bytes.
        await copyFile(path(temporary), path(name)); await measure(); assertCurrent();
        await utimes(path(name), (clock += 1000) / 1000, clock / 1000);
      } catch (error) { await remove(name); throw error; } finally { await remove(temporary); }
    }, remove };
  return { root, driver, list, pause: (callback: () => Promise<void>) => { beforePublish = callback; }, peak: () => ({ bytes: peakBytes, entries: peakEntries }) };
}
async function imageContent(bytes?: Uint8Array): Promise<MobileFilesThumbnailContent> {
  const image = bytes ?? await sharp({ create: { width: 1, height: 1, channels: 3, background: "orange" } }).png().toBuffer();
  return { kind: "image", uri: "data:image/png;base64," + Buffer.from(image).toString("base64"), width: 1, height: 1, mediaType: "image/png", animated: false };
}

describe("bounded private Files miniature disk cache", () => {
  it("retains authenticated EXIF canvas metadata when rehydrating original PNG and WebP miniatures", async () => {
    const files = await fixture(); const cache = new MobileFilesThumbnailCache(files.driver);
    for (const format of ["png", "webp"] as const) {
      const bytes = await sharp({ create: { width: 6, height: 4, channels: 3, background: "orange" } })
        .withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
      const content: MobileFilesThumbnailContent = { kind: "image", uri: "data:image/" + format + ";base64," + bytes.toString("base64"),
        width: 6, height: 4, mediaType: "image/" + format, animated: false, nativeQuarterTurn: true };
      await cache.put("owner", format, content, () => undefined);
      expect(await new MobileFilesThumbnailCache(files.driver).get("owner", format, () => undefined)).toEqual(content);
      await expect(cache.put("owner", "invalid-" + format, { ...content, nativeQuarterTurn: undefined }, () => undefined)).rejects.toThrow(/cache/u);
    }
  });

  it("rehydrates exact image/text copies across cache instances, keeps source revalidation and rejects foreign or corrupted records", async () => {
    const files = await fixture(); const cache = new MobileFilesThumbnailCache(files.driver); const image = await imageContent();
    await cache.put("owner", "picture", image, () => undefined); await cache.put("owner", "file", { kind: "text", text: "actual file source" }, () => undefined);
    const restored = new MobileFilesThumbnailCache(files.driver); expect(await restored.get("owner", "picture", () => undefined)).toEqual(image);
    expect(await restored.get("other-owner", "picture", () => undefined)).toBeUndefined(); expect(await restored.get("owner", "other-source", () => undefined)).toBeUndefined();
    const current = source(); const value = reader(restored); const first = await value.prepare(current, new AbortController().signal);
    expect(first.content).toEqual({ kind: "text", text: "actual file source" }); expect(current.revalidate).toHaveBeenCalledOnce(); expect(current.read).not.toHaveBeenCalled();
    vi.mocked(current.revalidate).mockRejectedValue(new Error("Authenticated source denied"));
    await expect(value.prepare(current, new AbortController().signal)).rejects.toThrow(/denied/u); expect(current.read).not.toHaveBeenCalled();
    const pictureName = (await files.list()).find((file) => file.name === textDigest(JSON.stringify([1, "owner", "picture"])) + ".json")!.name;
    const picturePath = join(files.root, pictureName); const record = JSON.parse(await readFile(picturePath, "utf8"));
    record.content.width = 2; record.payloadSha256Hex = textDigest(JSON.stringify(record.content)); await writeFile(picturePath, JSON.stringify(record));
    expect(await restored.get("owner", "picture", () => undefined)).toBeUndefined(); expect((await files.list()).some((file) => file.name === pictureName)).toBe(false);
    await cache.put("owner", "picture", image, () => undefined); const unknown = JSON.parse(await readFile(picturePath, "utf8")); unknown.version = 0;
    await writeFile(picturePath, JSON.stringify(unknown)); expect(await restored.get("owner", "picture", () => undefined)).toBeUndefined();
    for (const [bytes, mediaType] of [[gifBytes(true), "image/gif"], [svgBytes(), "image/svg+xml"], [bmpBytes(2, 2), "image/bmp"],
      [iconBytes([{ bytes: iconDibBytes(3, 2), width: 3, height: 2 }]), "image/x-icon"]] as const) {
      const decoded = inspectMobileImageGalleryBytes(bytes, mediaType); const content: MobileFilesThumbnailContent = { kind: "image", uri: mobileImageGalleryPreviewUri(bytes, decoded),
        width: decoded.width, height: decoded.height, mediaType: decoded.previewMediaType ?? decoded.mediaType, animated: decoded.animated === true };
      await cache.put("owner", mediaType, content, () => undefined); expect(await restored.get("owner", mediaType, () => undefined)).toEqual(content);
    }
    await writeFile(join(files.root, "interrupted.tmp"), "orphan"); await restored.get("owner", "missing", () => undefined);
    expect((await files.list()).every((file) => /^[a-f0-9]{64}\.json$/u.test(file.name))).toBe(true);
  });
  it("bounds actual file count and byte peaks including copy-then-delete staging, and tolerates OS cache loss", async () => {
    const files = await fixture(); const cache = new MobileFilesThumbnailCache(files.driver);
    for (let index = 0; index < 302; index++) await cache.put("owner", "document-" + index, { kind: "text", text: "actual " + index }, () => undefined);
    expect((await files.list()).length).toBeLessThanOrEqual(MOBILE_FILES_CACHE_MAXIMUM_ENTRIES); expect(await cache.get("owner", "document-0", () => undefined)).toBeUndefined();
    const plain = await sharp({ create: { width: 1, height: 1, channels: 3, background: "orange" } }).png().toBuffer();
    const image = await imageContent(paddedPngBytes(new Uint8Array(plain), 4 * 1024 * 1024));
    for (let index = 0; index < 7; index++) await cache.put("owner", "image-" + index, image, () => undefined);
    const actual = await files.list(); expect(actual.reduce((sum, file) => sum + file.byteSize, 0)).toBeLessThanOrEqual(MOBILE_FILES_CACHE_MAXIMUM_BYTES);
    expect(files.peak().bytes).toBeLessThanOrEqual(MOBILE_FILES_CACHE_MAXIMUM_BYTES); expect(files.peak().entries).toBeLessThanOrEqual(MOBILE_FILES_CACHE_MAXIMUM_ENTRIES);
    for (const file of actual) await files.driver.remove(file.name); expect(await cache.get("owner", "image-6", () => undefined)).toBeUndefined();
  }, 60_000);
  it("does not publish a cancelled late write and lets current decorative content survive an unavailable disk", async () => {
    const files = await fixture(); let finish!: () => void; let staged = false;
    files.pause(() => new Promise((resolve) => { staged = true; finish = resolve; }));
    const cache = new MobileFilesThumbnailCache(files.driver); const value = reader(cache); const context = source(); const controller = new AbortController();
    const pending = value.prepare(context, controller.signal).then((preview) => preview, () => undefined);
    await vi.waitFor(() => expect(staged).toBe(true)); controller.abort(); expect(await pending).toBeUndefined();
    finish(); await vi.waitFor(async () => expect(await files.list()).toHaveLength(0));
    const unavailable = new MobileFilesThumbnailCache({ ...files.driver, list: async () => { throw new Error("Disk unavailable"); } });
    const active = source("current", "network-file"); const ready = await reader(unavailable).prepare(active, new AbortController().signal);
    expect(ready.content).toEqual({ kind: "text", text: "actual file source" }); expect(active.read).toHaveBeenCalledOnce();
  });
});
