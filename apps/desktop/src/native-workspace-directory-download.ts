import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdtemp, realpath, rename, rm, mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  isWorkspaceDirectoryArchiveName,
  nativeFileActionSequence,
  WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_BYTES,
  WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES,
  workspaceDirectoryArchiveNameKey
} from "@joko/contracts";
import { extract } from "tar";
import type { DesktopWorkspaceDirectoryDownloadRequest } from "./channels.js";
import { NativeFileActionRequests, type NativeFileActionScope } from "./native-file-action-requests.js";

interface DirectoryDownloadOptions {
  readonly downloadRoot: () => string;
  readonly revealPath: (path: string) => void;
}

export class NativeWorkspaceDirectoryDownload {
  readonly #requests = new NativeFileActionRequests<boolean>();
  readonly #options: DirectoryDownloadOptions;

  constructor(options: DirectoryDownloadOptions) { this.#options = options; }

  save(value: unknown, scope: NativeFileActionScope): Promise<boolean> {
    const input = parseRequest(value);
    const digest = createHash("sha256").update(input.directoryName).update("\0").update(input.bytes).digest("hex");
    const existing = this.#requests.replay(scope, input.requestId, digest);
    if (existing !== undefined) return existing === false ? Promise.resolve(false) : existing;
    if (!scope.isCurrent() || this.#requests.pendingCount >= 8) return Promise.resolve(false);
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && scope.isCurrent();
    const result = this.#save(input, current, abort.signal).catch((error: unknown) => {
      if (!current()) return false;
      throw error;
    });
    this.#requests.add(scope, input.requestId, digest, abort, result);
    return result;
  }

  cancel(requestId: string, scopeId: string): void { this.#requests.cancel(scopeId, requestId); }
  retireScope(scopeId: string): void { this.#requests.retireScope(scopeId); }
  cancelPending(): void { this.#requests.cancelPending(); }

  async #save(input: DesktopWorkspaceDirectoryDownloadRequest, current: () => boolean, signal: AbortSignal): Promise<boolean> {
    const selected = this.#options.downloadRoot();
    const root = await realpath(selected);
    const original = await lstat(root);
    const assertRoot = async (): Promise<void> => {
      if (!current()) throw new Error("The directory download was cancelled.");
      const observed = await lstat(root);
      if (!sameDirectory(original, observed) || await realpath(selected) !== root) {
        throw new Error("The Downloads directory changed during the transfer.");
      }
      if (!current()) throw new Error("The directory download was cancelled.");
    };
    await assertRoot();
    const staging = await mkdtemp(join(root, ".joko-directory-"));
    const originalStaging = await lstat(staging);
    try {
      await extractDirectory(input, staging, signal);
      const path = await publishDirectory(root, staging, input.directoryName, assertRoot);
      if (current()) {
        try { this.#options.revealPath(path); } catch { /* The directory was already published. */ }
      }
      return true;
    } finally {
      const remaining = await lstat(staging).catch(() => undefined);
      if (remaining !== undefined && sameDirectory(originalStaging, remaining) && await realpath(staging).catch(() => undefined) === staging) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

function parseRequest(value: unknown): DesktopWorkspaceDirectoryDownloadRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("A workspace directory download is required.");
  const { requestId, directoryName, bytes, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length !== 0 || typeof requestId !== "string" || nativeFileActionSequence(requestId) === undefined
    || typeof directoryName !== "string" || !isWorkspaceDirectoryArchiveName(directoryName)
    || !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_BYTES) {
    throw new TypeError("The workspace directory download is invalid.");
  }
  return { requestId, directoryName, bytes: new Uint8Array(bytes) };
}

async function extractDirectory(input: DesktopWorkspaceDirectoryDownloadRequest, staging: string, signal: AbortSignal): Promise<void> {
  // Allow tar headers for the bounded file tree as well as the file data itself.
  const expandedLimit = WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_BYTES + WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES * 8_192;
  let expandedBytes = 0;
  let fileBytes = 0;
  let invalidEntry = false;
  const entries = new Map<string, string>();
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      expandedBytes += chunk.byteLength;
      if (expandedBytes > expandedLimit || invalidEntry) done(new Error("The directory archive exceeds its extraction limit or contains an unsafe entry."));
      else done(null, chunk);
    }
  });
  const unpack = extract({ cwd: staging, strict: true, preservePaths: false, maxDepth: 129,
    noChmod: true, noMtime: true,
    filter: (archivePath, entry) => {
      if (!("type" in entry)) { invalidEntry = true; return false; }
      const normalized = archivePath.replace(/^\.\//u, "").replace(/\/$/u, "");
      const segments = normalized.split("/");
      const isDirectory = entry.type === "Directory";
      const key = workspaceDirectoryArchiveNameKey(normalized);
      const parent = workspaceDirectoryArchiveNameKey(segments.slice(0, -1).join("/"));
      fileBytes += entry.size;
      if (invalidEntry || (entry.type !== "File" && !isDirectory)
        || normalized.length > 4_096 || !segments.every(isWorkspaceDirectoryArchiveName)
        || segments[0] !== input.directoryName || !Number.isSafeInteger(entry.size) || entry.size < 0
        || (segments.length === 1 ? !isDirectory : entries.get(parent) !== "Directory")
        || (isDirectory && entry.size !== 0) || fileBytes > WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_BYTES
        || entries.has(key) || entries.size > WORKSPACE_DIRECTORY_ARCHIVE_MAXIMUM_ENTRIES) {
        invalidEntry = true;
        return false;
      }
      entries.set(key, entry.type);
      return true;
    }
  });
  await pipeline(Readable.from([input.bytes]), createGunzip(), bound, unpack, { signal });
  if (invalidEntry || entries.get(workspaceDirectoryArchiveNameKey(input.directoryName)) !== "Directory") {
    throw new Error("The directory archive contains an unsafe or incomplete tree.");
  }
}

function sameDirectory(original: Stats, observed: Stats): boolean {
  return original.isDirectory() && observed.isDirectory() && !observed.isSymbolicLink()
    && original.dev === observed.dev && original.ino === observed.ino && original.birthtimeMs === observed.birthtimeMs;
}

async function publishDirectory(root: string, staging: string, name: string, assertRoot: () => Promise<void>): Promise<string> {
  for (let index = 0; index < 10_000; index += 1) {
    const destination = join(root, index === 0 ? name : `${name} (${index})`);
    await assertRoot();
    if (process.platform === "win32") {
      // Windows cannot rename a directory onto another directory.
      if (await directoryEntryExists(destination)) continue;
      await assertRoot();
      try { await rename(join(staging, name), destination); return destination; }
      catch (error) {
        if (!await directoryEntryExists(destination)) throw error;
        continue;
      }
    }
    try { await mkdir(destination, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      continue;
    }
    const lease = await lstat(destination);
    let committed = false;
    try {
      await assertRoot();
      if (!sameDirectory(lease, await lstat(destination))) throw new Error("The download destination changed.");
      await rename(join(staging, name), destination);
      committed = true;
      return destination;
    } finally {
      if (!committed) {
        const remaining = await lstat(destination).catch(() => undefined);
        if (remaining !== undefined && sameDirectory(lease, remaining)) await rmdir(destination).catch(() => undefined);
      }
    }
  }
  throw new Error("There is no available name in Downloads for this directory.");
}

async function directoryEntryExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
