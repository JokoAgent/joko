import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  DEDICATED_HARDWARE_KEYMAP_MAX_BYTES,
  isDedicatedHardwareKeymapDeviceFirmwareIdentity,
  type DedicatedHardwareKeymapBackup,
  type DedicatedHardwareKeymapBackupStore
} from "./keymap-controller.js";

const BACKUP_MAX_BYTES = DEDICATED_HARDWARE_KEYMAP_MAX_BYTES + 4 * 1024;
const BACKUP_FILE_PATTERN = /^([a-f0-9]{64})\.(factory|session)\.v1\.json$/u;
const BACKUP_TEMP_FILE_PATTERN = /^\.[a-f0-9]{64}\.(factory|session)\.v1\.json\.[0-9a-f-]{36}\.tmp$/u;
const BACKUP_DIRECTORY_MAX_ENTRIES = 256;

type BackupKind = "factory" | "session";

export function createDedicatedHardwareKeymapBackupStore(options: {
  readonly directory: string;
}): DedicatedHardwareKeymapBackupStore {
  if (!isCanonicalAbsolutePath(options.directory)) {
    throw new TypeError("Dedicated hardware keymap backup directory is invalid.");
  }

  const ensureDirectory = async (): Promise<void> => {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(options.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Dedicated hardware keymap backup directory is not private storage.");
    }
  };

  const readBackupFile = async (
    deviceFirmwareIdentity: string,
    kind: BackupKind
  ): Promise<DedicatedHardwareKeymapBackup | undefined> => {
    assertIdentity(deviceFirmwareIdentity);
    await ensureDirectory();
    return readAndValidateFile(
      join(options.directory, backupFileName(deviceFirmwareIdentity, kind)),
      deviceFirmwareIdentity
    );
  };

  const listBackups = async (): Promise<readonly DedicatedHardwareKeymapBackup[]> => {
    await ensureDirectory();
    const entries = await readdir(options.directory, { withFileTypes: true });
    if (entries.length > BACKUP_DIRECTORY_MAX_ENTRIES) {
      throw new Error("Dedicated hardware keymap backup directory has too many entries.");
    }
    const sessions: DedicatedHardwareKeymapBackup[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (BACKUP_TEMP_FILE_PATTERN.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error("Dedicated hardware keymap backup temporary entry is invalid.");
        }
        continue;
      }
      const match = BACKUP_FILE_PATTERN.exec(entry.name);
      if (match === null || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Dedicated hardware keymap backup entry is invalid.");
      }
      const parsed = await readAndValidateFile(join(options.directory, entry.name));
      if (parsed === undefined) {
        throw new Error("Dedicated hardware keymap backup disappeared while listing.");
      }
      if (identityDigest(parsed.deviceFirmwareIdentity) !== match[1]) {
        throw new Error("Dedicated hardware keymap backup identity does not match its owner path.");
      }
      if (match[2] === "session") sessions.push(parsed);
    }
    return Object.freeze(sessions);
  };

  return Object.freeze({
    listBackups,
    readBackup: (deviceFirmwareIdentity: string) =>
      readBackupFile(deviceFirmwareIdentity, "session"),
    saveBackup: async (backup: DedicatedHardwareKeymapBackup) => {
      const parsed = parseBackup(backup);
      await ensureDirectory();
      const sessionPath = join(options.directory, backupFileName(parsed.deviceFirmwareIdentity, "session"));
      const existingSession = await readAndValidateFile(sessionPath, parsed.deviceFirmwareIdentity);
      if (existingSession !== undefined) {
        throw new Error("Dedicated hardware keymap session backup already exists.");
      }
      const factoryPath = join(options.directory, backupFileName(parsed.deviceFirmwareIdentity, "factory"));
      const existingFactory = await readAndValidateFile(factoryPath, parsed.deviceFirmwareIdentity);
      if (existingFactory === undefined) {
        try {
          await writeExclusiveBackup(factoryPath, parsed);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const racedFactory = await readAndValidateFile(factoryPath, parsed.deviceFirmwareIdentity);
          if (racedFactory === undefined) throw error;
        }
      }

      try {
        await writeExclusiveBackup(sessionPath, parsed);
      } catch (error) {
        if (isAlreadyExists(error)) {
          await readAndValidateFile(sessionPath, parsed.deviceFirmwareIdentity);
          throw new Error("Dedicated hardware keymap session backup already exists.");
        }
        throw error;
      }
    },
    clearBackup: async (expectedDeviceFirmwareIdentity: string) => {
      assertIdentity(expectedDeviceFirmwareIdentity);
      const filePath = join(options.directory, backupFileName(expectedDeviceFirmwareIdentity, "session"));
      const current = await readBackupFile(expectedDeviceFirmwareIdentity, "session");
      if (current === undefined) return;
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Dedicated hardware keymap session backup changed before cleanup.");
      }
      await rm(filePath);
    }
  });
}

async function readAndValidateFile(
  filePath: string,
  expectedDeviceFirmwareIdentity?: string
): Promise<DedicatedHardwareKeymapBackup | undefined> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > BACKUP_MAX_BYTES) {
    throw new Error("Dedicated hardware keymap backup is invalid.");
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== metadata.size || bytes.byteLength > BACKUP_MAX_BYTES) {
    throw new Error("Dedicated hardware keymap backup changed while reading.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Dedicated hardware keymap backup is invalid.");
  }
  const backup = parseBackup(parsed);
  if (expectedDeviceFirmwareIdentity !== undefined &&
      backup.deviceFirmwareIdentity !== expectedDeviceFirmwareIdentity) {
    throw new Error("Dedicated hardware keymap backup identity changed.");
  }
  return backup;
}

async function writeExclusiveBackup(
  filePath: string,
  backup: DedicatedHardwareKeymapBackup
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(backup));
  if (bytes.byteLength > BACKUP_MAX_BYTES) {
    throw new Error("Dedicated hardware keymap backup is too large.");
  }
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function backupFileName(deviceFirmwareIdentity: string, kind: BackupKind): string {
  return `${identityDigest(deviceFirmwareIdentity)}.${kind}.v1.json`;
}

function identityDigest(deviceFirmwareIdentity: string): string {
  return createHash("sha256").update(deviceFirmwareIdentity, "utf8").digest("hex");
}

function assertIdentity(value: unknown): asserts value is string {
  if (!isDedicatedHardwareKeymapDeviceFirmwareIdentity(value)) {
    throw new TypeError("Dedicated hardware keymap identity is invalid.");
  }
}

function parseBackup(value: unknown): DedicatedHardwareKeymapBackup {
  if (!isExactRecord(value, ["version", "deviceFirmwareIdentity", "contents"]) || value.version !== 1 ||
      !isDedicatedHardwareKeymapDeviceFirmwareIdentity(value.deviceFirmwareIdentity) ||
      typeof value.contents !== "string" || value.contents.length === 0 ||
      new TextEncoder().encode(value.contents).byteLength > DEDICATED_HARDWARE_KEYMAP_MAX_BYTES) {
    throw new Error("Dedicated hardware keymap backup is invalid.");
  }
  return Object.freeze({
    version: 1,
    deviceFirmwareIdentity: value.deviceFirmwareIdentity,
    contents: value.contents
  });
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && value.trim() === value &&
    isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
