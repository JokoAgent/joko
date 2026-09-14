import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXTENSION_LIBRARY_LIMITS,
  ExtensionLibraryError,
  type ExtensionLibraryLimits,
  ExtensionLibraryVault,
  validateExtensionLibraryPath
} from "./extension-library-vault.js";

const EXTENSION_ID = `extension_${"a".repeat(32)}`;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(options: { readonly freeBytes?: number; readonly limits?: Partial<ExtensionLibraryLimits> } = {}) {
  const temporaryPath = await mkdtemp(join(tmpdir(), "joko-extension-library-"));
  const temporary = { path: temporaryPath, cleanup: () => rm(temporaryPath, { recursive: true, force: true }) };
  cleanups.push(temporary.cleanup);
  const root = join(temporaryPath, "library");
  const vault = new ExtensionLibraryVault({
    root,
    extensionId: EXTENSION_ID,
    freeBytes: async () => options.freeBytes,
    limits: options.limits
  });
  return { temporary, root, vault };
}

describe("ExtensionLibraryVault", () => {
  it("opens an empty strict-v1 root and rebuilds a damaged usage ledger without treating metadata damage as empty", async () => {
    const { root, vault } = await fixture();
    await expect(vault.open()).resolves.toMatchObject({ state: "ready", usage: { files: 0, bytes: 0 } });
    await vault.write({ path: "projects/alpha.txt", bytes: Buffer.from("alpha") });
    await writeFile(join(root, ".joko-library", "usage.json"), "broken");

    const reopened = new ExtensionLibraryVault({ root, extensionId: EXTENSION_ID });
    await expect(reopened.open()).resolves.toMatchObject({ state: "ready", usage: { files: 1, bytes: 5 } });
    await writeFile(join(root, ".joko-library", "metadata.json"), "broken");
    const corrupt = new ExtensionLibraryVault({ root, extensionId: EXTENSION_ID });
    await expect(corrupt.open()).resolves.toMatchObject({ state: "unavailable", reason: "metadata_corrupt" });
    await expect(corrupt.read({ path: "projects/alpha.txt" })).rejects.toMatchObject({ code: "CORRUPT" });
    await expect(corrupt.repairMetadata()).resolves.toMatchObject({ state: "ready", usage: { files: 1, bytes: 5 } });
    const preserved = (await readdir(join(root, ".joko-library")))
      .find((name) => name.startsWith("metadata.corrupt."));
    expect(preserved).toEqual(expect.any(String));
    await expect(readFile(join(root, ".joko-library", preserved!), "utf8")).resolves.toBe("broken");
  });

  it("reconciles a valid but stale usage ledger at startup and never creates a missing bound root", async () => {
    const { temporary, root, vault } = await fixture();
    await vault.open();
    await vault.write({ path: "actual.txt", bytes: Buffer.from("actual") });
    await writeFile(join(root, ".joko-library", "usage.json"), JSON.stringify({
      format: 1,
      files: 0,
      bytes: 0,
      revision: "41",
      updatedAt: 1
    }));
    const reopened = new ExtensionLibraryVault({ root, extensionId: EXTENSION_ID });
    await expect(reopened.open({ create: false })).resolves.toMatchObject({
      state: "ready",
      usage: { files: 1, bytes: 6, revision: 42n }
    });

    const missingRoot = join(temporary.path, "missing-bound-library");
    const missing = new ExtensionLibraryVault({ root: missingRoot, extensionId: EXTENSION_ID });
    await expect(missing.open({ create: false })).resolves.toMatchObject({ state: "unavailable", reason: "io" });
    await expect(lstat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically reads, writes, pages, renames, and deletes portable keys with owner-computed hashes", async () => {
    const { root, vault } = await fixture();
    await vault.open();
    const written = await vault.write({ path: "canvases/one/data.json", bytes: Buffer.from("first") });
    expect(written).toEqual({
      path: "canvases/one/data.json",
      bytes: 5,
      sha256: "a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e"
    });
    await expect(vault.write({ path: "canvases/one/data.json", bytes: Buffer.from("other"), ifNotExists: true }))
      .rejects.toMatchObject({ code: "ALREADY_EXISTS" });
    await vault.write({ path: "canvases/two/data.json", bytes: Buffer.from("second") });
    await vault.mkdir("empty/folder");

    const page = await vault.list({ recursive: true, limit: 2 });
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const secondPage = await vault.list({ recursive: true, limit: 20, cursor: page.nextCursor });
    expect([...page.entries, ...secondPage.entries].map((entry) => entry.path)).toEqual([
      "canvases",
      "canvases/one",
      "canvases/one/data.json",
      "canvases/two",
      "canvases/two/data.json",
      "empty",
      "empty/folder"
    ]);
    await vault.rename({ from: "canvases/one/data.json", to: "canvases/one/renamed.json" });
    await expect(vault.read({ path: "canvases/one/renamed.json" })).resolves.toMatchObject({ bytes: Buffer.from("first") });
    await vault.delete("canvases", true);
    await expect(readFile(join(root, "canvases", "one", "renamed.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces read-only, disk reserve, soft limit, file fuse, and stale pagination", async () => {
    const { vault } = await fixture({
      freeBytes: 20,
      limits: { diskReserveBytes: 10, softLimitBytes: 3, maximumFiles: 2 }
    });
    await vault.open();
    await vault.write({ path: "one.txt", bytes: Buffer.from("1234") });
    await expect(vault.status()).resolves.toMatchObject({ softLimitExceeded: true });
    await vault.write({ path: "two.txt", bytes: Buffer.from("2") });
    const page = await vault.list({ recursive: true, limit: 1 });
    vault.setReadonly(true);
    await expect(vault.read({ path: "one.txt" })).resolves.toMatchObject({ bytes: Buffer.from("1234") });
    await expect(vault.write({ path: "three.txt", bytes: Buffer.from("3") })).rejects.toMatchObject({ code: "READ_ONLY" });
    vault.setReadonly(false);
    await vault.rename({ from: "two.txt", to: "renamed.txt" });
    await expect(vault.list({ recursive: true, cursor: page.nextCursor })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(vault.write({ path: "three.txt", bytes: Buffer.from("3") })).rejects.toMatchObject({ code: "FILE_LIMIT" });
    await expect(vault.write({ path: "three.txt", bytes: Buffer.from("12345678901") })).rejects.toMatchObject({ code: "DISK_FULL" });
  });

  it("rejects traversal, hidden/Windows aliases, symlink ancestry, and special objects", async ({ skip }) => {
    for (const value of ["../escape", "/absolute", "C:/drive", ".joko-library/meta.json", "a\\b", "con/file", "a./file", "a//b"]) {
      expect(() => validateExtensionLibraryPath(value)).toThrow(ExtensionLibraryError);
    }
    const { temporary, root, vault } = await fixture();
    await vault.open();
    await writeFile(join(root, ".extension-hidden"), "hidden");
    await expect(vault.snapshot()).rejects.toMatchObject({ code: "CORRUPT" });
    await rm(join(root, ".extension-hidden"));
    const outside = join(temporary.path, "outside");
    await mkdir(outside);
    try {
      await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip();
      throw error;
    }
    await expect(vault.write({ path: "linked/escape.txt", bytes: Buffer.from("no") })).rejects.toMatchObject({ code: "PATH_INVALID" });
    const info = await lstat(join(root, "linked"));
    expect(info.isSymbolicLink() || process.platform === "win32").toBe(true);
    expect(constants.O_RDONLY).toBeTypeOf("number");
  });

  it("identity-fences the root and every destructive filesystem mutation", async () => {
    let mutation: ((operation: "write" | "staged_write" | "mkdir" | "delete" | "rename" | "sqlite") => Promise<void>) | undefined;
    const temporaryPath = await mkdtemp(join(tmpdir(), "joko-extension-library-race-"));
    cleanups.push(() => rm(temporaryPath, { recursive: true, force: true }));
    const root = join(temporaryPath, "library");
    const vault = new ExtensionLibraryVault({
      root,
      extensionId: EXTENSION_ID,
      beforeFilesystemMutation: (operation) => mutation?.(operation)
    });
    await vault.open();

    mutation = async (operation) => {
      if (operation === "write") throw new ExtensionLibraryError("UNAVAILABLE", "revoked");
    };
    await expect(vault.write({ path: "blocked/write.txt", bytes: Buffer.from("blocked") }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(lstat(join(root, "blocked"))).rejects.toMatchObject({ code: "ENOENT" });

    mutation = async (operation) => {
      if (operation === "mkdir") throw new ExtensionLibraryError("UNAVAILABLE", "revoked");
    };
    await expect(vault.mkdir("blocked-directory")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(lstat(join(root, "blocked-directory"))).rejects.toMatchObject({ code: "ENOENT" });
    mutation = undefined;

    await vault.write({ path: "write.txt", bytes: Buffer.from("old") });
    mutation = async (operation) => {
      if (operation !== "write") return;
      mutation = undefined;
      await rename(join(root, "write.txt"), join(root, "write.old"));
      await writeFile(join(root, "write.txt"), "concurrent");
    };
    await expect(vault.write({ path: "write.txt", bytes: Buffer.from("new") })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(readFile(join(root, "write.txt"), "utf8")).resolves.toBe("concurrent");

    const staged = await vault.allocateTemporaryPath(".stream");
    const streamBytes = Buffer.from("stream");
    await writeFile(staged, streamBytes);
    mutation = async (operation) => {
      if (operation !== "staged_write") return;
      mutation = undefined;
      await writeFile(join(root, "appeared.txt"), "concurrent");
    };
    await expect(vault.commitStagedWrite({
      temporaryPath: staged,
      path: "appeared.txt",
      bytes: streamBytes.byteLength,
      sha256: createHash("sha256").update(streamBytes).digest("hex")
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(readFile(join(root, "appeared.txt"), "utf8")).resolves.toBe("concurrent");

    await vault.write({ path: "delete.txt", bytes: Buffer.from("old") });
    mutation = async (operation) => {
      if (operation !== "delete") return;
      mutation = undefined;
      await rename(join(root, "delete.txt"), join(root, "delete.old"));
      await writeFile(join(root, "delete.txt"), "concurrent");
    };
    await expect(vault.delete("delete.txt")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(readFile(join(root, "delete.txt"), "utf8")).resolves.toBe("concurrent");

    await vault.write({ path: "rename.txt", bytes: Buffer.from("old") });
    mutation = async (operation) => {
      if (operation !== "rename") return;
      mutation = undefined;
      await rename(join(root, "rename.txt"), join(root, "rename.old"));
      await writeFile(join(root, "rename.txt"), "concurrent");
    };
    await expect(vault.rename({ from: "rename.txt", to: "renamed.txt" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(readFile(join(root, "rename.txt"), "utf8")).resolves.toBe("concurrent");
    await expect(lstat(join(root, "renamed.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    await rename(root, join(temporaryPath, "original-library"));
    await mkdir(root);
    await expect(vault.write({ path: "replacement.txt", bytes: Buffer.from("no") })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(lstat(join(root, "replacement.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
