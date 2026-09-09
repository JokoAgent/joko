import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_COPY_MAXIMUM_BYTES, FILE_COPY_RETENTION_MS, FILE_COPY_TOTAL_BYTES, NativeFileClipboard, parseDesktopCopyFileRequest, type FileCopyHelperResult } from "../src/native-file-clipboard.js";
import { mkdtemp } from "./test-paths.js";
import * as secureFiles from "../src/secure-files.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); spawn.mockReset(); });
const scope = () => ({ id: randomUUID(), isCurrent: () => true });
const input = (name = "clip's video.mp4") => ({ requestId: randomUUID(), file: { name, mediaType: "video/mp4", bytes: new Uint8Array([1, 2, 3]) } });
const root = () => mkdtemp(join(tmpdir(), "joko-file-clipboard-"));
const manifest = async (directory: string) => JSON.parse(await readFile(join(directory, "files.json"), "utf8")) as { version: number; entries: { id: string; name: string; bytes: number; state: string; pid?: number; retainUntil?: number }[] };

describe("native file clipboard ownership", () => {
  it("writes private immutable bytes, replays an exact request and retains a copied file after renderer retirement", async () => {
    const directory = await root();
    const execute = vi.fn(async (): Promise<FileCopyHelperResult> => ({ status: "copied", dispatched: true, closed: true }));
    const owner = new NativeFileClipboard({ directory, platform: "win32", execute, now: () => 1_000 });
    const request = input(); const caller = scope();
    const pending = owner.copy(request, caller);
    request.file.bytes[0] = 9;
    await expect(pending).resolves.toEqual({ status: "copied" });
    const saved = (await manifest(directory)).entries[0]!;
    expect([...await readFile(join(directory, saved.id, saved.name))]).toEqual([1, 2, 3]);
    expect(saved.retainUntil).toBe(1_000 + FILE_COPY_RETENTION_MS);
    await expect(owner.copy(request, caller)).rejects.toThrow("different content");
    request.file.bytes[0] = 1;
    expect(owner.copy(request, caller)).toBe(pending);
    owner.retireScope(caller.id); owner.dispose();
    expect(await readFile(join(directory, saved.id, saved.name))).toHaveLength(3);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("serializes windows and cancels a queued request without borrowing a replacement scope", async () => {
    const first = deferred<FileCopyHelperResult>();
    const execute = vi.fn((_path: string, _signal: AbortSignal) => first.promise);
    const owner = new NativeFileClipboard({ directory: await root(), platform: "darwin", execute });
    const a = input(); const b = input("second.mp4"); const sa = scope(); const sb = scope();
    const pending = owner.copy(a, sa); const queued = owner.copy(b, sb);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    owner.retireScope(sb.id);
    owner.cancel(a.requestId, sa.id);
    expect(execute.mock.calls[0]?.[1]?.aborted).toBe(true);
    first.resolve({ status: "copied", dispatched: true, closed: true });
    await expect(pending).resolves.toEqual({ status: "copied" });
    await expect(queued).resolves.toEqual({ status: "cancelled" });
    expect(execute).toHaveBeenCalledOnce(); owner.dispose();
  });

  it("bounds an unresponsive helper, preserves unknown files and never lets its late result write or start another helper", async () => {
    const late = deferred<FileCopyHelperResult>();
    const directory = await root(); const execute = vi.fn(() => late.promise);
    const owner = new NativeFileClipboard({ directory, platform: "win32", execute, timeoutMs: 40, now: () => 5_000 });
    const caller = scope(); const request = input();
    const result = await owner.copy(request, caller);
    expect(result).toEqual({ status: "unknown" });
    const before = await readFile(join(directory, "files.json"), "utf8");
    expect((await manifest(directory)).entries[0]).toMatchObject({ state: "dispatched" });
    expect((await manifest(directory)).entries[0]?.retainUntil).toBeUndefined();
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "blocked" });
    await expect(owner.copy(request, caller)).resolves.toEqual({ status: "unknown" });
    owner.dispose(); late.resolve({ status: "copied", dispatched: true, closed: true });
    await Promise.resolve(); await Promise.resolve();
    expect(await readFile(join(directory, "files.json"), "utf8")).toBe(before);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("cleans a known pre-dispatch failure immediately and permits an explicit new attempt", async () => {
    const directory = await root();
    const execute = vi.fn().mockResolvedValueOnce({ status: "failed", dispatched: false, closed: true }).mockResolvedValueOnce({ status: "copied", dispatched: true, closed: true });
    const owner = new NativeFileClipboard({ directory, platform: "win32", execute });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "failed", reason: "helper" });
    expect((await manifest(directory)).entries).toEqual([]);
    expect(await readdir(directory)).toEqual(["files.json"]);
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "copied" }); owner.dispose();
  });

  it("recovers dispatch reservations and only deletes exact listed prepared or expired files", async () => {
    const directory = await root(); const now = 1_000;
    const entries = [
      { id: randomUUID(), name: "prepared.mp4", bytes: 3, state: "prepared" },
      { id: randomUUID(), name: "expired.mp4", bytes: 3, state: "retained", retainUntil: 999 },
      { id: randomUUID(), name: "unknown.mp4", bytes: 3, state: "dispatched", pid: 4242 },
      { id: randomUUID(), name: "retained.mp4", bytes: 3, state: "retained", retainUntil: 2_000 }
    ];
    for (const entry of entries) { await mkdir(join(directory, entry.id)); await writeFile(join(directory, entry.id, entry.name), new Uint8Array([1, 2, 3])); }
    await writeFile(join(directory, "unlisted.txt"), "never discover or delete");
    await writeFile(join(directory, "files.json"), JSON.stringify({ version: 1, entries }));
    const owner = new NativeFileClipboard({ directory, platform: "win32", now: () => now, processExists: () => false, execute: async () => ({ status: "copied", dispatched: true, closed: true }) });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "copied" });
    const restored = await manifest(directory);
    expect(restored.entries).toHaveLength(3);
    expect(restored.entries.find((entry) => entry.name === "unknown.mp4")?.retainUntil).toBe(now + FILE_COPY_RETENTION_MS);
    expect(await readFile(join(directory, "unlisted.txt"), "utf8")).toBe("never discover or delete");
    expect(await readdir(directory)).not.toContain(entries[0]!.id);
    expect(await readdir(directory)).not.toContain(entries[1]!.id); owner.dispose();
  });

  it.each(["bytes", "count"] as const)("rejects full %s capacity before dispatch without evicting retained files", async (limit) => {
    const directory = await root(); const execute = vi.fn();
    const count = limit === "bytes" ? 2 : 32;
    const entries = Array.from({ length: count }, () => ({ id: randomUUID(), name: "retained.mp4", bytes: limit === "bytes" ? FILE_COPY_MAXIMUM_BYTES : 1, state: "retained", retainUntil: FILE_COPY_RETENTION_MS }));
    expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(FILE_COPY_TOTAL_BYTES);
    await writeFile(join(directory, "files.json"), JSON.stringify({ version: 1, entries }));
    const owner = new NativeFileClipboard({ directory, platform: "win32", execute, now: () => 100 });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "failed", reason: "capacity" });
    expect((await manifest(directory)).entries).toHaveLength(count);
    expect(execute).not.toHaveBeenCalled(); owner.dispose();
  });

  it("rejects unsafe names and manifest paths and does not offer unsupported file clipboard semantics", async () => {
    for (const name of ["../outside.mp4", "CON.mp4", "clip.mp4:stream", "trailing.", "bad\\leaf.mp4"]) expect(() => parseDesktopCopyFileRequest(input(name))).toThrow();
    expect(() => parseDesktopCopyFileRequest({ ...input(), path: "outside.mp4" })).toThrow();
    const oversized = input(); Object.defineProperty(oversized.file.bytes, "byteLength", { value: FILE_COPY_MAXIMUM_BYTES + 1 });
    expect(() => parseDesktopCopyFileRequest(oversized)).toThrow();
    const directory = await root();
    await writeFile(join(directory, "files.json"), JSON.stringify({ version: 1, entries: [{ id: "../outside", name: "file.mp4", bytes: 3, state: "prepared" }] }));
    const execute = vi.fn(); const owner = new NativeFileClipboard({ directory, platform: "win32", execute });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "failed", reason: "storage" });
    const linux = new NativeFileClipboard({ directory, platform: "linux", execute });
    await expect(linux.copy(input(), scope())).resolves.toEqual({ status: "unavailable" });
    expect(execute).not.toHaveBeenCalled(); owner.dispose(); linux.dispose();
  });

  it.each(["win32", "darwin"] as const)("passes the %s file path as an independent argument to a fixed OS script", async (platform) => {
    vi.stubEnv("SystemRoot", process.env.SystemRoot ?? tmpdir());
    spawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { kill(): boolean };
      Object.assign(child, { pid: 4242 });
      child.kill = vi.fn(() => true);
      queueMicrotask(() => { child.emit("spawn"); child.emit("close", 0); });
      return child;
    });
    const directory = await root(); const owner = new NativeFileClipboard({ directory, platform });
    await expect(owner.copy(input("name's $(not-code).mp4"), scope())).resolves.toEqual({ status: "copied" });
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(options).toMatchObject({ windowsHide: true, stdio: "ignore" });
    expect(args.at(-1)).toBe(join(directory, (await manifest(directory)).entries[0]!.id, "name's $(not-code).mp4"));
    expect((await manifest(directory)).entries[0]).toMatchObject({ pid: 4242, state: "retained" });
    expect(args).not.toContain("-Command");
    expect(command).toBe(platform === "darwin" ? "/usr/bin/osascript" : join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    const script = await readFile(join(directory, platform === "win32" ? "copy-file.ps1" : "copy-file.applescript"), "utf8");
    expect(script).not.toContain("not-code"); expect(script).toContain(platform === "win32" ? "Set-Clipboard -LiteralPath $LiteralPath" : "item 1 of argv"); owner.dispose();
  });

  it.each(["before", "after"] as const)("does not release the OS writer on a process error %s the spawn event without confirmed close", async (phase) => {
    const child = new EventEmitter() as EventEmitter & { kill(): boolean };
    Object.assign(child, { pid: 4242 });
    child.kill = vi.fn(() => { child.emit("error", new Error("Termination was not confirmed")); return false; });
    spawn.mockImplementation(() => { queueMicrotask(() => { if (phase === "after") child.emit("spawn"); child.emit("error", new Error("Native helper process error")); }); return child; });
    const directory = await root(); let now = 1_000;
    const owner = new NativeFileClipboard({ directory, platform: "darwin", timeoutMs: 40, now: () => now });
    const request = input(); const caller = scope();
    await expect(owner.copy(request, caller)).resolves.toEqual({ status: "unknown" });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "blocked" });
    expect(spawn).toHaveBeenCalledOnce(); expect(child.kill).toHaveBeenCalledOnce();
    expect((await manifest(directory)).entries[0]?.retainUntil).toBeUndefined();
    now = 5_000; child.emit("close", 0);
    await vi.waitFor(async () => expect((await manifest(directory)).entries[0]).toMatchObject({ state: "retained", retainUntil: now + FILE_COPY_RETENTION_MS }));
    await expect(owner.copy(request, caller)).resolves.toEqual({ status: "unknown" });
    expect(spawn).toHaveBeenCalledOnce();
    spawn.mockImplementation(() => { const next = new EventEmitter(); Object.assign(next, { kill: vi.fn() }); queueMicrotask(() => { next.emit("spawn"); next.emit("close", 0); }); return next; });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "copied" }); owner.dispose();
  });

  it("waits for a failing PID write before committing early native close, so no late record can restore dispatched state", async () => {
    const directory = await root(); const gate = deferred<void>(); let reached = false;
    const write = secureFiles.atomicWritePrivateFile;
    vi.spyOn(secureFiles, "atomicWritePrivateFile").mockImplementation(async (path, bytes) => {
      if (path.endsWith("files.json")) {
        const entry = JSON.parse(Buffer.from(bytes).toString("utf8")).entries[0];
        if (entry?.state === "dispatched" && entry.pid === 4242) { reached = true; await gate.promise; throw new Error("PID persistence unavailable"); }
      }
      await write(path, bytes);
    });
    spawn.mockImplementation(() => { const child = new EventEmitter(); Object.assign(child, { pid: 4242, kill: vi.fn() }); queueMicrotask(() => { child.emit("spawn"); child.emit("close", 0); }); return child; });
    const owner = new NativeFileClipboard({ directory, platform: "darwin" });
    let settled = false; const pending = owner.copy(input(), scope()).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(reached).toBe(true));
    expect(settled).toBe(false); expect((await manifest(directory)).entries[0]).toMatchObject({ state: "dispatched" });
    gate.resolve(); await expect(pending).resolves.toEqual({ status: "copied" });
    expect((await manifest(directory)).entries[0]).toMatchObject({ state: "retained", pid: 4242 }); owner.dispose();
  });

  it.each(["present", "unknown", "missing"] as const)("keeps an unconfirmed %s process reservation across restart and begins retention only after proven absence", async (proof) => {
    const directory = await root(); const id = randomUUID();
    await mkdir(join(directory, id)); await writeFile(join(directory, id, "held.mp4"), new Uint8Array([1, 2, 3]));
    const entry = { id, name: "held.mp4", bytes: 3, state: "dispatched", ...(proof === "missing" ? {} : { pid: 4242 }) };
    await writeFile(join(directory, "files.json"), JSON.stringify({ version: 1, entries: [entry] }));
    const execute = vi.fn(async (): Promise<FileCopyHelperResult> => ({ status: "copied", dispatched: true, closed: true }));
    const probe = vi.fn(() => proof === "present" ? true : "unknown" as const);
    const now = FILE_COPY_RETENTION_MS * 3;
    const owner = new NativeFileClipboard({ directory, platform: "win32", execute, processExists: probe, now: () => now });
    await expect(owner.copy(input(), scope())).resolves.toEqual({ status: "blocked" });
    expect((await manifest(directory)).entries).toEqual([entry]); expect(execute).not.toHaveBeenCalled();
    expect(await readFile(join(directory, id, "held.mp4"))).toHaveLength(3); owner.dispose();
    const recovered = new NativeFileClipboard({ directory, platform: "win32", execute, processExists: () => false, now: () => now + 1 });
    await expect(recovered.copy(input(), scope())).resolves.toEqual({ status: proof === "missing" ? "blocked" : "copied" });
    if (proof !== "missing") expect((await manifest(directory)).entries.find((value) => value.id === id)).toMatchObject({ state: "retained", retainUntil: now + 1 + FILE_COPY_RETENTION_MS });
    else expect(probe).not.toHaveBeenCalled();
    recovered.dispose();
  });
});

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((accept) => { resolve = accept; }); return { promise, resolve }; }
