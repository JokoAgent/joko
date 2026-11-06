import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename } from "node:path";

import { sameFileIdentity, sameStableFile, syncDirectory, UserSelectedFileSaveError,
  type FileSnapshot, type UserSelectedFileDestination, type UserSelectedFileReceipt } from "./private-files.js";

interface SaveRequest {
  readonly destination: UserSelectedFileDestination;
  readonly expectedBytes: number;
}

// The trusted parent starts this process with the selected directory as its cwd.
// All mutations use relative names, including cleanup if the directory is moved.
process.once("message", (request: SaveRequest) => {
  void save(request).then(
    (receipt) => reply({ receipt }),
    (error: unknown) => reply({ error: error instanceof UserSelectedFileSaveError ? error.code : "SAVE_FAILED" })
  );
});

function reply(result: { readonly receipt: UserSelectedFileReceipt } | { readonly error: string }): void {
  process.stdin.destroy();
  if (process.connected) process.send?.(result, () => { if (process.connected) process.disconnect?.(); });
}

async function save({ destination, expectedBytes }: SaveRequest): Promise<UserSelectedFileReceipt> {
  const target = basename(destination.path);
  if (target === "" || target === "." || target === ".." || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("Invalid native save request.");
  }
  const temporary = `.joko-save-${randomUUID()}.tmp`;
  let staged: FileSnapshot | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let cleanupFailed = false;
  try {
    await assertSelectedDirectory(destination);
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    staged = await handle.stat();
    await receiveFile(handle, expectedBytes);
    await handle.sync();
    const complete = await handle.stat();
    staged = complete;
    if (complete.size !== expectedBytes) throw new Error("The staged file changed size.");
    await handle.close();
    handle = undefined;

    await awaitPublish();
    await assertSelectedDirectory(destination);
    if (!sameStableFile(complete, await lstat(temporary))) throw new Error("The staged file changed before publication.");
    if (destination.existing === undefined) {
      // Linking a fully staged file publishes it only if the chosen name is still vacant.
      await link(temporary, target).catch((error: unknown) => {
        if (fileErrorCode(error) === "EEXIST") throw changed();
        throw error;
      });
    } else {
      const existing = await lstat(target).catch(() => { throw changed(); });
      if (!existing.isFile() || existing.isSymbolicLink() || !sameStableFile(destination.existing, existing)) throw changed();
      await rename(temporary, target);
    }
  } finally {
    if (handle !== undefined) staged = await handle.stat().catch(() => staged);
    await handle?.close().catch(() => undefined);
    if (staged !== undefined) {
      try {
        if (sameFileIdentity(staged, await lstat(temporary))) await unlink(temporary);
      } catch (error) {
        cleanupFailed = fileErrorCode(error) !== "ENOENT";
      }
    }
  }
  const directorySyncFailed = await syncDirectory(".").then(() => false, () => true);
  return { bytes: expectedBytes, directorySyncFailed, ...(cleanupFailed ? { temporaryCleanupFailed: true } : {}) };
}

async function assertSelectedDirectory(destination: UserSelectedFileDestination): Promise<void> {
  const [pinned, current] = await Promise.all([
    lstat("."), realpath(destination.selectedDirectory).then((directory) => lstat(directory))
  ]).catch(() => { throw changed(); });
  if (!pinned.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
    || !sameFileIdentity(pinned, destination.parent) || !sameFileIdentity(current, destination.parent)) throw changed();
}

async function receiveFile(handle: Awaited<ReturnType<typeof open>>, expectedBytes: number): Promise<void> {
  let received = 0;
  for await (const input of process.stdin) {
    const chunk = Buffer.from(input);
    if (chunk.length > expectedBytes - received) throw new Error("Invalid native save input.");
    let offset = 0;
    while (offset < chunk.length) {
      const result = await handle.write(chunk, offset, chunk.length - offset);
      if (result.bytesWritten === 0) throw new Error("Native save stopped making progress.");
      offset += result.bytesWritten;
    }
    received += chunk.length;
  }
  if (received !== expectedBytes) throw new Error("Native save was cancelled before publication.");
}

function awaitPublish(): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (allowed: boolean): void => {
      process.off("message", receive);
      process.off("disconnect", retire);
      if (allowed) resolve();
      else reject(new Error("Native save was cancelled before publication."));
    };
    const receive = (message: unknown) => finish(message === "publish");
    const retire = () => finish(false);
    if (!process.connected) { retire(); return; }
    process.once("message", receive);
    process.once("disconnect", retire);
    process.send?.("ready", (error) => { if (error !== null) retire(); });
  });
}

function changed(): UserSelectedFileSaveError {
  return new UserSelectedFileSaveError("DESTINATION_CHANGED", "The selected save destination changed.");
}

function fileErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
