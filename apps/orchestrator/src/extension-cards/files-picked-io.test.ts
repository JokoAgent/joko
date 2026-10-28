import type { Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionFileDeposits } from "./files.js";
import { ExtensionNetwork, type ExtensionNetworkScope } from "./network.js";
import { parseExtensionNetwork } from "./network-manifest.js";
import type { ExtensionCardScope } from "./service.js";

const controlled = vi.hoisted(() => ({ io: undefined as undefined | ((name: string, args: unknown[]) => Promise<unknown> | undefined) }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const forward = (name: string, implementation: Function) => (...args: unknown[]) => controlled.io?.(name, args) ?? Reflect.apply(implementation, undefined, args);
  return { ...actual, realpath: forward("realpath", actual.realpath), opendir: forward("opendir", actual.opendir),
    open: forward("open", actual.open), lstat: forward("lstat", actual.lstat), stat: forward("stat", actual.stat) };
});
afterEach(() => { controlled.io = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

const scope: ExtensionCardScope = { extensionId: "plugin", authorityKey: "installation", sessionId: "task", sessionCreatedAt: 1, targetId: "workspace", toolUseId: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve };
}
async function drain() { for (let index = 0; index < 16; index++) await Promise.resolve(); }
async function fixture() {
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "joko-picked-io-"))), file = path.join(root, "report.txt");
  await fs.writeFile(file, "original report"); const original = await fs.lstat(root), files = new ExtensionFileDeposits();
  const closers: Array<() => Promise<void>> = []; let proof: undefined | (() => Promise<void>);
  const prepare = (signal?: AbortSignal) => files.preparePickedDirectory({ extensionId: "plugin", authorityKey: "installation", selectionId: "original-selection",
    directory: root, signal, assertCurrent: () => {}, assertSelectionCurrent: () => signal?.throwIfAborted(), assertDirectoryCurrent: async () => {
      if (proof) return proof();
      const actual = await fs.lstat(root);
      if (!actual.isDirectory() || actual.dev !== original.dev || actual.ino !== original.ino) throw new Error("Original directory changed");
    } });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("accepted"));
  const network = new ExtensionNetwork({ files, fetch, redact: value => value, resolveCredential: () => "" });
  const request = (token: string, signal: AbortSignal) => {
    const owner: ExtensionNetworkScope = { ...scope, task: scope, readOnly: false, signal, declaration: parseExtensionNetwork({ hosts: ["files.example.test"] }), assertCurrent: () => {} };
    return network.request(owner, { url: "https://files.example.test/upload", method: "POST", uploadDir: { token } });
  };
  return { fs, root, file, files, fetch, prepare, request, blockProof: (work: () => Promise<void>) => { proof = work; },
    hold: <T extends { close(): Promise<void> }>(handle: T): T => { const close = handle.close.bind(handle); closers.push(() => close().catch(() => undefined)); return handle; },
    close: async () => { controlled.io = undefined; vi.useRealTimers(); for (const close of closers) await close(); await fs.rm(root, { recursive: true, force: true }); } };
}

it.each(["cancel", "timeout"])("retires a picked collection after %s and closes only its late original directory handle", async reason => {
  const f = await fixture(), abort = new AbortController(), late = deferred<Dir>(), entered = deferred<void>();
  const handle = f.hold(await f.fs.opendir(f.root)), close = vi.spyOn(handle, "close");
  if (reason === "timeout") vi.useFakeTimers();
  try {
    controlled.io = (name, args) => name === "opendir" && args[0] === f.root ? (entered.resolve(), late.promise) : undefined;
    const preparing = f.prepare(abort.signal), failed = expect(preparing).rejects.toThrow(/cancelled|timed out/u);
    await entered.promise;
    if (reason === "cancel") abort.abort(); else await vi.advanceTimersByTimeAsync(10_001);
    await failed; expect(close).not.toHaveBeenCalled();
    late.resolve(handle); await drain(); expect(close).toHaveBeenCalledOnce(); await close.mock.results[0]!.value;
    controlled.io = undefined;
    const next = await f.prepare(); expect(next.relativePaths).toEqual(["report.txt"]);
    expect(Buffer.from(await f.files.take(scope, next.token)!.files[0]!.read()).toString()).toBe("original report");
  } finally { late.resolve(handle); await f.close(); }
});

it("cancels a pending directory read without issuing a receipt and does not resume collection when that read settles late", async () => {
  const f = await fixture(), abort = new AbortController(), pending = deferred<null>(), entered = deferred<void>();
  const handle = f.hold(await f.fs.opendir(f.root)), close = vi.spyOn(handle, "close");
  vi.spyOn(handle, "read").mockImplementationOnce(() => { entered.resolve(); return pending.promise as never; });
  try {
    controlled.io = (name, args) => name === "opendir" && args[0] === f.root ? Promise.resolve(handle) : undefined;
    const preparing = f.prepare(abort.signal), failed = expect(preparing).rejects.toThrow("cancelled");
    await entered.promise; abort.abort(); await failed;
    expect(close).toHaveBeenCalledOnce(); pending.resolve(null); await drain(); expect(close).toHaveBeenCalledOnce();
    controlled.io = undefined; expect((await f.prepare()).relativePaths).toEqual(["report.txt"]);
  } finally { pending.resolve(null); await f.close(); }
});

