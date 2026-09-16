import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FILE_OPEN_MAXIMUM_BYTES,
  FILE_OPEN_RETENTION_MS,
  FILE_OPEN_TOTAL_BYTES,
  NativeFileOpener,
  parseDesktopOpenFileRequest
} from "../src/native-file-opener.js";
import { mkdtemp } from "./test-paths.js";

afterEach(() => vi.restoreAllMocks());

const scope = () => ({ id: randomUUID(), isCurrent: () => true });
const input = (name = "clip's video.mp4") => ({
  requestId: randomUUID(),
  file: { name, mediaType: "video/mp4", bytes: new Uint8Array([1, 2, 3]) }
});
const root = () => mkdtemp(join(tmpdir(), "joko-file-opener-"));
const manifest = async (directory: string) => JSON.parse(await readFile(join(directory, "files.json"), "utf8")) as {
  version: number;
  entries: { id: string; name: string; bytes: number; state: string; retainUntil?: number }[];
};

describe("native file open ownership", () => {
  it("materializes private immutable bytes, replays the exact request and retains a successful dispatch", async () => {
    const directory = await root();
    const openPath = vi.fn(async () => "");
    const owner = new NativeFileOpener({ directory, openPath, now: () => 1_000 });
    const request = input();
    const caller = scope();
    const pending = owner.open(request, caller);
    request.file.bytes[0] = 9;
    await expect(pending).resolves.toEqual({ status: "opened" });
    const saved = (await manifest(directory)).entries[0]!;
    const path = join(directory, saved.id, saved.name);
    expect([...await readFile(path)]).toEqual([1, 2, 3]);
    expect(saved).toMatchObject({ state: "retained", retainUntil: 1_000 + FILE_OPEN_RETENTION_MS });
    expect(openPath).toHaveBeenCalledExactlyOnceWith(path);
    await expect(owner.open(request, caller)).rejects.toThrow("different content");
    request.file.bytes[0] = 1;
    expect(owner.open(request, caller)).toBe(pending);
    owner.retireScope(caller.id);
    owner.dispose();
    expect(await readFile(path)).toHaveLength(3);
  });

  it("serializes dispatch and cancels a queued request without borrowing another renderer scope", async () => {
    const first = deferred<string>();
    const openPath = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue("");
    const owner = new NativeFileOpener({ directory: await root(), openPath });
    const firstRequest = input();
    const secondRequest = input("second.mp4");
    const firstScope = scope();
    const secondScope = scope();
    const pending = owner.open(firstRequest, firstScope);
    const queued = owner.open(secondRequest, secondScope);
    await vi.waitFor(() => expect(openPath).toHaveBeenCalledOnce());
    owner.retireScope(secondScope.id);
    owner.cancel(firstRequest.requestId, firstScope.id);
    first.resolve("");
    await expect(pending).resolves.toEqual({ status: "opened" });
    await expect(queued).resolves.toEqual({ status: "cancelled" });
    expect(openPath).toHaveBeenCalledOnce();
    owner.dispose();
  });

  it("releases an explicit OS failure but retains an uncertain post-dispatch result", async () => {
    const directory = await root();
    const openPath = vi.fn().mockResolvedValueOnce("No associated application").mockRejectedValueOnce(new Error("IPC lost"));
    const owner = new NativeFileOpener({ directory, openPath, now: () => 5_000 });
    await expect(owner.open(input(), scope())).resolves.toEqual({ status: "failed", reason: "open" });
    expect((await manifest(directory)).entries).toEqual([]);
    expect(await readdir(directory)).toEqual(["files.json"]);
    await expect(owner.open(input("unknown.mp4"), scope())).resolves.toEqual({ status: "unknown" });
    expect((await manifest(directory)).entries[0]).toMatchObject({
      name: "unknown.mp4",
      state: "retained",
      retainUntil: 5_000 + FILE_OPEN_RETENTION_MS
    });
    owner.dispose();
  });

  it("recovers by deleting only exact prepared or expired entries and never discovers unlisted paths", async () => {
    const directory = await root();
    const entries = [
      { id: randomUUID(), name: "prepared.mp4", bytes: 3, state: "prepared" },
      { id: randomUUID(), name: "expired.mp4", bytes: 3, state: "retained", retainUntil: 999 },
      { id: randomUUID(), name: "retained.mp4", bytes: 3, state: "retained", retainUntil: 2_000 }
    ];
    for (const entry of entries) {
      await mkdir(join(directory, entry.id));
      await writeFile(join(directory, entry.id, entry.name), new Uint8Array([1, 2, 3]));
    }
    await writeFile(join(directory, "unlisted.txt"), "never discover or delete");
    await writeFile(join(directory, "files.json"), JSON.stringify({ version: 1, entries }));
    const owner = new NativeFileOpener({ directory, openPath: async () => "", now: () => 1_000 });
    await expect(owner.open(input(), scope())).resolves.toEqual({ status: "opened" });
    const restored = await manifest(directory);
    expect(restored.entries.some((entry) => entry.name === "retained.mp4")).toBe(true);
    expect(await readdir(directory)).not.toContain(entries[0]!.id);
    expect(await readdir(directory)).not.toContain(entries[1]!.id);
    expect(await readFile(join(directory, "unlisted.txt"), "utf8")).toBe("never discover or delete");
    owner.dispose();
  });

  it.each(["bytes", "count"] as const)("rejects full %s capacity without evicting retained files", async (limit) => {
    const directory = await root();
    const count = limit === "bytes" ? 2 : 32;
    const entries = Array.from({ length: count }, () => ({
      id: randomUUID(),
      name: "retained.mp4",
      bytes: limit === "bytes" ? FILE_OPEN_MAXIMUM_BYTES : 1,
      state: "retained",
      retainUntil: FILE_OPEN_RETENTION_MS
    }));
    expect(entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(FILE_OPEN_TOTAL_BYTES);
    await writeFile(join(directory, "files.json"), JSON.stringify({ version: 1, entries }));
    const openPath = vi.fn();
    const owner = new NativeFileOpener({ directory, openPath, now: () => 100 });
    await expect(owner.open(input(), scope())).resolves.toEqual({ status: "failed", reason: "capacity" });
    expect((await manifest(directory)).entries).toHaveLength(count);
    expect(openPath).not.toHaveBeenCalled();
    owner.dispose();
  });

  it("rejects paths, URLs, unsafe basenames, oversized bytes and an untrusted manifest", async () => {
    for (const name of ["../outside.mp4", "CON.mp4", "clip.mp4:stream", "trailing.", "bad\\leaf.mp4"]) {
      expect(() => parseDesktopOpenFileRequest(input(name))).toThrow();
    }
    expect(() => parseDesktopOpenFileRequest({ ...input(), path: "outside.mp4" })).toThrow();
    const oversized = input();
    Object.defineProperty(oversized.file.bytes, "byteLength", { value: FILE_OPEN_MAXIMUM_BYTES + 1 });
    expect(() => parseDesktopOpenFileRequest(oversized)).toThrow();
    const directory = await root();
    await writeFile(join(directory, "files.json"), JSON.stringify({
      version: 1,
      entries: [{ id: "../outside", name: "file.mp4", bytes: 3, state: "prepared" }]
    }));
    const openPath = vi.fn();
    const owner = new NativeFileOpener({ directory, openPath });
    await expect(owner.open(input(), scope())).resolves.toEqual({ status: "failed", reason: "storage" });
    expect(openPath).not.toHaveBeenCalled();
    owner.dispose();
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
