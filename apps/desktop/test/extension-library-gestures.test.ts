import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  atomicCopyExtensionLibraryFile,
  ExtensionLibraryGestureCoordinator,
  isPng,
  parseExtensionLibraryBeginSaveRequest,
  parseExtensionLibraryClipboardRequest,
  parseExtensionLibraryCommitSaveRequest,
  parseExtensionLibraryRevealRequest,
  resolveVerifiedExtensionLibraryFile
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

  it("resolves only stable regular files and atomically copies outside the active Library", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "joko-library-gesture-"));
    roots.push(temporary);
    const root = join(temporary, "library");
    await mkdir(join(root, "exports"), { recursive: true });
    const source = join(root, "exports", "art.bin");
    await writeFile(source, Buffer.from("verified artwork"));
    await expect(resolveVerifiedExtensionLibraryFile(root, "exports/art.bin"))
      .resolves.toEqual({ absolutePath: source, bytes: 16 });

    const destination = join(temporary, "saved.bin");
    await expect(atomicCopyExtensionLibraryFile(root, "exports/art.bin", destination)).resolves.toBe(16);
    await expect(readFile(destination, "utf8")).resolves.toBe("verified artwork");
    await expect(atomicCopyExtensionLibraryFile(root, "exports/art.bin", join(root, "copied.bin")))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const link = join(root, "exports", "alias.bin");
    try {
      await symlink(source, link, "file");
      await expect(resolveVerifiedExtensionLibraryFile(root, "exports/alias.bin")).rejects.toMatchObject({ code: "STALE" });
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && ["EPERM", "EACCES"].includes(String(error.code)))) throw error;
    }
  });

  it("binds save tickets to one sender, expires them, and rate-limits attempts", () => {
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
    const destination = join(tmpdir(), "saved.png");
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

  it("requires exact save commit fields", () => {
    const root = join(tmpdir(), "joko-library-root");
    const ticketId = `extension_library_save_${"a".repeat(32)}`;
    expect(parseExtensionLibraryCommitSaveRequest({ extensionId: EXTENSION_ID, ticketId, root, path: "art/file.png" }))
      .toEqual({ extensionId: EXTENSION_ID, ticketId, root, path: "art/file.png" });
    expect(() => parseExtensionLibraryCommitSaveRequest({ extensionId: EXTENSION_ID, ticketId: "bad", root, path: "art/file.png" }))
      .toThrow(/invalid/u);
  });
});
