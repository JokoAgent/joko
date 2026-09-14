import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  ExtensionLibraryError,
  ExtensionLibraryVault,
  type ExtensionLibraryEntry
} from "./extension-library-vault.js";

export interface ExtensionLibraryTransferResult {
  readonly files: number;
  readonly bytes: number;
  readonly entries: readonly ExtensionLibraryEntry[];
}

/** Copies a quiesced Library into a new root without copying host metadata. */
export async function copyExtensionLibrary(input: {
  readonly source: ExtensionLibraryVault;
  readonly targetRoot: string;
  readonly extensionId: string;
  readonly now?: () => number;
  readonly freeBytes?: (root: string) => Promise<number | undefined>;
}): Promise<{ readonly vault: ExtensionLibraryVault; readonly result: ExtensionLibraryTransferResult }> {
  const source = await input.source.snapshot();
  await mkdir(input.targetRoot, { recursive: false, mode: 0o700 });
  const targetVault = new ExtensionLibraryVault({
    root: input.targetRoot,
    extensionId: input.extensionId,
    now: input.now,
    freeBytes: input.freeBytes
  });
  await targetVault.open();
  const directories = source.entries.filter((entry) => entry.kind === "directory");
  const files = source.entries.filter((entry) => entry.kind === "file");
  for (const entry of directories) await mkdir(resolveRelative(input.targetRoot, entry.path), { recursive: true, mode: 0o700 });
  for (const entry of files) {
    const from = resolveRelative(input.source.root, entry.path);
    const to = resolveRelative(input.targetRoot, entry.path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    const before = await regularFileIdentity(from);
    if (entry.path.toLowerCase().endsWith(".sqlite")) {
      const database = new DatabaseSync(from, {
        readOnly: true,
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        readBigInts: true,
        defensive: true
      });
      try {
        await backup(database, to, { rate: 4_096 });
      } finally {
        database.close();
      }
      await assertHealthySqlite(to);
    } else {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      const [sourceHash, targetHash] = await Promise.all([
        identityFencedHash(from, before),
        identityFencedHash(to, await regularFileIdentity(to))
      ]);
      if (sourceHash !== targetHash) throw new ExtensionLibraryError("CORRUPT", `Library transfer hash mismatch for ${entry.path}.`);
    }
    const after = await regularFileIdentity(from);
    if (!sameIdentity(before, after)) throw new ExtensionLibraryError("CONFLICT", `Library source changed during transfer: ${entry.path}.`);
  }
  await targetVault.reconcileUsage();
  const target = await targetVault.snapshot();
  assertEquivalentTrees(source.entries, target.entries);
  return { vault: targetVault, result: { files: source.files, bytes: source.bytes, entries: source.entries } };
}

export async function moveOrCopyExtensionLibrary(input: {
  readonly source: ExtensionLibraryVault;
  readonly targetRoot: string;
  readonly extensionId: string;
  readonly sourceIdentity: ExtensionLibraryRootIdentity;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly now?: () => number;
  readonly freeBytes?: (root: string) => Promise<number | undefined>;
}): Promise<{ readonly copied: boolean; readonly result: ExtensionLibraryTransferResult }> {
  const snapshot = await input.source.snapshot();
  try {
    const renameDirectory = input.rename ?? (await import("node:fs/promises")).rename;
    await renameDirectory(input.source.root, input.targetRoot);
    await assertExtensionLibraryRootIdentity(input.targetRoot, {
      ...input.sourceIdentity,
      canonicalPath: resolve(input.targetRoot)
    });
    return { copied: false, result: { files: snapshot.files, bytes: snapshot.bytes, entries: snapshot.entries } };
  } catch (error) {
    if (!crossDevice(error)) throw error;
  }
  const copied = await copyExtensionLibrary({
    source: input.source,
    targetRoot: input.targetRoot,
    extensionId: input.extensionId,
    now: input.now,
    freeBytes: input.freeBytes
  });
  await assertExtensionLibraryRootIdentity(input.source.root, input.sourceIdentity);
  await removeExtensionLibraryRoot(input.source.root, input.sourceIdentity);
  return { copied: true, result: copied.result };
}

export interface ExtensionLibraryRootIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeMs: number;
}