it("keeps an accepted deposit usable after its chooser closes and retains one original token consumption", async () => {
  const f = await fixture(), chooser = new AbortController();
  try {
    const receipt = await f.prepare(chooser.signal); chooser.abort();
    await expect(f.request(receipt.token, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(Buffer.from(f.fetch.mock.calls[0]![1]!.body as ArrayBuffer).toString()).toContain("original report");
    await expect(f.request(receipt.token, new AbortController().signal)).resolves.toMatchObject({ ok: false }); expect(f.fetch).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});

it("uploads a complete larger picked file within the original network deadline and byte budget", async () => {
  const f = await fixture(), bytes = Buffer.alloc(700 * 1024, 0xab);
  try {
    await f.fs.writeFile(f.file, bytes); const receipt = await f.prepare();
    expect(receipt.totalBytes).toBe(bytes.byteLength);
    await expect(f.request(receipt.token, new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(f.fetch).toHaveBeenCalledOnce(); expect(Buffer.from(f.fetch.mock.calls[0]![1]!.body as ArrayBuffer).includes(bytes)).toBe(true);
  } finally { await f.close(); }
});

it.each(["cancel", "timeout"])("returns an original network upload after %s before a pending file open resolves, then closes that exact late handle", async reason => {
  const f = await fixture(), abort = new AbortController(), late = deferred<FileHandle>(), entered = deferred<void>();
  const handle = f.hold(await f.fs.open(f.file, "r")), close = vi.spyOn(handle, "close");
  try {
    const receipt = await f.prepare(); if (reason === "timeout") vi.useFakeTimers();
    controlled.io = (name, args) => name === "open" && args[0] === f.file ? (entered.resolve(), late.promise) : undefined;
    const sending = f.request(receipt.token, abort.signal); await entered.promise;
    if (reason === "cancel") abort.abort(); else await vi.advanceTimersByTimeAsync(10_001);
    await expect(sending).resolves.toMatchObject({ ok: false }); expect(f.fetch).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    late.resolve(handle); await drain(); expect(close).toHaveBeenCalledOnce(); await close.mock.results[0]!.value;
    await expect(f.request(receipt.token, new AbortController().signal)).resolves.toMatchObject({ ok: false }); expect(f.fetch).not.toHaveBeenCalled();
  } finally { late.resolve(handle); await f.close(); }
});

it("cancels a pending read on its original handle and never sends its late bytes or retries the consumed receipt", async () => {
  const f = await fixture(), abort = new AbortController(), pending = deferred<{ bytesRead: number }>(), entered = deferred<void>();
  const handle = f.hold(await f.fs.open(f.file, "r")), close = vi.spyOn(handle, "close");
  vi.spyOn(handle, "read").mockImplementationOnce(() => { entered.resolve(); return pending.promise as never; });
  try {
    const receipt = await f.prepare(); controlled.io = (name, args) => name === "open" && args[0] === f.file ? Promise.resolve(handle) : undefined;
    const sending = f.request(receipt.token, abort.signal); await entered.promise; abort.abort();
    await expect(sending).resolves.toMatchObject({ ok: false }); expect(close).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
    pending.resolve({ bytesRead: 1 }); await drain(); expect(close).toHaveBeenCalledOnce();
    await expect(f.request(receipt.token, new AbortController().signal)).resolves.toMatchObject({ ok: false }); expect(f.fetch).not.toHaveBeenCalled();
  } finally { pending.resolve({ bytesRead: 0 }); await f.close(); }
});

it("does not wait for a hung original identity proof after its network owner cancels", async () => {
  const f = await fixture(), abort = new AbortController(), pending = deferred<void>(), entered = deferred<void>();
  try {
    const receipt = await f.prepare(); f.blockProof(() => { entered.resolve(); return pending.promise; });
    const sending = f.request(receipt.token, abort.signal); await entered.promise; abort.abort();
    await expect(sending).resolves.toMatchObject({ ok: false }); expect(f.fetch).not.toHaveBeenCalled();
    pending.resolve(); await drain(); expect(f.fetch).not.toHaveBeenCalled();
  } finally { pending.resolve(); await f.close(); }
});

it("bounds cleanup waiting while retaining the same original close until it finishes", async () => {
  const f = await fixture(), gate = deferred<void>(), entered = deferred<void>();
  const handle = f.hold(await f.fs.open(f.file, "r")), originalClose = handle.close.bind(handle);
  const close = vi.spyOn(handle, "close").mockImplementationOnce(async () => { entered.resolve(); await gate.promise; await originalClose(); });
  try {
    const receipt = await f.prepare(); controlled.io = (name, args) => name === "open" && args[0] === f.file ? Promise.resolve(handle) : undefined;
    vi.useFakeTimers(); const sending = f.request(receipt.token, new AbortController().signal); await entered.promise;
    expect(f.fetch).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1_001);
    await expect(sending).resolves.toMatchObject({ ok: true }); expect(close).toHaveBeenCalledOnce(); expect(f.fetch).toHaveBeenCalledOnce();
    gate.resolve(); await close.mock.results[0]!.value; expect(close).toHaveBeenCalledOnce();
  } finally { gate.resolve(); await f.close(); }
});
