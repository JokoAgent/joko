import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExtensionDirectoryPicker } from "./extension-directory-picker.js";
import { ExtensionFileDeposits } from "./extension-cards/files.js";
import { ExtensionNetwork, type ExtensionNetworkScope } from "./extension-cards/network.js";
import { parseExtensionNetwork } from "./extension-cards/network-manifest.js";
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
  it.each(["cancel", "deadline"])("settles the original choice while its directory collector is still pending: %s", async reason => fixture(async f => {
    type Receipt = Awaited<ReturnType<ExtensionFileDeposits["preparePickedDirectory"]>>;
    type Input = Parameters<ExtensionFileDeposits["preparePickedDirectory"]>[0];
    let release!: (value: Receipt) => void, captured: Input | undefined;
    const prepare = vi.fn((input: Omit<Input, "assertCurrent">) => { captured = { ...input, assertCurrent: () => {} }; return new Promise<Receipt>(resolve => { release = resolve; }); });
    const picker = new ExtensionDirectoryPicker({ roots: () => [f.root], runtime: {
      captureDirectorySelection: () => ({ authorityKey: "installation", assertCurrent: () => {} }), preparePickedDirectory: prepare
    } });
    const opened = await picker.open(surface, "connection", () => {}), id = opened.picker.pickerId;
    const page = await picker.browse(id, "connection", { directoryPath: f.root });
    try {
      if (reason === "deadline") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const selecting = picker.pick(id, page.directory!.entryId, "plugin", "connection", () => {});
      const failed = expect(selecting).rejects.toThrow(reason === "cancel" ? "closed" : "timed out");
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      if (reason === "cancel") expect(picker.close(id, "connection")).toBe(true);
      else await vi.advanceTimersByTimeAsync(120_000);
      await failed; expect(captured?.signal?.aborted).toBe(true);
      expect(() => captured!.assertSelectionCurrent!()).toThrow("closed");
      release({ token: "late-unadopted", fileCount: 1, totalBytes: 4, relativePaths: ["report.txt"], expiresAt: Date.now() + 600_000 });
      await Promise.resolve(); expect(picker.close(id, "connection")).toBe(false);
    } finally { vi.useRealTimers(); }
  }));
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

  it("uses the original network upload once and never turns a picked receipt into SideChat or replacement-directory authority", async () => fixture(async f => {
    const selected = path.join(f.root, "selected"); await mkdir(selected); await writeFile(path.join(selected, "read.txt"), "actual report");
    const opened = await f.picker.open(surface, "connection", () => {});
    const page = await f.picker.browse(opened.picker.pickerId, "connection", { directoryPath: selected });
    const receipt = await f.picker.pick(opened.picker.pickerId, page.directory!.entryId, "plugin", "connection", () => {});
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("accepted"));
    const network = new ExtensionNetwork({ files: f.files, fetch, redact: value => value, resolveCredential: () => "" });
    const networkScope: ExtensionNetworkScope = { ...scope, task: scope, readOnly: false, signal: new AbortController().signal,
      declaration: parseExtensionNetwork({ hosts: ["files.example.test"] }), assertCurrent: () => {} };
    const request = { url: "https://files.example.test/upload", method: "POST", uploadDir: { token: receipt.token } };
    expect(await network.request({ ...networkScope, readOnly: true }, request)).toMatchObject({ ok: false }); expect(fetch).not.toHaveBeenCalled();
    expect(await network.request(networkScope, request)).toMatchObject({ ok: true }); expect(fetch).toHaveBeenCalledOnce();
    expect(Buffer.from(fetch.mock.calls[0]![1]!.body as ArrayBuffer).toString()).toContain("actual report");
    expect(await network.request(networkScope, request)).toMatchObject({ ok: false }); expect(fetch).toHaveBeenCalledOnce();
    f.advance(3_001); const next = await f.picker.open(surface, "connection", () => {});
    const nextPage = await f.picker.browse(next.picker.pickerId, "connection", { directoryPath: selected });
    const replaced = await f.picker.pick(next.picker.pickerId, nextPage.directory!.entryId, "plugin", "connection", () => {});
    await rename(selected, path.join(f.root, "old-selected")); await mkdir(selected); await writeFile(path.join(selected, "read.txt"), "replacement");
    expect(await network.request(networkScope, { ...request, uploadDir: { token: replaced.token } })).toMatchObject({ ok: false });
    expect(fetch).toHaveBeenCalledOnce();
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