export async function captureExtensionLibraryRootIdentity(root: string): Promise<ExtensionLibraryRootIdentity> {
  const lexical = resolve(root);
  const info = await lstat(lexical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library root is not a regular directory.");
  }
  const canonicalPath = resolve(await realpath(lexical));
  if (canonicalPath !== lexical) throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library root moved through an alias.");
  return {
    canonicalPath,
    device: info.dev.toString(10),
    inode: info.ino.toString(10),
    birthtimeMs: Number(info.birthtimeMs)
  };
}

export async function assertExtensionLibraryRootIdentity(
  root: string,
  expected: ExtensionLibraryRootIdentity
): Promise<ExtensionLibraryRootIdentity> {
  let current: ExtensionLibraryRootIdentity;
  try {
    current = await captureExtensionLibraryRootIdentity(root);
  } catch (error) {
    if (missing(error)) throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library disk or directory is missing.", { cause: error });
    throw error;
  }
  if (current.canonicalPath !== expected.canonicalPath
    || current.device !== expected.device
    || current.inode !== "0" && expected.inode !== "0" && current.inode !== expected.inode
    || (current.inode === "0" || expected.inode === "0") && current.birthtimeMs !== expected.birthtimeMs) {
    throw new ExtensionLibraryError("UNAVAILABLE", "Extension Library binding moved or was replaced.");
  }
  return current;
}

export async function removeExtensionLibraryRoot(root: string, expected: ExtensionLibraryRootIdentity): Promise<void> {
  await assertExtensionLibraryRootIdentity(root, expected);
  const target = resolve(root);
  if (target === resolve(target, "..")) throw new ExtensionLibraryError("PATH_INVALID", "Refusing to remove a filesystem root.");
  await rm(target, { recursive: true, force: false });
}

function resolveRelative(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/"));
  const base = resolve(root);
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  if (!normalizedTarget.startsWith(`${normalizedBase}${sep}`)) {
    throw new ExtensionLibraryError("PATH_INVALID", "Library transfer path escaped its root.");
  }
  return target;
}

async function regularFileIdentity(path: string): Promise<BigIntStats> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new ExtensionLibraryError("PATH_INVALID", "Library transfer found a non-regular file.");
  return info;
}

async function identityFencedHash(path: string, expected: BigIntStats): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(expected, opened)) throw new ExtensionLibraryError("CONFLICT", "Library file changed while it was opened.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < Number(opened.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, Number(opened.size) - offset), offset);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await regularFileIdentity(path);
    if (offset !== Number(opened.size) || !sameIdentity(opened, after) || !sameIdentity(after, pathAfter)) {
      throw new ExtensionLibraryError("CONFLICT", "Library file changed while it was verified.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  const sameObject = left.dev === right.dev && (left.ino !== 0n && right.ino !== 0n
    ? left.ino === right.ino
    : left.ino === 0n && right.ino === 0n && left.birthtimeNs !== 0n && left.birthtimeNs === right.birthtimeNs);
  return left.isFile() && right.isFile() && sameObject && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function assertHealthySqlite(path: string): Promise<void> {
  const database = new DatabaseSync(path, { allowExtension: false, readBigInts: true, defensive: true });
  try {
    const rows = database.prepare("PRAGMA quick_check").all();
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
      throw new ExtensionLibraryError("CORRUPT", "Transferred Library database failed its integrity check.");
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  } finally {
    database.close();
  }
  await Promise.all([
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true })
  ]);
}

function assertEquivalentTrees(source: readonly ExtensionLibraryEntry[], target: readonly ExtensionLibraryEntry[]): void {
  if (source.length !== target.length) {
    throw new ExtensionLibraryError(
      "CORRUPT",
      `Library transfer entry count did not match (${source.map((entry) => entry.path).join(",")} -> ${target.map((entry) => entry.path).join(",")}).`
    );
  }
  for (let index = 0; index < source.length; index += 1) {
    const before = source[index]!;
    const after = target[index]!;
    if (before.path !== after.path || before.kind !== after.kind
      || before.kind === "file" && !before.path.toLowerCase().endsWith(".sqlite") && before.bytes !== after.bytes) {
      throw new ExtensionLibraryError("CORRUPT", `Library transfer manifest mismatch at ${before.path}.`);
    }
  }
}

function crossDevice(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EXDEV";
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
