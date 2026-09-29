import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDedicatedHardwareKeymapBackupStore } from "./keymap-backup-store.js";
import { DEDICATED_HARDWARE_KEYMAP_MAX_BYTES } from "./keymap-controller.js";

const cleanups: string[] = [];
const ORIGINAL = JSON.stringify({ profiles: [{ layers: [{}] }] });
const UPDATED = JSON.stringify({ profiles: [{ layers: [{ updated: true }] }] });
const IDENTITY_A = "creator-a@firmware-1";
const IDENTITY_B = "creator-b@firmware-2";

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("dedicated hardware private keymap backup store", () => {
  it("keeps an immutable factory snapshot while session snapshots are independently cleared", async () => {
    const directory = await temporaryDirectory();
    const store = createDedicatedHardwareKeymapBackupStore({ directory });
    const first = backup(IDENTITY_A, ORIGINAL);

    await store.saveBackup(first);
    await expect(store.readBackup(IDENTITY_A)).resolves.toEqual(first);
    await expect(store.listBackups()).resolves.toEqual([first]);
    await expect(store.saveBackup(first)).rejects.toThrow("already exists");

    await store.clearBackup(IDENTITY_A);
    await expect(store.readBackup(IDENTITY_A)).resolves.toBeUndefined();
    await expect(store.listBackups()).resolves.toEqual([]);
    await expect(readStored(directory, IDENTITY_A, "factory")).resolves.toEqual(first);

    const second = backup(IDENTITY_A, UPDATED);
    await store.saveBackup(second);
    await expect(store.readBackup(IDENTITY_A)).resolves.toEqual(second);
    await expect(readStored(directory, IDENTITY_A, "factory")).resolves.toEqual(first);
  });

  it("isolates factory and active session material by the exact device-firmware identity", async () => {
    const directory = await temporaryDirectory();
    const store = createDedicatedHardwareKeymapBackupStore({ directory });
    const first = backup(IDENTITY_A, ORIGINAL);
    const second = backup(IDENTITY_B, UPDATED);

    await store.saveBackup(first);
    await store.saveBackup(second);
    await expect(store.listBackups()).resolves.toEqual(expect.arrayContaining([first, second]));
    await expect(store.readBackup(IDENTITY_A)).resolves.toEqual(first);
    await expect(store.readBackup(IDENTITY_B)).resolves.toEqual(second);

    await store.clearBackup(IDENTITY_B);
    await expect(store.readBackup(IDENTITY_A)).resolves.toEqual(first);
    await expect(store.readBackup(IDENTITY_B)).resolves.toBeUndefined();
    await expect(readStored(directory, IDENTITY_B, "factory")).resolves.toEqual(second);
  });

  it("preserves and rejects corrupt or oversized session files instead of replacing them", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { recursive: true });
    const corruptPath = storedPath(directory, IDENTITY_A, "session");
    const corrupt = JSON.stringify({ ...backup(IDENTITY_A, ORIGINAL), legacy: true });
    await writeFile(corruptPath, corrupt);
    const corruptStore = createDedicatedHardwareKeymapBackupStore({ directory });

    await expect(corruptStore.listBackups()).rejects.toThrow("invalid");
    await expect(corruptStore.readBackup(IDENTITY_A)).rejects.toThrow("invalid");
    await expect(corruptStore.saveBackup(backup(IDENTITY_A, ORIGINAL))).rejects.toThrow("invalid");
    await expect(readFile(corruptPath, "utf8")).resolves.toBe(corrupt);

    await rm(corruptPath);
    const oversized = "x".repeat(DEDICATED_HARDWARE_KEYMAP_MAX_BYTES + 4 * 1024 + 1);
    await writeFile(corruptPath, oversized);
    await expect(corruptStore.listBackups()).rejects.toThrow("invalid");
    await expect(readFile(corruptPath, "utf8")).resolves.toBe(oversized);
  });

  it("fails closed on a session symlink and leaves its target untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-keymap-backup-link-"));
    cleanups.push(root);
    const directory = resolve(root, "private");
    await mkdir(directory, { recursive: true });
    const target = resolve(root, "outside.json");
    const contents = JSON.stringify(backup(IDENTITY_A, ORIGINAL));
    await writeFile(target, contents);
    try {
      await symlink(target, storedPath(directory, IDENTITY_A, "session"), "file");
    } catch (error) {
      if (hasErrorCode(error, "EPERM") || hasErrorCode(error, "EACCES")) return;
      throw error;
    }
    const store = createDedicatedHardwareKeymapBackupStore({ directory });

    await expect(store.listBackups()).rejects.toThrow("invalid");
    await expect(store.readBackup(IDENTITY_A)).rejects.toThrow("invalid");
    await expect(readFile(target, "utf8")).resolves.toBe(contents);
  });
});

function backup(deviceFirmwareIdentity: string, contents: string) {
  return { version: 1 as const, deviceFirmwareIdentity, contents };
}

function storedPath(directory: string, identity: string, kind: "factory" | "session"): string {
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return join(directory, `${digest}.${kind}.v1.json`);
}

async function readStored(directory: string, identity: string, kind: "factory" | "session") {
  return JSON.parse(await readFile(storedPath(directory, identity, kind), "utf8")) as unknown;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-keymap-backup-"));
  cleanups.push(root);
  return resolve(root, "private");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
