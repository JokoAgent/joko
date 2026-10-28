import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionDirectoryPicker } from "./extension-directory-picker.js";
import { ExtensionFileDeposits } from "./extension-cards/files.js";
import type { ExtensionCardScope } from "./extension-cards/service.js";
import type { ExtensionMainViewSurface } from "./extension-main-view-manager.js";

const surface = { id: "original-settings", extensionId: "plugin", authority: { settings: { html: "settings.html" } } } as ExtensionMainViewSurface;
const scope: ExtensionCardScope = { extensionId: "plugin", authorityKey: "installation", sessionId: "real-task", sessionCreatedAt: 1, targetId: "real-workspace", toolUseId: null };
async function fixture(run: (f: { root: string; picker: ExtensionDirectoryPicker; files: ExtensionFileDeposits; retire(): void; advance(ms: number): void }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "joko-native-directory-")); let live = true, now = Date.now();
  const files = new ExtensionFileDeposits(() => now), current = () => { if (!live) throw new Error("Original installation retired"); };
  const picker = new ExtensionDirectoryPicker({ roots: () => [root], now: () => now, runtime: {
    captureDirectorySelection: () => { current(); return { authorityKey: "installation", assertCurrent: current }; },
    preparePickedDirectory: input => files.preparePickedDirectory({ ...input, assertCurrent: current })
  } });
  try { await run({ root, picker, files, retire: () => { live = false; }, advance: ms => { now += ms; } }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("native author settings directory selection", () => {
  it("issues only a real original installation read deposit after an opaque native selection", async () => fixture(async f => {
    const selected = path.join(f.root, "chosen"); await mkdir(selected); await writeFile(path.join(selected, "read.txt"), "actual bytes");
    await writeFile(path.join(selected, ".env"), "private-secret");
    const opened = await f.picker.open(surface, "connection", () => {});
    const page = await f.picker.browse(opened.picker.pickerId, "connection", { directoryPath: selected });
    const receipt = await f.picker.pick(opened.picker.pickerId, page.directory!.entryId, "plugin", "connection", () => {});
    expect(receipt).toMatchObject({ fileCount: 1, totalBytes: 12, relativePaths: ["read.txt"] });
    expect(JSON.stringify(receipt)).not.toContain(selected); expect(JSON.stringify(receipt)).not.toContain("private-secret");
    expect(f.files.take({ ...scope, extensionId: "other" }, receipt.token)).toBeUndefined();
    expect(f.files.take({ ...scope, authorityKey: "replacement" }, receipt.token)).toBeUndefined();
    const transfer = f.files.take(scope, receipt.token)!;
    expect(Buffer.from(await transfer.files[0]!.read()).toString()).toBe("actual bytes");
    expect(f.files.take(scope, receipt.token)).toBeUndefined();
    expect(await f.files.write(scope, receipt.token, "write.txt", Buffer.from("forbidden"), () => {})).toBeUndefined();
  }));

  it("requires the original connection, picker, plugin and native entry instead of a path-shaped selection", async () => fixture(async f => {
    await writeFile(path.join(f.root, "read.txt"), "read");
    const opened = await f.picker.open(surface, "connection", () => {}), id = opened.picker.pickerId;
    const page = await f.picker.browse(id, "connection", { directoryPath: f.root });
    await expect(f.picker.browse(id, "other", { directoryPath: f.root })).rejects.toThrow("unavailable");
    await expect(f.picker.pick(id, f.root, "plugin", "connection", () => {})).rejects.toThrow("current native picker");
    await expect(f.picker.pick(id, page.directory!.entryId, "other", "connection", () => {})).rejects.toThrow("current native picker");
    expect(f.picker.close(id, "other")).toBe(false);
    expect(f.picker.close(id, "connection")).toBe(true);
    await expect(f.picker.pick(id, page.directory!.entryId, "plugin", "connection", () => {})).rejects.toThrow("unavailable");
  }));

  it("bounds a single native picker and sliding attempt rate, then retires an expired or changed owner", async () => fixture(async f => {
    const first = await f.picker.open(surface, "connection", () => {});
    await expect(f.picker.open({ ...surface, extensionId: "other" }, "second", () => {})).rejects.toThrow("already open");
    f.picker.close(first.picker.pickerId, "connection");
    f.advance(2_000); await expect(f.picker.open(surface, "connection", () => {})).rejects.toThrow("three seconds");
    f.advance(2_000); await expect(f.picker.open(surface, "connection", () => {})).rejects.toThrow("three seconds");
    f.advance(3_001); const next = await f.picker.open(surface, "connection", () => {});
    f.advance(120_001); await expect(f.picker.browse(next.picker.pickerId, "connection", { directoryPath: f.root })).rejects.toThrow("expired");
    f.retire(); await expect(f.picker.open(surface, "connection", () => {})).rejects.toThrow("retired");
  }));

  it("keeps paged entries complete and rejects a changed directory before adopting the next page", async () => fixture(async f => {
    for (let i = 0; i < 105; i++) await mkdir(path.join(f.root, `directory-${i.toString().padStart(3, "0")}`));
    const opened = await f.picker.open(surface, "connection", () => {}), id = opened.picker.pickerId;
    const first = await f.picker.browse(id, "connection", { directoryPath: f.root });
    expect(first.entries).toHaveLength(100); expect(first.nextPageToken).not.toBe("");
    const next = await f.picker.browse(id, "connection", { entryId: first.directory!.entryId, pageToken: first.nextPageToken });
    expect(next.entries).toHaveLength(5); expect(new Set([...first.entries, ...next.entries].map(value => value.entryId)).size).toBe(105);
    await mkdir(path.join(f.root, "later-directory"));
    await expect(f.picker.browse(id, "connection", { entryId: first.directory!.entryId, pageToken: first.nextPageToken })).rejects.toThrow("contents changed");
  }));

  it("rejects replacement of the actual selected directory and retires accepted byte reads on installation changes", async () => fixture(async f => {
    const selected = path.join(f.root, "selected"); await mkdir(selected); await writeFile(path.join(selected, "read.txt"), "original");
    const opened = await f.picker.open(surface, "connection", () => {}), id = opened.picker.pickerId;
    const page = await f.picker.browse(id, "connection", { directoryPath: selected });
    await rename(selected, path.join(f.root, "original")); await mkdir(selected); await writeFile(path.join(selected, "read.txt"), "replacement");
    await expect(f.picker.pick(id, page.directory!.entryId, "plugin", "connection", () => {})).rejects.toThrow("changed");
    f.advance(3_001); const next = await f.picker.open(surface, "connection", () => {});
    const current = await f.picker.browse(next.picker.pickerId, "connection", { directoryPath: selected });
    const receipt = await f.picker.pick(next.picker.pickerId, current.directory!.entryId, "plugin", "connection", () => {});
    const transfer = f.files.take(scope, receipt.token)!; f.retire();
    await expect(transfer.files[0]!.read()).rejects.toThrow("retired");
  }));
});
