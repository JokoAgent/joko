import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const MAXIMUM_PRIVATE_FILE_BYTES = 1024 * 1024;
const privateFileOperations = new Map<string, Promise<void>>();

export interface FileSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

export interface UserSelectedFileDestination {
  readonly path: string;
  readonly selectedDirectory: string;
  readonly parent: FileSnapshot;
  readonly existing?: FileSnapshot;
}

export interface UserSelectedFileReceipt {
  readonly bytes: number;
  readonly directorySyncFailed: boolean;
  readonly temporaryCleanupFailed?: true;
}

export class UserSelectedFileSaveError extends Error {
  constructor(readonly code: "DESTINATION_CHANGED" | "DESTINATION_UNSAFE" | "SAVE_FAILED" | "SAVE_OUTCOME_UNKNOWN", message: string) {
    super(message);
    this.name = "UserSelectedFileSaveError";
  }
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
  await withPrivateFileOperation(path, () => writePrivateFileNow(path, bytes));
}

async function writePrivateFileNow(path: string, bytes: Uint8Array): Promise<void> {
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

/** Capture the actual directory and existing file as soon as the native picker returns. */
export async function captureUserSelectedFile(path: string): Promise<UserSelectedFileDestination> {
  assertNormalizedAbsolute(path);
  const selectedDirectory = dirname(path);
  const directory = await realpath(selectedDirectory);
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new UserSelectedFileSaveError("DESTINATION_UNSAFE", "The selected save directory is unsafe.");
  }
  const canonicalPath = join(directory, basename(path));
  const existing = await lstat(canonicalPath).catch((error: unknown) => {
    if (isMissingFile(error)) return undefined;
    throw error;
  });
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new UserSelectedFileSaveError("DESTINATION_UNSAFE", "The selected save destination is unsafe.");
  }
  const verified = await lstat(directory);
  if (!verified.isDirectory() || !sameFileIdentity(parent, verified) || !samePath(await realpath(selectedDirectory), directory)) {
    throw new UserSelectedFileSaveError("DESTINATION_CHANGED", "The selected save directory changed. Choose the destination again.");
  }
  return { path: canonicalPath, selectedDirectory, parent: fileSnapshot(parent),
    ...(existing === undefined ? {} : { existing: fileSnapshot(existing) }) };
}

export async function atomicWriteUserSelectedFile(
  destination: string | UserSelectedFileDestination,
  bytes: Uint8Array,
  maximumBytes: number,
  assertCurrent?: () => void
): Promise<UserSelectedFileReceipt> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || bytes.byteLength > maximumBytes) {
    throw new Error("The file save payload exceeds its size limit.");
  }
  const selected = typeof destination === "string" ? await captureUserSelectedFile(destination) : destination;
  return await streamUserSelectedFile(selected, bytes.byteLength, [bytes], assertCurrent);
}

/** Use a per-save working directory so staging, publication and cleanup address the same directory after a rename. */
export async function streamUserSelectedFile(
  destination: UserSelectedFileDestination,
  expectedBytes: number,
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  assertCurrent?: () => void | Promise<void>
): Promise<UserSelectedFileReceipt> {
  const writer = fileURLToPath(new URL("./selected-file-writer.js", import.meta.url));
  const child = spawn(process.execPath, [writer], {
    cwd: dirname(destination.path),
    env: { ELECTRON_RUN_AS_NODE: "1", SystemRoot: process.env["SystemRoot"], WINDIR: process.env["WINDIR"] },
    stdio: ["pipe", "ignore", "ignore", "ipc"],
    windowsHide: true
  });
  const input = child.stdin!;
  let result: { readonly receipt: UserSelectedFileReceipt } | { readonly error: string } | undefined;
  let spawned = false;
  let ready!: (value: boolean) => void;
  const stage = new Promise<boolean>((resolve) => { ready = resolve; });
  let disconnectedByParent = false;
  let exited = false;
  let finish!: () => void;
  const closed = new Promise<void>((done) => {
    finish = () => { ready(false); done(); };
    child.on("error", () => { if (!spawned) finish(); });
    child.once("spawn", () => { spawned = true; });
    child.on("message", (message) => {
      if (message === "ready") ready(true);
      else result = message as typeof result;
    });
    child.once("exit", () => {
      exited = true;
      if (disconnectedByParent) finish();
    });
    child.once("close", finish);
  });
  const disconnect = (): void => {
    if (!child.connected) return;
    // Parent-side IPC closure can suppress ChildProcess's "close" event.
    // Wait for actual exit so the writer can remove its own staged file.
    disconnectedByParent = true;
    child.disconnect();
    if (exited) finish();
  };
  let sentPublishMarker = false;
  let sourceError: unknown;
  async function* chunks() {
    let received = 0;
    try {
      for await (const bytes of source) {
        received += bytes.byteLength;
        if (received > expectedBytes) throw new Error("The save source exceeded its expected size.");
        yield bytes;
      }
      if (received !== expectedBytes) throw new Error("The save source changed size.");
    } catch (error) {
      sourceError = error;
      throw error;
    }
  }
  try {
    child.send({ destination, expectedBytes }, (error) => { if (error !== null) input.destroy(error); });
    await pipeline(Readable.from(chunks(), { objectMode: false }), input);
    if (await stage) {
      try { await assertCurrent?.(); } catch (error) { sourceError = error; throw error; }
      if (child.connected) {
        sentPublishMarker = true;
        child.send("publish", (error) => { if (error !== null) disconnect(); });
      }
    }
  } catch {
    input.destroy();
    disconnect();
  }
  await closed;
  if (result !== undefined && "receipt" in result) return result.receipt;
  if (result !== undefined && result.error === "DESTINATION_CHANGED") {
    throw new UserSelectedFileSaveError("DESTINATION_CHANGED", "The selected save destination changed. Choose the destination again.");
  }
  if (sourceError !== undefined) throw sourceError;
  if (result === undefined && spawned && sentPublishMarker) {
    throw new UserSelectedFileSaveError("SAVE_OUTCOME_UNKNOWN", "The file save could not be confirmed. Check the destination before trying again.");
  }
  throw new UserSelectedFileSaveError("SAVE_FAILED", "The file could not be saved at the selected destination.");
}

export async function readPrivateFile(path: string): Promise<Uint8Array | undefined> {
  assertNormalizedAbsolute(path);
  return withPrivateFileOperation(path, () => readPrivateFileNow(path));
}

async function readPrivateFileNow(path: string): Promise<Uint8Array | undefined> {
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
  await withPrivateFileOperation(path, () => deletePrivateFileNow(path));
}

async function deletePrivateFileNow(path: string): Promise<void> {
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

function withPrivateFileOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  // On Windows another reader or writer can make atomic replacement fail.
  // Keep cooperating private-file operations ordered through close and sync;
  // the snapshot and path checks still reject non-cooperating replacements.
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = privateFileOperations.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  privateFileOperations.set(key, tail);
  void tail.then(() => {
    if (privateFileOperations.get(key) === tail) privateFileOperations.delete(key);
  });
  return result;
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

function fileSnapshot({ dev, ino, size, mode, mtimeMs, ctimeMs, birthtimeMs }: Stats): FileSnapshot {
  return { dev, ino, size, mode, mtimeMs, ctimeMs, birthtimeMs };
}

function assertRegularFile(info: Stats, message: string): void {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(message);
}

function assertNormalizedAbsolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("File paths must be normalized and absolute.");
}

export async function syncDirectory(directory: string): Promise<void> {
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
