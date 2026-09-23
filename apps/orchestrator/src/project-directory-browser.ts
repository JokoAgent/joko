import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";

const MAX_PATH_LENGTH = 4096;
const MAX_SCANNED_ENTRIES = 4096;
const MAX_DIRECTORIES = 200;

export interface ProjectDirectoryListing {
  readonly path: string;
  readonly parentPath: string;
  readonly directories: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}

export async function listProjectDirectories(requestedPath: string, signal: AbortSignal): Promise<ProjectDirectoryListing> {
  if (requestedPath.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/u.test(requestedPath)
    || (requestedPath !== "" && (requestedPath.trim() !== requestedPath || !isAbsolute(requestedPath)))) {
    throw new ConnectError("An absolute service-node directory path is required.", Code.InvalidArgument);
  }
  signal.throwIfAborted();
  const canonicalPath = await directoryPath(requestedPath === "" ? homedir() : requestedPath);
  signal.throwIfAborted();
  const directories: Array<{ readonly name: string; readonly path: string }> = [];
  let scanned = 0;
  let truncated = false;
  try {
    const stream = await opendir(canonicalPath);
    for await (const entry of stream) {
      signal.throwIfAborted();
      if (++scanned > MAX_SCANNED_ENTRIES) { truncated = true; break; }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const childPath = join(canonicalPath, entry.name);
      if (entry.isSymbolicLink()) {
        try { if (!(await stat(childPath)).isDirectory()) continue; }
        catch { continue; }
      }
      directories.push({ name: entry.name, path: childPath });
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ConnectError) throw error;
    throw directoryError(error);
  }
  signal.throwIfAborted();
  directories.sort((left, right) => left.name.localeCompare(right.name));
  if (directories.length > MAX_DIRECTORIES) truncated = true;
  return { path: canonicalPath, parentPath: dirname(canonicalPath), directories: directories.slice(0, MAX_DIRECTORIES), truncated };
}

async function directoryPath(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) {
      throw new ConnectError("The selected service-node path is not a directory.", Code.FailedPrecondition);
    }
    return canonical;
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw directoryError(error);
  }
}

function directoryError(error: unknown): ConnectError {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new ConnectError("The service-node directory is unavailable.", Code.NotFound);
  if (code === "EACCES" || code === "EPERM") return new ConnectError("The service-node directory is not accessible.", Code.PermissionDenied);
  return new ConnectError("The service-node directory could not be read.", Code.FailedPrecondition);
}
