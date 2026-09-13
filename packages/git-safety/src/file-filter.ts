import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { GitCommandError, type GitCommandRunner } from "./git-command.js";
import type { SkippedPathFingerprint } from "./types.js";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_SCAN_BYTES = 10 * 1024 * 1024;
const IGNORED_METADATA_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SENSITIVE_PATH = /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.config\/(?:gcloud|gh)|\.docker\/config\.json|\.npmrc|\.pypirc|\.netrc|\.env(?:\.[^/]*)?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx)|[^/]*(?:credential|secret|token|keychain)[^/]*)(?:\/|$)/iu;
const SENSITIVE_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk-|ghp_|github_pat_|glpat-|npm_|pypi-|xox[baprs]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|https?:\/\/[^/@:\s]+:[^/@\s]+@|(?:^|[\r\n])[\t ]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie|credential)\s*[:=]\s*[^\s"']{8,})/iu;

export type SnapshotSkippedReason =
  | "conflict"
  | "large_file"
  | "metadata_file"
  | "sensitive_path"
  | "sensitive_content"
  | "nested_repository"
  | "symbolic_link"
  | "unsafe_path"
  | "scan_failed";

export interface GitStatusEntry {
  readonly code: string;
  readonly relativePath: string;
  readonly oldRelativePath?: string;
}

export interface IncludedSnapshotPath {
  readonly relativePath: string;
  readonly oldRelativePath?: string;
}

export interface SkippedSnapshotPath {
  readonly relativePath: string;
  readonly oldRelativePath?: string;
  readonly reason: SnapshotSkippedReason;
  readonly sizeBytes?: number;
}

export interface SnapshotFilePlan {
  readonly included: readonly IncludedSnapshotPath[];
  readonly skipped: readonly SkippedSnapshotPath[];
}

export interface SnapshotFileFilterOptions {
  readonly maxFileBytes?: number;
  readonly maxContentScanBytes?: number;
}

export class SnapshotStatusUnavailableError extends Error {
  constructor() {
    super("Git status is unavailable within the configured safety bound.");
    this.name = "SnapshotStatusUnavailableError";
  }
}

export async function buildSnapshotFilePlan(
  repositoryRoot: string,
  runner: GitCommandRunner,
  options: SnapshotFileFilterOptions = {}
): Promise<SnapshotFilePlan> {
  let output: string;
  try {
    ({ stdout: output } = await runner.run(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all"
    ]));
  } catch (error) {
    if (error instanceof GitCommandError && error.outputOverflow) throw new SnapshotStatusUnavailableError();
    throw error;
  }
  return buildSnapshotFilePlanFromEntries(
    repositoryRoot,
    parseStatusPorcelainZ(output),
    options
  );
}

export async function buildSnapshotFilePlanFromEntries(
  repositoryRoot: string,
  entries: readonly GitStatusEntry[],
  options: SnapshotFileFilterOptions = {}
): Promise<SnapshotFilePlan> {
  const limits = {
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxContentScanBytes: options.maxContentScanBytes ?? DEFAULT_MAX_CONTENT_SCAN_BYTES
  };
  const included: IncludedSnapshotPath[] = [];
  const skipped: SkippedSnapshotPath[] = [];
  for (const entry of entries) {
    const classification = await classifyEntry(repositoryRoot, entry, limits);
    if (classification === undefined) {
      included.push({
        relativePath: entry.relativePath,
        ...(entry.oldRelativePath === undefined ? {} : { oldRelativePath: entry.oldRelativePath })
      });
    } else {
      skipped.push(classification);
    }
  }
  return { included, skipped };
}

export function parseStatusPorcelainZ(output: string): readonly GitStatusEntry[] {
  const parts = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length < 4) continue;
    const code = part.slice(0, 2);
    const relativePath = part.slice(3);
    if (relativePath === "") continue;
    if (code[0] === "R" || code[0] === "C") {
      const oldRelativePath = parts[index + 1];
      if (oldRelativePath !== undefined && oldRelativePath !== "") {
        entries.push({ code, relativePath, oldRelativePath });
        index += 1;
        continue;
      }
    }
    entries.push({ code, relativePath });
  }
  return entries;
}

export function resolveRepositoryPath(repositoryRoot: string, relativePath: string): string | null {
  const normalized = normalizeGitPath(relativePath);
  if (normalized === null) return null;
  const root = resolve(repositoryRoot);
  const absolute = resolve(root, ...normalized.split("/"));
  const relativeValue = relative(root, absolute);
  if (relativeValue === "" || relativeValue.startsWith(`..${sep}`) || relativeValue === ".." || isAbsolute(relativeValue)) {
    return null;
  }
  return absolute;
}

