import { randomUUID } from "node:crypto";
import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { RemoteFileVersionCache, type RemoteFileCacheIdentity } from "./remote-file-version-cache.js";

const current = () => {};
const identity = (source = "a", version = "1", size = 5): RemoteFileCacheIdentity => ({
  source: source.repeat(64), version: version.repeat(64), size
});
const name = (value: RemoteFileCacheIdentity, extension: string) => `${value.source}-${value.version}.${extension}`;

describe("versioned remote workspace file cache", () => {
  it("survives a cold reopen and verifies the complete file before returning a bounded prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-file-cache-"));
    const first = new RemoteFileVersionCache(root), owner = identity();
    await first.write(owner, Buffer.from("hello"), current);
    const cold = new RemoteFileVersionCache(root);
    expect(await cold.read(owner, 2, current)).toEqual(Buffer.from("he"));
    expect(await cold.read(owner, 64, current)).toEqual(Buffer.from("hello"));
    expect(await cold.read(identity("b"), 64, current)).toBeUndefined();
    const files = await readdir(root);
    expect(files).toHaveLength(2);
    expect(files.every(file => /^[a-f0-9]{64}-[a-f0-9]{64}\.(bin|json)$/.test(file))).toBe(true);
    expect(JSON.parse(await readFile(join(root, name(owner, "json")), "utf8"))).toMatchObject({ format: 1, size: 5 });
  });

  it("rejects same-size corruption beyond the requested prefix and repairs it on refetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-file-corrupt-"));
    const cache = new RemoteFileVersionCache(root), owner = identity();
    await cache.write(owner, Buffer.from("hello"), current);
    await writeFile(join(root, name(owner, "bin")), "helXX");
    expect(await cache.read(owner, 2, current)).toBeUndefined();
    await cache.write(owner, Buffer.from("hello"), current);
    expect(await cache.read(owner, 5, current)).toEqual(Buffer.from("hello"));
  });

  it("evicts the least recently used entry under the shared count budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-file-lru-"));
    const cache = new RemoteFileVersionCache(root, { maximumEntries: 2, maximumBytes: 4096 });
    const a = identity("a"), b = identity("b"), c = identity("c");
    await cache.write(a, Buffer.from("first"), current);
    await cache.write(b, Buffer.from("other"), current);
    await utimes(join(root, name(a, "bin")), new Date(0), new Date(0));
    await utimes(join(root, name(b, "bin")), new Date(10), new Date(10));
    expect(await cache.read(a, 5, current)).toEqual(Buffer.from("first"));
    await cache.write(c, Buffer.from("third"), current);
    expect(await cache.read(b, 5, current)).toBeUndefined();
    expect(await cache.read(a, 5, current)).toEqual(Buffer.from("first"));
    expect(await cache.read(c, 5, current)).toEqual(Buffer.from("third"));
  });

  it("replaces a source's previous version before evicting an unrelated recent file", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-file-versions-"));
    const cache = new RemoteFileVersionCache(root, { maximumEntries: 2, maximumBytes: 4096 });
    const old = identity(), next = identity("a", "2"), other = identity("b");
    await cache.write(other, Buffer.from("other"), current);
    await cache.write(old, Buffer.from("first"), current);
    await cache.write(next, Buffer.from("newer"), current);
    expect(await cache.read(old, 5, current)).toBeUndefined();
    expect(await cache.read(next, 5, current)).toEqual(Buffer.from("newer"));
    expect(await cache.read(other, 5, current)).toEqual(Buffer.from("other"));
  });

  it("cleans interrupted managed writes and preserves unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-file-interrupted-"));
    await writeFile(join(root, `write-${randomUUID()}.part`), "interrupted");
    await writeFile(join(root, name(identity(), "bin")), "orphan");
    await writeFile(join(root, "keep.txt"), "unrelated");
    const cache = new RemoteFileVersionCache(root);
    expect(await cache.read(identity("b"), 5, current)).toBeUndefined();
    expect(await readdir(root)).toEqual(["keep.txt"]);
  });

  it("keeps revoked owners and oversized or mismatched inputs out of the cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-remote-file-fenced-"));
    const cache = new RemoteFileVersionCache(root, { maximumBytes: 2048 });
    const revoked = () => { throw new Error("Owner revoked"); };
    await expect(cache.write(identity(), Buffer.from("hello"), revoked)).rejects.toThrow("Owner revoked");
    await cache.write(identity(), Buffer.from("bad size"), current);
    await cache.write(identity("a", "1", 2048), Buffer.alloc(2048), current);
    expect(await readdir(root)).toEqual([]);
  });
});
