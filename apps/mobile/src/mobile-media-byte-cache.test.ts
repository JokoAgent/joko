import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { BlobRefSchema, ImageThumbnailSchema } from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { MobileMediaByteCache, type MobileMediaCacheDriver } from "./mobile-media-byte-cache";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== resolve(tmpdir()) || !root.startsWith(join(resolve(tmpdir()), "joko-media-cache-"))) throw new Error("Unsafe fixture cleanup");
    await rm(root, { recursive: true, force: true });
  }
});
const owner = { profileId: "profile", origin: "https://node.example", serverId: "server", connectionId: "connection", deviceId: "phone", displayName: "Node" };
const current = () => undefined;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function source(bytes = new Uint8Array([1, 2, 3]), id = "picture") {
  return { bytes, blob: create(BlobRefSchema, { blobId: id, sha256Hex: digest(bytes), byteSize: BigInt(bytes.length), mediaType: "image/png", fileName: id + ".png" }) };
}
async function fixture() {
  const root = resolve(await mkdtemp(join(tmpdir(), "joko-media-cache-"))); roots.push(root);
  const path = (name: string) => { const result = resolve(root, name); if (dirname(result) !== root) throw new Error("Invalid fixture path"); return result; };
  let beforePublish: (() => void | Promise<void>) | undefined;
  const driver: MobileMediaCacheDriver = {
    list: async () => Promise.all((await readdir(root)).map(async (name) => { const file = await stat(path(name)); return { name, byteSize: file.size, modifiedAt: file.mtimeMs }; })),
    read: async (name, maximum) => { try { const bytes = new Uint8Array(await readFile(path(name))); if (bytes.length > maximum) throw new Error("Too large"); return bytes; }
      catch (error) { if ((error as { code?: string }).code === "ENOENT") return undefined; throw error; } },
    write: async (name, bytes, assertCurrent) => {
      const stage = name + ".tmp";
      try { assertCurrent(); await writeFile(path(stage), bytes); await beforePublish?.(); assertCurrent(); await rename(path(stage), path(name)); assertCurrent(); }
      finally { await unlink(path(stage)).catch(() => undefined); }
    },
    remove: async (name) => { await unlink(path(name)).catch((error: { code?: string }) => { if (error.code !== "ENOENT") throw error; }); }
  };
  return { root, driver, pause: (callback: () => void | Promise<void>) => { beforePublish = callback; } };
}

describe("local media byte cache", () => {
  it("restores verified bytes after restart, isolates every owner and source version, and removes corrupt copies", async () => {
    const files = await fixture(), value = source(); const cache = new MobileMediaByteCache(files.driver);
    await cache.put(owner, value.blob, value.bytes, current);
    const restored = new MobileMediaByteCache(files.driver);
    expect(await restored.get(owner, value.blob, current)).toEqual({ bytes: value.bytes, mediaType: "image/png" });
    for (const key of ["profileId", "origin", "serverId", "connectionId", "deviceId"] as const) {
      expect(await restored.get({ ...owner, [key]: "different" }, value.blob, current)).toBeUndefined();
    }
    for (const changed of [{ blobId: "other" }, { sha256Hex: "a".repeat(64) }, { byteSize: 2n }, { mediaType: "image/webp" }, { fileName: "new.png" }]) {
      expect(await restored.get(owner, { ...value.blob, ...changed }, current)).toBeUndefined();
    }
    const [name] = await readdir(files.root); await writeFile(join(files.root, name!), new Uint8Array([7, 8, 9]));
    expect(await restored.get(owner, value.blob, current)).toBeUndefined(); expect(await readdir(files.root)).toEqual([]);
  });

  it("retains independent thumbnail metadata and never substitutes it for original bytes or a different edge", async () => {
    const files = await fixture(), cache = new MobileMediaByteCache(files.driver), value = source();
    const thumbnail = create(ImageThumbnailSchema, { data: value.bytes, sha256Hex: digest(value.bytes), mediaType: "image/webp",
      widthPixels: 100, heightPixels: 50, sourceWidthPixels: 1000, sourceHeightPixels: 500 });
    await cache.putThumbnail(owner, value.blob, 256, thumbnail, current);
    expect(await new MobileMediaByteCache(files.driver).getThumbnail(owner, value.blob, 256, current)).toEqual(thumbnail);
    expect(await cache.getThumbnail(owner, value.blob, 1024, current)).toBeUndefined(); expect(await cache.get(owner, value.blob, current)).toBeUndefined();
    await expect(cache.putThumbnail(owner, value.blob, 256, { ...thumbnail, widthPixels: 300 }, current)).rejects.toThrow(/thumbnail/u);
    await expect(cache.put(owner, value.blob, new Uint8Array([4, 5, 6]), current)).rejects.toThrow(/canonical/u);
  });

  it("fences pending downloads and writes when their profile is cleared without removing another profile", async () => {
    const files = await fixture(), cache = new MobileMediaByteCache(files.driver), value = source();
    await cache.put({ ...owner, profileId: "other" }, value.blob, value.bytes, current);
    const priorDownload = cache.captureOwner(owner.profileId, current);
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), blocked = new Promise<void>((resolve) => { resume = resolve; });
    files.pause(async () => { entered(); await blocked; });
    const pending = cache.put(owner, value.blob, value.bytes, current); const rejected = expect(pending).rejects.toThrow(/cleared/u);
    await started; const cleared = cache.clear(owner.profileId); resume(); await rejected; await cleared;
    expect(() => priorDownload()).toThrow(/cleared/u);
    await expect(cache.put(owner, value.blob, value.bytes, priorDownload)).rejects.toThrow(/cleared/u);
    expect(await cache.get(owner, value.blob, current)).toBeUndefined();
    expect(await cache.get({ ...owner, profileId: "other" }, value.blob, current)).toEqual({ bytes: value.bytes, mediaType: "image/png" });
  });

  it("reconciles interrupted files and evicts old copies before the staged disk budget is exceeded", async () => {
    const files = await fixture(); let clock = 1000; const cache = new MobileMediaByteCache(files.driver, () => ++clock);
    await writeFile(join(files.root, "interrupted.tmp"), "unfinished");
    const bytes = new Uint8Array(32 * 1024 * 1024);
    for (let index = 0; index < 9; index++) { const value = source(bytes, String(index)); await cache.put(owner, value.blob, bytes, current); }
    const stored = await files.driver.list(); expect(stored).toHaveLength(7);
    expect(stored.reduce((sum, file) => sum + file.byteSize, 0)).toBe(224 * 1024 * 1024);
    expect(await cache.get(owner, source(bytes, "0").blob, current)).toBeUndefined();
    expect((await cache.get(owner, source(bytes, "8").blob, current))?.bytes.length).toBe(bytes.length);
  });
});