export async function collectSkippedPathFingerprints(
  repositoryRoot: string,
  skipped: readonly SkippedSnapshotPath[]
): Promise<readonly SkippedPathFingerprint[]> {
  const fingerprints: SkippedPathFingerprint[] = [];
  for (const item of skipped) {
    const absolute = resolveRepositoryPath(repositoryRoot, item.relativePath);
    if (absolute === null) continue;
    const stats = await lstat(absolute).catch(() => undefined);
    if (stats === undefined || stats.isDirectory()) continue;
    fingerprints.push({
      relativePath: item.relativePath,
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      changedAtMs: stats.ctimeMs,
      inode: stats.ino
    });
  }
  return fingerprints;
}

async function classifyEntry(
  repositoryRoot: string,
  entry: GitStatusEntry,
  limits: { readonly maxFileBytes: number; readonly maxContentScanBytes: number }
): Promise<SkippedSnapshotPath | undefined> {
  const base = {
    relativePath: entry.relativePath,
    ...(entry.oldRelativePath === undefined ? {} : { oldRelativePath: entry.oldRelativePath })
  };
  if (hasConflictStatus(entry.code)) return { ...base, reason: "conflict" };

  for (const pathValue of [entry.relativePath, entry.oldRelativePath].filter((value): value is string => value !== undefined)) {
    const normalized = normalizeGitPath(pathValue);
    if (normalized === null || resolveRepositoryPath(repositoryRoot, normalized) === null) {
      return { ...base, reason: "unsafe_path" };
    }
    if (IGNORED_METADATA_NAMES.has(basename(normalized))) return { ...base, reason: "metadata_file" };
    if (SENSITIVE_PATH.test(normalized)) return { ...base, reason: "sensitive_path" };
    if (await isInsideNestedRepository(repositoryRoot, normalized)) return { ...base, reason: "nested_repository" };
  }

  const absolute = resolveRepositoryPath(repositoryRoot, entry.relativePath);
  if (absolute === null) return { ...base, reason: "unsafe_path" };
  const stats = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }).catch(() => null);
  if (stats === undefined) return undefined;
  if (stats === null) return { ...base, reason: "scan_failed" };
  if (stats.isSymbolicLink()) return { ...base, reason: "symbolic_link" };
  if (!stats.isFile()) return { ...base, reason: "scan_failed" };
  if (stats.size > limits.maxFileBytes) return { ...base, reason: "large_file", sizeBytes: stats.size };
  if (stats.size > limits.maxContentScanBytes) return { ...base, reason: "large_file", sizeBytes: stats.size };

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return { ...base, reason: "scan_failed" };
  }
  if (SENSITIVE_CONTENT.test(bytes.toString("utf8"))) return { ...base, reason: "sensitive_content" };
  return undefined;
}

async function isInsideNestedRepository(repositoryRoot: string, relativePath: string): Promise<boolean> {
  const unresolvedAbsolute = resolveRepositoryPath(repositoryRoot, relativePath);
  if (unresolvedAbsolute === null) return false;
  const unresolvedRoot = resolve(repositoryRoot);
  const root = await realpath(repositoryRoot).catch(() => resolve(repositoryRoot));
  const absolute = resolve(root, relative(unresolvedRoot, unresolvedAbsolute));
  const stats = await lstat(absolute).catch(() => undefined);
  let cursor = stats?.isDirectory() === true ? absolute : dirname(absolute);
  while (true) {
    cursor = await realpath(cursor).catch(() => resolve(cursor));
    const relativeCursor = relative(root, cursor);
    if (relativeCursor === ".." || relativeCursor.startsWith(`..${sep}`) || isAbsolute(relativeCursor)) return true;
    if (relativeCursor === "") return false;
    if (await lstat(join(cursor, ".git")).then(() => true, () => false)) return true;
    const parent = dirname(cursor);
    if (parent === cursor) return true;
    cursor = parent;
  }
  return false;
}

function normalizeGitPath(value: string): string | null {
  if (value === "" || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:\//u.test(value) || value.includes("\0")) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  if (segments.some((segment) => segment.toLocaleLowerCase("en-US") === ".git")) return null;
  return segments.join("/");
}

function hasConflictStatus(code: string): boolean {
  return code.includes("U") || code === "AA" || code === "DD";
}
