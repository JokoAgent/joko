import { posix } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import type { RemoteFileTransportPort } from "@joko/remote-ssh";

const MAX_PATH_LENGTH = 16_384;
const MAX_SCANNED_ENTRIES = 4_096;
const MAX_DIRECTORIES = 200;
const MAX_PATH_COMPONENTS = 256;

export type RemoteHostDirectoryInspection =
  | { readonly exists: true; readonly path: string }
  | { readonly exists: false; readonly path: string };

/** Distinguishes a missing path from an inaccessible/broken one without trusting SFTP error text. */
export async function inspectRemoteHostDirectory(
  files: RemoteFileTransportPort,
  requestedPath: string,
  signal: AbortSignal,
  assertCurrent: () => void
): Promise<RemoteHostDirectoryInspection> {
  if (requestedPath === "") throw new ConnectError("A remote project directory is required.", Code.InvalidArgument);
  validateRemoteHostDirectoryPath(requestedPath);
  const components = requestedPath.split("/").filter(Boolean);
  if (components.length > MAX_PATH_COMPONENTS) throw new ConnectError("The SSH Host path is too deep.", Code.InvalidArgument);
  signal.throwIfAborted(); assertCurrent();
  let parent = await files.realpath("/", signal);
  signal.throwIfAborted(); assertCurrent();
  if (!validRemotePath(parent) || (await files.stat(parent, signal)).kind !== "directory") {
    throw new ConnectError("The SSH Host root is unavailable.", Code.FailedPrecondition);
  }
  for (const name of components) {
    signal.throwIfAborted(); assertCurrent();
    const entries = await files.list(parent, signal);
    signal.throwIfAborted(); assertCurrent();
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) return { exists: false, path: requestedPath };
    if (entry.kind !== "directory" && entry.kind !== "symbolic_link") {
      throw new ConnectError("The SSH Host path contains a non-directory entry.", Code.FailedPrecondition);
    }
    const resolved = await files.realpath(posix.join(parent, name), signal);
    signal.throwIfAborted(); assertCurrent();
    if (!validRemotePath(resolved) || (await files.stat(resolved, signal)).kind !== "directory") {
      throw new ConnectError("The SSH Host path is not an available directory.", Code.FailedPrecondition);
    }
    parent = resolved;
  }
  signal.throwIfAborted(); assertCurrent();
  return { exists: true, path: parent };
}

export interface RemoteHostDirectoryListing {
  readonly path: string;
  readonly parentPath: string;
  readonly directories: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}

export async function listRemoteHostDirectories(
  files: RemoteFileTransportPort,
  requestedPath: string,
  signal: AbortSignal,
  assertCurrent: () => void
): Promise<RemoteHostDirectoryListing> {
  validateRemoteHostDirectoryPath(requestedPath);
  signal.throwIfAborted(); assertCurrent();
  const canonicalPath = await files.realpath(requestedPath === "" ? "." : requestedPath, signal);
  signal.throwIfAborted(); assertCurrent();
  if (!validRemotePath(canonicalPath) || (await files.stat(canonicalPath, signal)).kind !== "directory") {
    throw new ConnectError("The SSH Host path is not an available directory.", Code.FailedPrecondition);
  }
  signal.throwIfAborted(); assertCurrent();
  const raw = await files.list(canonicalPath, signal);
  signal.throwIfAborted(); assertCurrent();
  const directories: Array<{ readonly name: string; readonly path: string }> = [];
  for (const entry of raw.slice(0, MAX_SCANNED_ENTRIES)) {
    signal.throwIfAborted();
    if (!validName(entry.name)) throw new ConnectError("SSH Host returned an invalid directory entry.", Code.FailedPrecondition);
    if (entry.kind === "directory") directories.push({ name: entry.name, path: posix.join(canonicalPath, entry.name) });
    else if (entry.kind === "symbolic_link") {
      const linkPath = posix.join(canonicalPath, entry.name);
      try {
        const resolved = await files.realpath(linkPath, signal);
        if (validRemotePath(resolved) && (await files.stat(resolved, signal)).kind === "directory") {
          directories.push({ name: entry.name, path: resolved });
        }
      } catch {
        signal.throwIfAborted(); assertCurrent();
      }
    }
  }
  signal.throwIfAborted(); assertCurrent();
  directories.sort((left, right) => left.name.localeCompare(right.name));
  return { path: canonicalPath, parentPath: posix.dirname(canonicalPath),
    directories: directories.slice(0, MAX_DIRECTORIES),
    truncated: raw.length > MAX_SCANNED_ENTRIES || directories.length > MAX_DIRECTORIES };
}

export function validateRemoteHostDirectoryPath(requestedPath: string): void {
  if (requestedPath !== "" && !validRemotePath(requestedPath)) {
    throw new ConnectError("An absolute SSH Host directory path is required.", Code.InvalidArgument);
  }
}

function validRemotePath(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PATH_LENGTH && value.startsWith("/")
    && posix.normalize(value) === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validName(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && value !== "." && value !== ".."
    && !value.includes("/") && !/[\u0000-\u001f\u007f]/u.test(value);
}
