import { constants, promises as fs, type BigIntStats } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  approveExternalDocumentPath, documentPathInside, sameDocumentIdentity, sameDocumentVersion,
  type ApprovedDocumentPath, type DocumentPathAuthorizer
} from "./document-path.js";

export class DocumentInputError extends Error {
  constructor(readonly code: "PATH_NOT_ALLOWED" | "NOT_A_FILE" | "FILE_TOO_LARGE", message: string) {
    super(message);
    this.name = "DocumentInputError";
  }
}

function pathChanged(): DocumentInputError {
  return new DocumentInputError("PATH_NOT_ALLOWED", "Document input path changed while reading.");
}

async function verifyPath(root: string, target: string, expected: BigIntStats, approved?: ApprovedDocumentPath): Promise<void> {
  approved?.assertCurrent();
  if (approved !== undefined) {
    const currentRoot = await fs.lstat(root, { bigint: true }).catch(() => { throw pathChanged(); });
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || !sameDocumentIdentity(approved.rootIdentity, currentRoot)) {
      throw pathChanged();
    }
  }
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = resolve(current, part);
    const stat = await fs.lstat(current, { bigint: true }).catch(() => { throw pathChanged(); });
    if (stat.isSymbolicLink() || (current === target ? !stat.isFile() : !stat.isDirectory())) throw pathChanged();
    if (current === target && !sameDocumentIdentity(expected, stat)) throw pathChanged();
  }
  const rebound = await fs.realpath(target).catch(() => { throw pathChanged(); });
  if (rebound !== target || !documentPathInside(root, rebound)) throw pathChanged();
  approved?.assertCurrent();
}

interface DocumentReadInput {
  readonly root: string;
  readonly inPath: string;
  readonly signal?: AbortSignal;
  readonly authorizePath?: DocumentPathAuthorizer;
}

interface PreparedDocumentInput {
  readonly root: string;
  readonly path: string;
  readonly expected: BigIntStats;
  readonly approved?: ApprovedDocumentPath;
}

export async function prepareDocumentInput(input: DocumentReadInput): Promise<PreparedDocumentInput> {
  input.signal?.throwIfAborted();
  if (typeof input.inPath !== "string" || input.inPath.length === 0 || input.inPath.length > 4_096 || input.inPath.includes("\0")) {
    throw new DocumentInputError("PATH_NOT_ALLOWED", "Document input path is invalid.");
  }
  const root = await fs.realpath(input.root).catch(() => {
    throw new DocumentInputError("PATH_NOT_ALLOWED", "Task working directory is unavailable.");
  });
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.dev === 0n || rootStat.ino === 0n) {
    throw new DocumentInputError("PATH_NOT_ALLOWED", "Task working directory is unavailable.");
  }
  const target = resolve(root, input.inPath);
  if (!documentPathInside(root, target)) {
    if (input.authorizePath === undefined || target === root) {
      throw new DocumentInputError("PATH_NOT_ALLOWED", "Document input must stay in the task working directory.");
    }
    const approved = await approveExternalDocumentPath({
      operation: "read", path: target, ...(input.signal === undefined ? {} : { signal: input.signal })
    }, input.authorizePath);
    if (approved.fileIdentity === null) throw pathChanged();
    return { root: approved.root, path: approved.path, expected: approved.fileIdentity, approved };
  }
  let expected: BigIntStats;
  try {
    expected = await fs.lstat(target, { bigint: true });
  } catch {
    throw new DocumentInputError("NOT_A_FILE", "Document input is unavailable.");
  }
  if (!expected.isFile() || expected.isSymbolicLink()) {
    throw new DocumentInputError("NOT_A_FILE", "Document input is not a regular file.");
  }
  return { root, path: target, expected };
}

/** Read one authorized regular file through a bounded handle. */
export async function readPreparedDocumentInput(input: PreparedDocumentInput, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new DocumentInputError("PATH_NOT_ALLOWED", "Document input limit is invalid.");
  const { root, path: target, expected, approved } = input;
  await verifyPath(root, target, expected, approved);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw pathChanged(); });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameDocumentIdentity(expected, before) || (approved !== undefined && !sameDocumentVersion(expected, before))) throw pathChanged();
    await verifyPath(root, target, before, approved);
    if (before.size > BigInt(maxBytes)) throw new DocumentInputError("FILE_TOO_LARGE", "Document input exceeds the size limit.");
    const bytes = Buffer.allocUnsafeSlow(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = await handle.read(probe, 0, 1, offset);
    if (extra.bytesRead !== 0) throw new DocumentInputError("FILE_TOO_LARGE", "Document input grew beyond the size limit.");
    const after = await handle.stat({ bigint: true });
    if (offset !== bytes.length || !sameDocumentVersion(before, after)) throw pathChanged();
    await verifyPath(root, target, after, approved);
    signal?.throwIfAborted();
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readDocumentInput(input: DocumentReadInput & { readonly maxBytes: number }): Promise<Buffer> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new DocumentInputError("PATH_NOT_ALLOWED", "Document input limit is invalid.");
  return await readPreparedDocumentInput(await prepareDocumentInput(input), input.maxBytes, input.signal);
}
