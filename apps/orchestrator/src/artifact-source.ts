import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

export interface ValidatedArtifactSource {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly sourcePath: string;
}

export async function validateLocalArtifactSource(input: {
  readonly workspaceRoot: string;
  readonly sourcePath: string;
  readonly expectedSha256: string;
  readonly expectedByteLength: number;
  readonly signal?: AbortSignal;
}): Promise<ValidatedArtifactSource> {
  throwIfAborted(input.signal);
  if (!isAbsolute(input.workspaceRoot) || !Number.isSafeInteger(input.expectedByteLength) ||
    input.expectedByteLength < 0 || !/^[a-f0-9]{64}$/u.test(input.expectedSha256)) {
    throw new Error("Artifact source validation input is invalid.");
  }
  const canonicalRoot = await realpath(input.workspaceRoot);
  const rootStat = await lstat(canonicalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Artifact source workspace is unavailable.");
  }
  const requestedPath = isAbsolute(input.sourcePath) ? input.sourcePath : resolve(input.sourcePath);
  const requestedStat = await lstat(requestedPath);
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
    throw new Error("Artifact source must be a non-symbolic regular file.");
  }
  const canonicalSource = await realpath(requestedPath);
  const relativePath = containedRelativePath(canonicalRoot, canonicalSource);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalSource, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== input.expectedByteLength) {
      throw new Error("Artifact source no longer matches its canonical content.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position <= input.expectedByteLength) {
      throwIfAborted(input.signal);
      const remaining = input.expectedByteLength - position;
      const length = Math.min(buffer.byteLength, remaining + 1);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > input.expectedByteLength) {
        throw new Error("Artifact source no longer matches its canonical content.");
      }
    }
    const after = await handle.stat();
    const reboundPath = await realpath(requestedPath);
    const reboundStat = await lstat(requestedPath);
    if (position !== input.expectedByteLength || digest.digest("hex") !== input.expectedSha256 ||
      reboundPath !== canonicalSource || reboundStat.isSymbolicLink() || !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, reboundStat)) {
      throw new Error("Artifact source no longer matches its canonical content.");
    }
    throwIfAborted(input.signal);
    return { workspaceRoot: canonicalRoot, relativePath, sourcePath: canonicalSource };
  } finally {
    await handle.close();
  }
}

export function resolveStoredArtifactSource(workspaceRoot: string, relativePath: string): string {
  if (!isAbsolute(workspaceRoot) || relativePath.length === 0 || relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Stored Artifact source path is invalid.");
  }
  return resolve(workspaceRoot, ...relativePath.split("/"));
}

function containedRelativePath(root: string, candidate: string): string {
  const value = relative(root, candidate);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error("Artifact source is outside its Workspace authority.");
  }
  const normalized = value.split(sep).join("/");
  if (normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Artifact source relative path is invalid.");
  }
  return normalized;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const error = new Error("Artifact source validation was cancelled.");
  error.name = "AbortError";
  throw error;
}
