import { promises as fs, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type DocumentPathRequest = {
  readonly path: string;
  readonly signal?: AbortSignal;
} & ({ readonly operation: "read" } | { readonly operation: "write"; readonly overwrite: boolean });

/** Service-owned approval for the canonical file path in this invocation. */
export type DocumentPathAuthorizer = (request: DocumentPathRequest) => Promise<() => void>;

export class DocumentPathError extends Error {
  readonly code = "PATH_NOT_ALLOWED";
  constructor(message: string) {
    super(message);
    this.name = "DocumentPathError";
  }
}

export interface ApprovedDocumentPath {
  readonly root: string;
  readonly path: string;
  readonly rootIdentity: BigIntStats;
  readonly fileIdentity: BigIntStats | null;
  readonly assertCurrent: () => void;
}

export function documentPathInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

export function sameDocumentIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev !== 0n && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

export function sameDocumentVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameDocumentIdentity(left, right) && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** The private writer runs with JSON IPC, so filesystem identities use decimal strings. */
export function documentFileVersion(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export async function approveExternalDocumentPath(
  request: DocumentPathRequest,
  authorize: DocumentPathAuthorizer
): Promise<ApprovedDocumentPath> {
  request.signal?.throwIfAborted();
  if (!displayableLocalPath(request.path)) {
    throw new DocumentPathError("The external document path must identify a regular local file.");
  }
  const parent = dirname(request.path);
  let ancestor = parent;
  try {
    // A new output can create descendants of the existing approved ancestor.
    let ancestorInfo = await statIfPresent(ancestor);
    while (ancestorInfo === null && request.operation === "write" && dirname(ancestor) !== ancestor) {
      ancestor = dirname(ancestor);
      ancestorInfo = await statIfPresent(ancestor);
    }
    if (ancestorInfo === null || (!ancestorInfo.isDirectory() && !ancestorInfo.isSymbolicLink())) {
      throw new DocumentPathError("The external document directory is unavailable.");
    }
    const root = await fs.realpath(ancestor);
    const rootIdentity = await fs.lstat(root, { bigint: true });
    const candidate = resolve(root, relative(ancestor, parent), basename(request.path));
    const fileIdentity = await statIfPresent(candidate);
    const path = fileIdentity?.isFile() ? await fs.realpath(candidate) : candidate;
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() ||
        rootIdentity.dev === 0n || rootIdentity.ino === 0n || !displayableLocalPath(path) || !documentPathInside(root, path) ||
        (fileIdentity === null ? request.operation === "read" : !fileIdentity.isFile() ||
          fileIdentity.isSymbolicLink() || !sameDocumentVersion(fileIdentity, await fs.lstat(path, { bigint: true })))) {
      throw new DocumentPathError("The external document path is unavailable or has changed.");
    }
    const check = await authorize({ ...request, path });
    const assertCurrent = (): void => { request.signal?.throwIfAborted(); check(); };
    assertCurrent();
    return { root, path, rootIdentity, fileIdentity, assertCurrent };
  } catch (error) {
    request.signal?.throwIfAborted();
    if (error instanceof DocumentPathError) throw error;
    throw new DocumentPathError("The external document path could not be authorized.");
  }
}

function displayableLocalPath(path: string): boolean {
  if (Buffer.byteLength(path) > 4_096 || /[\p{Cc}\p{Bidi_Control}]/u.test(path)) return false;
  if (process.platform !== "win32") return true;
  return /^[a-z]:\\/iu.test(path) && path.slice(3).split(sep).every(part =>
    !/[:<>"|?*]/u.test(part) && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part));
}

async function statIfPresent(path: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
