import { constants, promises as fs, type BigIntStats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class DocumentInputError extends Error {
  constructor(readonly code: "PATH_NOT_ALLOWED" | "NOT_A_FILE" | "FILE_TOO_LARGE", message: string) {
    super(message);
    this.name = "DocumentInputError";
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev !== 0n && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function sameVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function pathChanged(): DocumentInputError {
  return new DocumentInputError("PATH_NOT_ALLOWED", "Document input path changed while reading.");
}

async function verifyPath(root: string, target: string, expected: BigIntStats): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = resolve(current, part);
    const stat = await fs.lstat(current, { bigint: true }).catch(() => { throw pathChanged(); });
    if (stat.isSymbolicLink() || (current === target ? !stat.isFile() : !stat.isDirectory())) throw pathChanged();
    if (current === target && !sameIdentity(expected, stat)) throw pathChanged();
  }
  const rebound = await fs.realpath(target).catch(() => { throw pathChanged(); });
  if (rebound !== target || !inside(root, rebound)) throw pathChanged();
}

/** Read one regular in-task file through a bounded handle, with path and identity rechecks. */
export async function readDocumentInput(input: {
  readonly root: string;
  readonly inPath: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}): Promise<Buffer> {
  input.signal?.throwIfAborted();
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || typeof input.inPath !== "string"
    || input.inPath.length === 0 || input.inPath.length > 4_096 || input.inPath.includes("\0")) {
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
  if (!inside(root, target)) throw new DocumentInputError("PATH_NOT_ALLOWED", "Document input must stay in the task working directory.");
  let expected: BigIntStats;
  try {
    expected = await fs.lstat(target, { bigint: true });
  } catch {
    throw new DocumentInputError("NOT_A_FILE", "Document input is unavailable.");
  }
  if (!expected.isFile() || expected.isSymbolicLink()) {
    throw new DocumentInputError("NOT_A_FILE", "Document input is not a regular file.");
  }
  await verifyPath(root, target, expected);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => { throw pathChanged(); });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(expected, before)) throw pathChanged();
    await verifyPath(root, target, before);
    if (before.size > BigInt(input.maxBytes)) throw new DocumentInputError("FILE_TOO_LARGE", "Document input exceeds the size limit.");
    const bytes = Buffer.allocUnsafeSlow(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      input.signal?.throwIfAborted();
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const extra = await handle.read(probe, 0, 1, offset);
    if (extra.bytesRead !== 0) throw new DocumentInputError("FILE_TOO_LARGE", "Document input grew beyond the size limit.");
    const after = await handle.stat({ bigint: true });
    if (offset !== bytes.length || !sameVersion(before, after)) throw pathChanged();
    await verifyPath(root, target, after);
    input.signal?.throwIfAborted();
    return bytes;
  } finally {
    await handle.close();
  }
}
