import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "../test/test-paths.js";
import { DesktopWallpaperStore, writeWallpaperSettings, type DesktopWallpaperStoreOptions } from "./wallpaper-store.js";

const temporaryRoots: string[] = [];
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(writeSettings?: DesktopWallpaperStoreOptions["writeSettings"]) {
  const root = await mkdtemp(join(tmpdir(), "joko-wallpaper-store-")); temporaryRoots.push(root);
  const directory = join(root, "wallpaper");
  const store = new DesktopWallpaperStore({ directory, writeSettings }); await store.initialize();
  const selected = join(root, "selected.png");
  const source = await sharp({ create: { width: 30, height: 20, channels: 3, background: "#126a7b" } }).png().toBuffer();
  await writeFile(selected, source);
  return { root, directory, store, selected, source };
}
async function secondImage(root: string): Promise<string> {
  const selected = join(root, "replacement.png");
  await writeFile(selected, await sharp({ create: { width: 12, height: 8, channels: 3, background: "#b1264a" } }).png().toBuffer());
  return selected;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe("Desktop wallpaper store", () => {
  it("starts at revision one and rejects invalid mode, mask, fields and stale CAS", async () => {
    const { store } = await fixture();
    expect(store.get()).toEqual({ version: 1, revision: 1, mode: "none", maskOpacity: 0.2, customImage: null });
    for (const change of [{ expectedRevision: 1, mode: "custom" }, { expectedRevision: 1, maskOpacity: 0.12 },
      { expectedRevision: 1, maskOpacity: 0.65 }, { expectedRevision: 1, maskOpacity: NaN }, { expectedRevision: 1, url: "file:///private" }]) {
      await expect(store.set(change as Parameters<typeof store.set>[0])).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    const confirmed = await store.set({ expectedRevision: 1, maskOpacity: 0.6 });
    expect(confirmed).toMatchObject({ revision: 2, maskOpacity: 0.6 });
    await expect(store.set({ expectedRevision: 1, mode: "none" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(store.get()).toEqual(confirmed);
  });
  it("imports immutable owned bytes, resets while keeping the image, reopens and removes only after confirmation", async () => {
    const { directory, selected, source, store } = await fixture();
    const notifications: number[] = []; store.onChanged(() => { throw new Error("retired observer"); });
    store.onChanged(value => notifications.push(value.revision));
    const imported = await store.importFromSelectedFile(selected, 1); const image = imported.customImage!;
    expect(image).toMatchObject({ width: 30, height: 20 });
    expect(image.url).toBe(`joko-wallpaper://image/${image.id}.webp`);
    const bytes = await store.readImage(image.id);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.id);
    expect(await readFile(selected)).toEqual(source);
    const disk = await readFile(join(directory, "settings.json"), "utf8");
    expect(disk).not.toContain("url"); expect(disk).not.toContain(selected);
    await store.set({ expectedRevision: 2, maskOpacity: 0.5 });
    expect(await store.reset(3)).toMatchObject({ revision: 4, mode: "none", maskOpacity: 0.2, customImage: image });
    const reopened = new DesktopWallpaperStore({ directory });
    expect(await reopened.initialize()).toEqual(store.get());
    await reopened.set({ expectedRevision: 4, mode: "custom" });
    expect(await reopened.remove(5)).toMatchObject({ revision: 6, mode: "none", customImage: null });
    expect(await readdir(join(directory, "images"))).toEqual([]);
    await expect(reopened.readImage(image.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(notifications).toEqual([2, 3, 4]);
  });
  it("preserves the previous image after invalid decode or failed setting publication and collects the orphan only after a later commit", async () => {
    let fail = false;
    const { root, directory, selected, store } = await fixture(async (path, bytes, guard) => {
      if (fail) throw new Error("private disk error"); await writeWallpaperSettings(path, bytes, guard);
    });
    const before = await store.importFromSelectedFile(selected, 1); const id = before.customImage!.id;
    const invalid = join(root, "invalid.png"); await writeFile(invalid, "not an image");
    await expect(store.importFromSelectedFile(invalid, 2)).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    fail = true;
    await expect(store.importFromSelectedFile(await secondImage(root), 2)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(store.get()).toEqual(before); expect((await readdir(join(directory, "images"))).length).toBe(2);
    await expect(store.readImage(id)).resolves.toBeInstanceOf(Uint8Array);
    expect(await new DesktopWallpaperStore({ directory }).initialize()).toEqual(before);
    fail = false; await store.set({ expectedRevision: 2, maskOpacity: 0.3 });
    expect(await readdir(join(directory, "images"))).toEqual([`${id}.webp`]);
  });
  it("serializes writes and checks the queued caller revision after the previous publication", async () => {
    const entered = deferred(), release = deferred();
    const { store } = await fixture(async (path, bytes, guard) => {
      entered.resolve(); await release.promise; await writeWallpaperSettings(path, bytes, guard);
    });
    const first = store.set({ expectedRevision: 1, maskOpacity: 0.3 }); await entered.promise;
    const second = store.set({ expectedRevision: 1, maskOpacity: 0.4 });
    const rejected = expect(second).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    release.resolve(); await first; await rejected;
    expect(store.get()).toMatchObject({ revision: 2, maskOpacity: 0.3 });
  });
  it("rechecks the captured owner immediately before rename and keeps the previous durable image", async () => {
    let hold = false, current = true; const entered = deferred(), release = deferred();
    const { root, directory, selected, store } = await fixture(async (path, bytes, guard) => {
      if (hold) { entered.resolve(); await release.promise; } await writeWallpaperSettings(path, bytes, guard);
    });
    const before = await store.importFromSelectedFile(selected, 1); hold = true;
    const pending = store.importFromSelectedFile(await secondImage(root), 2, () => { if (!current) throw new Error("retired owner"); });
    const failed = expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await entered.promise; current = false; release.resolve(); await failed;
    expect(store.get()).toEqual(before); expect(await new DesktopWallpaperStore({ directory }).initialize()).toEqual(before);
  });
  it("refuses a replaced private directory at the final write boundary", async () => {
    const entered = deferred(), release = deferred();
    const { root, directory, store } = await fixture(async (path, bytes, guard) => {
      entered.resolve(); await release.promise; await writeWallpaperSettings(path, bytes, guard);
    });
    const pending = store.set({ expectedRevision: 1, maskOpacity: 0.3 });
    const failed = expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await entered.promise; await rename(directory, join(root, "retired-wallpaper"));
    await mkdir(join(directory, "images"), { recursive: true }); release.resolve(); await failed;
    expect(store.get()).toMatchObject({ revision: 1, maskOpacity: 0.2 });
    expect(await readdir(directory)).toEqual(["images"]);
  });
  it("adopts a confirmed post-rename record without replaying or collecting during an uncertain error", async () => {
    let postCommitFailure = false;
    const { root, directory, selected, store } = await fixture(async (path, bytes, guard) => {
      await writeWallpaperSettings(path, bytes, guard); if (postCommitFailure) throw new Error("post-rename acknowledgement failed");
    });
    const first = await store.importFromSelectedFile(selected, 1); postCommitFailure = true;
    await expect(store.importFromSelectedFile(await secondImage(root), 2)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const confirmed = store.get(); expect(confirmed.revision).toBe(3); expect(confirmed.customImage!.id).not.toBe(first.customImage!.id);
    expect(await new DesktopWallpaperStore({ directory }).initialize()).toEqual(confirmed);
    expect((await readdir(join(directory, "images"))).length).toBe(2);
    postCommitFailure = false; await store.set({ expectedRevision: 3, maskOpacity: 0.4 });
    expect(await readdir(join(directory, "images"))).toEqual([`${confirmed.customImage!.id}.webp`]);
  });
  it("rejects malformed current-v1 persistence and image dimension or byte drift without replacing the record", async () => {
    const { directory, selected, store } = await fixture();
    const before = await store.importFromSelectedFile(selected, 1);
    const path = join(directory, "settings.json"), original = await readFile(path);
    const record = JSON.parse(original.toString()) as Record<string, unknown>;
    for (const corrupt of [{ ...record, revision: 0 }, { ...record, version: 2 }, { ...record, url: "file:///secret" },
      { ...record, customImage: { ...(record["customImage"] as object), width: 31 } }]) {
      await writeFile(path, JSON.stringify(corrupt), { mode: 0o600 });
      await expect(new DesktopWallpaperStore({ directory }).initialize()).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(corrupt);
    }
    await writeFile(path, original, { mode: 0o600 });
    await writeFile(join(directory, "images", `${before.customImage!.id}.webp`), "changed owned image");
    await expect(store.readImage(before.customImage!.id)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(new DesktopWallpaperStore({ directory }).initialize()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("collects only hash-proven owned WebP leaves and preserves unrelated or mismatched files", async () => {
    const { directory, selected, store } = await fixture();
    await store.importFromSelectedFile(selected, 1);
    const media = join(directory, "images"), other = join(media, "other-file.txt"), mismatch = `${"b".repeat(64)}.webp`;
    await writeFile(other, "other owner"); await writeFile(join(media, mismatch), "not that hash");
    await store.remove(2);
    expect((await readdir(media)).sort()).toEqual([mismatch, "other-file.txt"].sort());
    expect(await readFile(other, "utf8")).toBe("other owner");
  });
});
