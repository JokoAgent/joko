import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileHistoryDiskStorage, createExpoMobileHistoryDiskIO } from "./mobile-history-disk-storage";

const fixture: { root: string; beforeStageRead?: () => Promise<void> } = { root: "" };
async function nodeFileSystem() {
  const fs = await import("node:fs"), path = await import("node:path");
  const uri = (part: string | { uri: string }) => typeof part === "string" ? part : part.uri;
  class Directory {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = path.join(...parts.map(uri)); }
    get name() { return path.basename(this.uri); }
    get exists() { return fs.existsSync(this.uri); }
    create() { fs.mkdirSync(this.uri, { recursive: true }); }
    list(): Array<Directory | File> { return fs.readdirSync(this.uri, { withFileTypes: true }).map(entry => entry.isDirectory() ? new Directory(this, entry.name) : new File(this, entry.name)); }
  }
  class File {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = path.join(...parts.map(uri)); }
    get name() { return path.basename(this.uri); }
    get exists() { return fs.existsSync(this.uri); }
    get size() { return fs.statSync(this.uri).size; }
    create() { fs.writeFileSync(this.uri, ""); }
    write(text: string) { fs.writeFileSync(this.uri, text); }
    async text() { if (this.uri.endsWith(".tmp")) await fixture.beforeStageRead?.(); return fs.promises.readFile(this.uri, "utf8"); }
    delete() { fs.unlinkSync(this.uri); }
    moveSync(destination: File) { fs.renameSync(this.uri, destination.uri); }
  }
  return { Directory, File, Paths: { get cache() { return fixture.root; } } };
}
const fileSystem = nodeFileSystem();
const disk = createExpoMobileHistoryDiskIO(async () => await fileSystem as unknown as Pick<typeof import("expo-file-system"), "Directory" | "File" | "Paths">);

beforeEach(async () => { fixture.beforeStageRead = undefined; fixture.root = await mkdtemp(join(tmpdir(), "joko-history-disk-")); });
afterEach(async () => {
  if (!fixture.root.startsWith(tmpdir() + sep) || !fixture.root.includes("joko-history-disk-")) throw new Error("Unsafe fixture cleanup.");
  await rm(fixture.root, { recursive: true, force: true });
});

describe("private message history files", () => {
  it("does not let one profile's enumeration remove another in-flight history write", async () => {
    const storage = createMobileHistoryDiskStorage(disk);
    let complete!: () => void;
    fixture.beforeStageRead = () => new Promise<void>(resolve => { complete = resolve; });
    const write = storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "original owner");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(await storage.getAllKeys()).toEqual([]);
    complete(); await write;
    expect(await storage.getItem("joko.mobile.offline-cache.v1.profile.manifest")).toBe("original owner");
  });

  it("persists exact Unicode bytes through cold reads and enumerates profile ownership without reading message bodies", async () => {
    const storage = createMobileHistoryDiskStorage(disk);
    const key = "joko.mobile.offline-cache.v1.profile.detail.session.write";
    await storage.setItem(key, "Saved message 中文 👋");
    await storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "manifest");
    await storage.setItem("joko.mobile.offline-cache.v1.other.manifest", "other owner");
    const cold = createMobileHistoryDiskStorage(disk);
    expect(await cold.getItem(key)).toBe("Saved message 中文 👋");
    expect([...(await cold.getAllKeys())].sort()).toEqual([key, "joko.mobile.offline-cache.v1.profile.manifest", "joko.mobile.offline-cache.v1.other.manifest"].sort());
    await cold.multiRemove([key, "joko.mobile.offline-cache.v1.profile.manifest"]);
    expect(await cold.getItem(key)).toBeNull();
    expect(await cold.getItem("joko.mobile.offline-cache.v1.other.manifest")).toBe("other owner");
  });
  it("rejects escaping/unrelated keys, never reads an old settings copy, and removes unfinished cache writes", async () => {
    const storage = createMobileHistoryDiskStorage(disk);
    for (const key of ["credential", "joko.mobile.offline-cache.v1...manifest", "joko.mobile.offline-cache.v1.profile.detail.session/escape.write"])
      expect(() => storage.setItem(key, "unrelated")).toThrow("key is invalid");
    await storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "valid");
    await writeFile(join(fixture.root, "joko-mobile-history-v1", "profile", "manifest.tmp"), "incomplete");
    expect(await storage.getAllKeys()).toEqual(["joko.mobile.offline-cache.v1.profile.manifest"]);
    expect(await storage.getItem("joko.mobile.offline-cache.v1.missing.manifest")).toBeNull();
    await storage.setItem("joko.mobile.offline-cache.v1.profile.manifest", "replacement");
    expect(await storage.getItem("joko.mobile.offline-cache.v1.profile.manifest")).toBe("replacement");
  });
});
