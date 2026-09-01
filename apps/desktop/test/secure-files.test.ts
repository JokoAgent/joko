import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  atomicWritePrivateFile,
  atomicWriteUserSelectedFile,
  deletePrivateFile,
  ensurePrivateDirectory,
  hasPrivateMode,
  readPrivateFile,
  readRegularFileSnapshot,
  sameFileIdentity,
  sameStableFile,
  type FileSnapshot
} from "../src/secure-files.js";
import { mkdtemp } from "./test-paths.js";

describe("Desktop secure files", () => {
  it("reads a stable regular attachment and rejects directories, aliases, and oversize files", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-desktop-attachment-"));
    const file = join(root, "attachment.txt");
    await writeFile(file, "stable attachment");
    await expect(readRegularFileSnapshot(file, 64)).resolves.toEqual(new Uint8Array(Buffer.from("stable attachment")));
    await expect(readRegularFileSnapshot(file, 4)).rejects.toThrow(/size limit/u);
    await expect(readRegularFileSnapshot(root, 64)).rejects.toThrow(/regular non-symlink/u);
    await expect(readRegularFileSnapshot("relative.txt", 64)).rejects.toThrow(/normalized and absolute/u);
  });

  it("rejects a leaf symlink instead of following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-desktop-attachment-link-"));
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(target, "do not follow");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") return;
      throw error;
    }
    await expect(readRegularFileSnapshot(link, 64)).rejects.toThrow(/alias|symlink/u);
  });

  it("atomically replaces encrypted private data with private modes and no temporary residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-desktop-private-"));
    const directory = join(root, "credentials");
    const target = join(directory, "profile.bin");
    await atomicWritePrivateFile(target, new Uint8Array([1, 2, 3]));
    expect(await readPrivateFile(target)).toEqual(new Uint8Array([1, 2, 3]));
    await atomicWritePrivateFile(target, new Uint8Array([4, 5, 6, 7]));
    expect(await readFile(target)).toEqual(Buffer.from([4, 5, 6, 7]));
    expect(await readdir(directory)).toEqual(["profile.bin"]);
    if (process.platform !== "win32") {
      expect(hasPrivateMode(await stat(directory), 0o700)).toBe(true);
      expect(hasPrivateMode(await stat(target), 0o600)).toBe(true);
    }
    await deletePrivateFile(target);
    await expect(readPrivateFile(target)).resolves.toBeUndefined();
  });

  it("atomically saves an explicitly selected export and rejects unsafe leaves and oversized payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-desktop-save-"));
    const target = join(root, "task.jshare");
    await atomicWriteUserSelectedFile(target, new Uint8Array([1, 2, 3]), 4);
    await atomicWriteUserSelectedFile(target, new Uint8Array([4, 5]), 4);
    expect(await readFile(target)).toEqual(Buffer.from([4, 5]));
    expect(await readdir(root)).toEqual(["task.jshare"]);
    await expect(atomicWriteUserSelectedFile(target, new Uint8Array([1, 2, 3, 4, 5]), 4))
      .rejects.toThrow(/size limit/u);
    await expect(atomicWriteUserSelectedFile(root, new Uint8Array(), 4)).rejects.toThrow(/unsafe/u);
  });

  it("fails closed when the private directory itself is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-desktop-private-link-"));
    const target = join(root, "target");
    const link = join(root, "credentials");
    await mkdir(target);
    try {
      await symlink(target, link, "junction");
    } catch (error) {
      if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") return;
      throw error;
    }
    await expect(ensurePrivateDirectory(link)).rejects.toThrow(/unsafe|alias/u);
  });

  it("detects identity and same-size metadata changes in TOCTOU snapshots", () => {
    const base: FileSnapshot = { dev: 1, ino: 2, size: 8, mode: 0o100600, mtimeMs: 10, ctimeMs: 11, birthtimeMs: 1 };
    expect(sameFileIdentity(base, { ...base })).toBe(true);
    expect(sameFileIdentity(base, { ...base, ino: 3 })).toBe(false);
    expect(sameStableFile(base, { ...base, mtimeMs: 12 })).toBe(false);
    expect(sameStableFile(base, { ...base, ctimeMs: 12 })).toBe(false);
    expect(sameStableFile(base, { ...base, size: 9 })).toBe(false);
  });

  it("rejects a credential path replaced with a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-desktop-private-file-link-"));
    const directory = join(root, "credentials");
    const external = join(root, "external.bin");
    const target = join(directory, "profile.bin");
    await mkdir(directory);
    await writeFile(external, "external ciphertext", { mode: 0o600 });
    try {
      await symlink(external, target, "file");
    } catch (error) {
      if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") return;
      throw error;
    }
    await expect(readPrivateFile(target)).rejects.toThrow(/alias|symlink/u);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });
});
