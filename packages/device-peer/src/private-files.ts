import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

const MAXIMUM_PRIVATE_FILE_BYTES = 1024 * 1024;

export interface FileSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

export async function readRegularFileSnapshot(path: string, maximumBytes: number): Promise<Uint8Array> {
  assertNormalizedAbsolute(path);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("The file size limit is invalid.");
  const canonicalBefore = await realpath(path);
  if (!samePath(canonicalBefore, path)) throw new Error("The selected file contains a path alias.");
  const pathBefore = await lstat(path);
  assertRegularFile(pathBefore, "The selected file must be a regular non-symlink file.");
  if (pathBefore.size > maximumBytes) throw new Error("The selected file exceeds its size limit.");

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const openedBefore = await handle.stat();
    assertRegularFile(openedBefore, "The selected file changed before it was opened.");
    if (!sameFileIdentity(pathBefore, openedBefore) || !sameStableFile(pathBefore, openedBefore)) {
      throw new Error("The selected file changed before it was opened.");
    }
    const expectedBytes = openedBefore.size;
    if (expectedBytes > maximumBytes) throw new Error("The selected file exceeds its size limit.");
    const bytes = Buffer.alloc(expectedBytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const sentinel = Buffer.alloc(1);
    const extra = await handle.read(sentinel, 0, 1, offset);
    const openedAfter = await handle.stat();
    const pathAfter = await lstat(path);
    const canonicalAfter = await realpath(path);
    if (
      offset !== expectedBytes ||
      extra.bytesRead !== 0 ||
      !sameStableFile(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, pathAfter) ||
      !sameStableFile(openedAfter, pathAfter) ||
      !samePath(canonicalAfter, path)
    ) {
      throw new Error("The selected file changed while it was being read.");
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close();
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  assertNormalizedAbsolute(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("The private data directory is unsafe.");
  if (!samePath(await realpath(path), path)) throw new Error("The private data directory contains a path alias.");
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(before, after)) {
    throw new Error("The private data directory changed during permission hardening.");
  }
  if (process.platform !== "win32" && !hasPrivateMode(after, 0o700)) {
    throw new Error("The private data directory permissions are unsafe.");
  }
}

export async function atomicWritePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  assertNormalizedAbsolute(path);
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_PRIVATE_FILE_BYTES) {
    throw new Error("The encrypted private value has an invalid size.");
  }
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) assertRegularFile(existing, "The private data file is unsafe.");

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const committed = await lstat(path);
    assertRegularFile(committed, "The committed private data file is unsafe.");
    if (process.platform !== "win32" && !hasPrivateMode(committed, 0o600)) {
      throw new Error("The committed private data file permissions are unsafe.");
    }
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/**
 * Atomically writes bytes to a path explicitly chosen in the native save
 * dialog. The leaf may be replaced, but a directory or symbolic-link leaf is
 * rejected and the temporary file never leaves the selected directory.
 */
export async function atomicWriteUserSelectedFile(
  path: string,
  bytes: Uint8Array,
  maximumBytes: number
): Promise<void> {
  assertNormalizedAbsolute(path);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || bytes.byteLength > maximumBytes) {
    throw new Error("The file save payload exceeds its size limit.");
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) assertRegularFile(existing, "The selected save destination is unsafe.");

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const committed = await lstat(path);
    assertRegularFile(committed, "The saved file is unsafe.");
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function readPrivateFile(path: string): Promise<Uint8Array | undefined> {
  assertNormalizedAbsolute(path);
  await ensurePrivateDirectory(dirname(path));
  try {
    const bytes = await readRegularFileSnapshot(path, MAXIMUM_PRIVATE_FILE_BYTES);
    const info = await lstat(path);
    if (process.platform !== "win32" && !hasPrivateMode(info, 0o600)) {
      throw new Error("The private data file permissions are unsafe.");
    }
    return bytes;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function deletePrivateFile(path: string): Promise<void> {
  assertNormalizedAbsolute(path);
  await ensurePrivateDirectory(dirname(path));
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  assertRegularFile(info, "The private data file is unsafe.");
  await unlink(path);
  await syncDirectory(dirname(path));
}

export function sameFileIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 || right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs && left.ctimeMs === right.ctimeMs;
}

export function sameStableFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

export function hasPrivateMode(info: Pick<FileSnapshot, "mode">, expected: 0o600 | 0o700): boolean {
  return (info.mode & 0o777) === expected;
}

function assertRegularFile(info: Stats, message: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(message);
}

function assertNormalizedAbsolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("File paths must be normalized and absolute.");
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform !== "win32") return false;
  return typeof error === "object" && error !== null && "code" in error &&
    ["EACCES", "EBADF", "EINVAL", "ENOTSUP", "EPERM"].includes(String(error.code));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
