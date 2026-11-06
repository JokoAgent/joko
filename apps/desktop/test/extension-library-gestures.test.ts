import { chmodSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { captureUserSelectedFile } from "@joko/device-peer/private-files";

import {
  ExtensionLibraryGestureCoordinator,
  isPng,
  parseExtensionLibraryBeginSaveRequest,
  parseExtensionLibraryClipboardRequest,
  parseExtensionLibraryCommitSaveRequest,
  parseExtensionLibraryRevealRequest,
  resolveVerifiedExtensionLibraryFile,
  saveExtensionLibraryFile
} from "../src/extension-library-gestures.js";
import { mkdtemp } from "./test-paths.js";

const EXTENSION_ID = "extension_0123456789abcdef0123456789abcdef";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop Extension Library native gestures", () => {
  it("validates exact requests, portable paths, safe names, and complete PNG bytes", () => {
    const root = join(tmpdir(), "joko-library-root");
    expect(parseExtensionLibraryRevealRequest({ extensionId: EXTENSION_ID, root, path: "exports/art.png" }))
      .toEqual({ extensionId: EXTENSION_ID, root, path: "exports/art.png" });
    expect(() => parseExtensionLibraryRevealRequest({ extensionId: EXTENSION_ID, root, path: "../secret" })).toThrow(/invalid/u);
    expect(() => parseExtensionLibraryRevealRequest({ extensionId: EXTENSION_ID, root, path: "db.sqlite-wal" })).toThrow(/invalid/u);
    expect(() => parseExtensionLibraryRevealRequest({ extensionId: EXTENSION_ID, root, path: "ok", future: true })).toThrow(/invalid/u);
    expect(parseExtensionLibraryBeginSaveRequest({ extensionId: EXTENSION_ID, name: "art.png" })).toEqual({ extensionId: EXTENSION_ID, name: "art.png" });
    expect(() => parseExtensionLibraryBeginSaveRequest({ extensionId: EXTENSION_ID, name: "../art.png" })).toThrow(/invalid/u);

    expect(isPng(PNG)).toBe(true);
    expect(isPng(PNG.subarray(0, PNG.length - 1))).toBe(false);
    expect(isPng(Buffer.concat([PNG, Buffer.from([0])]))).toBe(false);
    const parsed = parseExtensionLibraryClipboardRequest({ extensionId: EXTENSION_ID, bytes: PNG });
    expect([...parsed.bytes]).toEqual([...PNG]);
    expect(parsed.bytes).not.toBe(PNG);
    expect(() => parseExtensionLibraryClipboardRequest({ extensionId: EXTENSION_ID, bytes: Buffer.from("not png") })).toThrow(/PNG/u);
  });

  it("keeps native reveal local and saves the original node's bytes outside a local Library", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "joko-library-gesture-"));
    roots.push(temporary);
    const root = join(temporary, "library");
    await mkdir(join(root, "exports"), { recursive: true });
    const source = join(root, "exports", "art.bin");
    await writeFile(source, Buffer.from("local file bytes"));
    await expect(resolveVerifiedExtensionLibraryFile(root, "exports/art.bin"))
      .resolves.toEqual({ absolutePath: source, bytes: 16 });

    const destination = join(temporary, "saved.bin");
    const remote = fixtureSource(Buffer.from("verified artwork"));
    await expect(saveExtensionLibraryFile({ totalBytes: 16 }, await captureUserSelectedFile(destination), remote))
      .resolves.toMatchObject({ bytes: 16 });
    await expect(readFile(destination, "utf8")).resolves.toBe("verified artwork");
    await expect(readFile(source, "utf8")).resolves.toBe("local file bytes");
    await expect(saveExtensionLibraryFile({ totalBytes: 16, localRoot: root }, await captureUserSelectedFile(join(root, "copied.bin")), remote))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const link = join(root, "exports", "alias.bin");
    try {
      await symlink(source, link, "file");
      await expect(resolveVerifiedExtensionLibraryFile(root, "exports/alias.bin")).rejects.toMatchObject({ code: "STALE" });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && ["EPERM", "EACCES"].includes(String(error.code)))) throw error;
    }
  });

  it("binds save tickets to one sender, expires them, and rate-limits attempts", async () => {
    let now = 1_800_000_000_000;
    const coordinator = new ExtensionLibraryGestureCoordinator<object>(() => now);
    const firstScope = {};
    const secondScope = {};
    coordinator.attempt(EXTENSION_ID, "reveal");
    expect(() => coordinator.attempt(EXTENSION_ID, "reveal")).toThrow(/frequent/u);
    now += 3_000;
    expect(() => coordinator.attempt(EXTENSION_ID, "reveal")).not.toThrow();

    coordinator.beginSaveDialog();
    expect(() => coordinator.beginSaveDialog()).toThrow(/dialog/u);
    coordinator.endSaveDialog();
    const root = await mkdtemp(join(tmpdir(), "joko-library-save-ticket-"));
    roots.push(root);
    const destination = await captureUserSelectedFile(join(root, "saved.png"));
    const ticket = coordinator.issueSaveTicket(firstScope, EXTENSION_ID, destination);
    expect(() => coordinator.takeSaveTicket(secondScope, EXTENSION_ID, ticket)).toThrow(/unavailable/u);
    expect(coordinator.takeSaveTicket(firstScope, EXTENSION_ID, ticket)).toBe(destination);
    expect(() => coordinator.takeSaveTicket(firstScope, EXTENSION_ID, ticket)).toThrow(/unavailable/u);

    const expiring = coordinator.issueSaveTicket(firstScope, EXTENSION_ID, destination);
    now += 120_000;
    expect(() => coordinator.takeSaveTicket(firstScope, EXTENSION_ID, expiring)).toThrow(/unavailable/u);
    const retired = coordinator.issueSaveTicket(firstScope, EXTENSION_ID, destination);
    coordinator.retireScope(firstScope);
    expect(() => coordinator.takeSaveTicket(firstScope, EXTENSION_ID, retired)).toThrow(/unavailable/u);
  });

  it("keeps a later file and refuses a Library ticket after its chosen directory has been replaced", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "joko-library-save-fence-"));
    roots.push(temporary);
    const root = join(temporary, "library");
    const parent = join(temporary, "selected");
    const moved = join(temporary, "moved");
    await mkdir(root);
    await mkdir(parent);
    await writeFile(join(root, "source.txt"), "library data");
    const leaf = join(parent, "copy.txt");
    const selected = await captureUserSelectedFile(leaf);
    const source = fixtureSource(Buffer.from("library data"), async () => {
      writeFileSync(leaf, "independent file", { flag: "wx" });
    });
    await expect(saveExtensionLibraryFile({ totalBytes: 12, localRoot: root }, selected, source))
      .rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    expect(await readFile(leaf, "utf8")).toBe("independent file");

    const another = await captureUserSelectedFile(join(parent, "another.txt"));
    await rename(parent, moved);
    await mkdir(parent);
    await expect(saveExtensionLibraryFile({ totalBytes: 12, localRoot: root }, another, fixtureSource(Buffer.from("library data"))))
      .rejects.toMatchObject({ code: "DESTINATION_CHANGED" });
    expect(await readdir(parent)).toEqual([]);
    expect(await readdir(moved)).toEqual(["copy.txt"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("returns the published Library byte count when directory sync fails", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "joko-library-save-sync-"));
    roots.push(temporary);
    const root = join(temporary, "library");
    const parent = join(temporary, "selected");
    await mkdir(root);
    await mkdir(parent);
    await writeFile(join(root, "source.txt"), "library data");
    const leaf = join(parent, "copy.txt");
    try {
      const source = fixtureSource(Buffer.from("library data"), async () => {
        chmodSync(parent, 0o300);
      });
      await expect(saveExtensionLibraryFile({ totalBytes: 12, localRoot: root }, await captureUserSelectedFile(leaf), source))
        .resolves.toEqual({ bytes: 12, directorySyncFailed: true });
      expect(await readFile(leaf, "utf8")).toBe("library data");
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  it("checks source authority after staging a multi-range save and keeps the existing destination on revocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-library-save-revoked-"));
    roots.push(root);
    const destination = join(root, "saved.bin");
    await writeFile(destination, "previous file");
    const totalBytes = 16 * 1024 * 1024 + 5;
    const original = fixtureSource(Buffer.alloc(totalBytes, 42), async () => {
      const staged = (await readdir(root)).find(path => path.startsWith(".joko-save-"));
      expect(staged).toBeDefined();
      expect((await stat(join(root, staged!))).size).toBe(totalBytes);
      throw new Error("source authority revoked");
    });
    await expect(saveExtensionLibraryFile({ totalBytes }, await captureUserSelectedFile(destination), original))
      .rejects.toThrow("source authority revoked");
    expect(await readdir(root)).toEqual(["saved.bin"]);
    expect(await readFile(destination, "utf8")).toBe("previous file");
  });

  it("finishes a cancelled save and discards the partial stage after the source read fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-library-save-read-failed-"));
    roots.push(root);
    const destination = join(root, "saved.bin");
    const selected = await captureUserSelectedFile(destination);
    const totalBytes = 1024 * 1024 + 1;
    const source = {
      async read(offset: number, length: number) {
        if (offset !== 0) throw new Error("source read failed");
        return Buffer.alloc(length, 42);
      },
      async verify() { throw new Error("The partial stream must not request publication."); }
    };
    await expect(saveExtensionLibraryFile({ totalBytes }, selected, source)).rejects.toThrow("source read failed");
    expect(await readdir(root)).toEqual([]);
  });

  it("requires exact save commit fields", () => {
    const root = join(tmpdir(), "joko-library-root");
    const ticketId = `extension_library_save_${"a".repeat(32)}`;
    expect(parseExtensionLibraryCommitSaveRequest({ extensionId: EXTENSION_ID, ticketId, localRoot: root, totalBytes: 32 }))
      .toEqual({ extensionId: EXTENSION_ID, ticketId, localRoot: root, totalBytes: 32 });
    expect(() => parseExtensionLibraryCommitSaveRequest({ extensionId: EXTENSION_ID, ticketId: "bad", totalBytes: 32 }))
      .toThrow(/invalid/u);
    expect(() => parseExtensionLibraryCommitSaveRequest({ extensionId: EXTENSION_ID, ticketId, root, path: "art/file.png" }))
      .toThrow(/invalid/u);
  });
});

function fixtureSource(bytes: Uint8Array, verify = async () => {}) {
  return { read: async (offset: number, length: number) => bytes.subarray(offset, offset + length), verify };
}
