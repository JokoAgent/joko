import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MARKER = ".joko-wda-source.json";

export type WdaSourceErrorCode = "INVALID_CONFIGURATION" | "INVALID_ARCHIVE" | "CACHE_CONFLICT" |
  "EXTRACTION_FAILED" | "CANCELLED";

export class WdaSourceError extends Error {
  constructor(readonly code: WdaSourceErrorCode, message: string) { super(message); }
}

export interface WdaSourceManifest {
  readonly tag: string;
  readonly revision: string;
  readonly archiveSha256: string;
  readonly licenseSha256: string;
}

export interface PreparedWdaSource {
  readonly checkoutPath: string;
  readonly projectPath: string;
  readonly revision: string;
  readonly fromCache: boolean;
}

interface ArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes: Buffer;
  readonly executable: boolean;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WdaSourceError("CANCELLED", "Driver source preparation was cancelled.");
}

function manifestShape(manifest: WdaSourceManifest): void {
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.tag) ||
      !/^[0-9a-f]{40}$/u.test(manifest.revision) ||
      !/^[0-9a-f]{64}$/u.test(manifest.archiveSha256) ||
      !/^[0-9a-f]{64}$/u.test(manifest.licenseSha256)) {
    throw new WdaSourceError("INVALID_CONFIGURATION", "Driver source manifest is invalid.");
  }
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new WdaSourceError("INVALID_CONFIGURATION", `${label} must be an absolute path.`);
  }
  return resolve(value);
}

function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  if (end >= 0 && !bytes.subarray(end).every(value => value === 0)) throw new Error("Invalid tar header field.");
  const value = bytes.subarray(0, end < 0 ? bytes.length : end);
  if (!value.every(byte => byte >= 0x20 && byte <= 0x7e)) throw new Error("Invalid tar header text.");
  return value.toString("ascii");
}

function octal(header: Buffer, start: number, length: number): number {
  const value = field(header, start, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error("Invalid tar numeric field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error("Tar numeric field exceeds its limit.");
  return parsed;
}

function checkedName(value: string, manifest: WdaSourceManifest, directory: boolean): string {
  const root = `WebDriverAgent-${manifest.tag.slice(1)}`;
  const withoutSlash = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  if (withoutSlash === root && directory) return "";
  if (!withoutSlash.startsWith(`${root}/`) || withoutSlash.includes("\\") || withoutSlash.length > 240) {
    throw new Error("Tar entry is outside the pinned source root.");
  }
  const path = withoutSlash.slice(root.length + 1);
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.includes(":") ||
    part.endsWith(".") || part.endsWith(" "))) throw new Error("Tar entry path is unsafe.");
  return path;
}

/** Preflight every archive entry before any filesystem mutation. */
export function parseWdaSourceArchive(archive: Buffer, manifest: WdaSourceManifest): readonly ArchiveEntry[] {
  manifestShape(manifest);
  if (!archive.length || archive.length > MAX_ARCHIVE_BYTES || sha256(archive) !== manifest.archiveSha256) {
    throw new WdaSourceError("INVALID_ARCHIVE", "Packaged driver source failed integrity verification.");
  }
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }); }
  catch { throw new WdaSourceError("INVALID_ARCHIVE", "Packaged driver source could not be decompressed."); }
  try {
    if (tar.length % 512 !== 0) throw new Error("Tar size is invalid.");
    const entries: ArchiveEntry[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let globalHeader = false;
    let rootSeen = false;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) {
        if (!rootSeen || offset + 1024 > tar.length || !tar.subarray(offset).every(byte => byte === 0)) {
          throw new Error("Tar trailer is invalid.");
        }
        const license = entries.find(entry => entry.path === "LICENSE" && entry.kind === "file");
        const project = entries.find(entry => entry.path === "WebDriverAgent.xcodeproj/project.pbxproj" && entry.kind === "file");
        if (!license || sha256(license.bytes) !== manifest.licenseSha256 || !project || !project.bytes.length) {
          throw new Error("Pinned source is incomplete or its license differs.");
        }
        return entries;
      }
      if (header.toString("ascii", 257, 263) !== "ustar\0") throw new Error("Tar format is invalid.");
      const expectedChecksum = octal(header, 148, 8);
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      if (checksumHeader.reduce((sum, byte) => sum + byte, 0) !== expectedChecksum) throw new Error("Tar header checksum differs.");
      const size = octal(header, 124, 12);
      const mode = octal(header, 100, 8);
      const end = offset + 512 + size;
      const next = offset + 512 + Math.ceil(size / 512) * 512;
      if (end > tar.length || next > tar.length || size > MAX_UNPACKED_BYTES) throw new Error("Tar entry exceeds its boundary.");
      if (!tar.subarray(end, next).every(byte => byte === 0)) throw new Error("Tar entry padding is invalid.");
      const type = header[156];
      const name = field(header, 0, 100);
      const prefix = field(header, 345, 155);
      const fullName = prefix ? `${prefix}/${name}` : name;
      const bytes = tar.subarray(offset + 512, end);
      const expectedGlobal = `52 comment=${manifest.revision}\n`;
      if (type === 0x67 && !globalHeader && !rootSeen && entries.length === 0 && fullName === "pax_global_header" &&
          Buffer.byteLength(expectedGlobal) === 52 && bytes.toString("utf8") === expectedGlobal) {
        globalHeader = true;
      } else if (type === 0x30 || type === 0 || type === 0x35) {
        if (!globalHeader || entries.length >= MAX_ENTRIES) throw new Error("Tar entry sequence is invalid.");
        const directory = type === 0x35;
        if (directory && size !== 0) throw new Error("Tar directory contains data.");
        const path = checkedName(fullName, manifest, directory);
        if (path === "") {
          if (rootSeen) throw new Error("Tar root is duplicated.");
          rootSeen = true;
        } else {
          if (!rootSeen || seen.has(path.toLowerCase()) || path === MARKER) throw new Error("Tar path is duplicated or reserved.");
          const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
          if (parent && !entries.some(entry => entry.path === parent && entry.kind === "directory")) {
            throw new Error("Tar parent directory is missing.");
          }
          seen.add(path.toLowerCase());
          entries.push({ path, kind: directory ? "directory" : "file", bytes: Buffer.from(bytes), executable: (mode & 0o111) !== 0 });
        }
      } else {
        throw new Error("Tar entry type is unsafe.");
      }
      offset = next;
    }
    throw new Error("Tar trailer is missing.");
  } catch {
    throw new WdaSourceError("INVALID_ARCHIVE", "Packaged driver source archive is malformed or unsafe.");
  }
}

async function verifiedCache(checkoutPath: string, entries: readonly ArchiveEntry[], manifest: WdaSourceManifest): Promise<boolean> {
  try {
    const info = await lstat(checkoutPath);
    const markerInfo = await lstat(join(checkoutPath, MARKER));
    if (!info.isDirectory() || info.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(join(checkoutPath, MARKER), "utf8")) as Record<string, unknown>;
    if (marker["revision"] !== manifest.revision || marker["archiveSha256"] !== manifest.archiveSha256) return false;
    const expected = new Map(entries.map(entry => [entry.path, entry]));
    const visit = async (directory: string, prefix: string): Promise<boolean> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${item.name}` : item.name;
        if (path === MARKER) continue;
        const entry = expected.get(path);
        if (!entry || (entry.kind === "directory" ? !item.isDirectory() : !item.isFile()) || item.isSymbolicLink()) return false;
        if (entry.kind === "directory") {
          if (!await visit(join(directory, item.name), path)) return false;
        } else {
          const filePath = join(directory, item.name);
          const info = await lstat(filePath);
          if (info.size !== entry.bytes.length || (process.platform === "darwin" &&
            Boolean(info.mode & 0o100) !== entry.executable) ||
            !(await readFile(filePath)).equals(entry.bytes)) return false;
        }
        expected.delete(path);
      }
      return true;
    };
    return await visit(checkoutPath, "") && expected.size === 0;
  } catch { return false; }
}

export interface PrepareWdaSourceOptions {
  readonly archivePath: string;
  readonly cacheRoot: string;
  readonly signal?: AbortSignal;
}

/** Runtime always uses the repository's fixed source pin and a local packaged archive. */
export function preparePinnedWdaSource(options: PrepareWdaSourceOptions): Promise<PreparedWdaSource> {
  return prepareWdaSourceForManifest(options, WDA_SOURCE_PIN);
}

/** Test seam for controlled tar fixtures; production callers use preparePinnedWdaSource. */
export async function prepareWdaSourceForManifest(options: PrepareWdaSourceOptions, manifest: WdaSourceManifest,
  hooks: { readonly beforeEntry?: (path: string) => void | Promise<void> } = {}): Promise<PreparedWdaSource> {
  const archivePath = absolutePath(options.archivePath, "archivePath");
  const cacheRoot = absolutePath(options.cacheRoot, "cacheRoot");
  manifestShape(manifest);
  cancelled(options.signal);
  let archive: Buffer;
  try {
    const info = await lstat(archivePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_ARCHIVE_BYTES) throw new Error();
    archive = await readFile(archivePath, { signal: options.signal });
  } catch {
    cancelled(options.signal);
    throw new WdaSourceError("INVALID_CONFIGURATION", "Packaged driver source is unavailable.");
  }
  const entries = parseWdaSourceArchive(archive, manifest);
  cancelled(options.signal);
  const checkoutPath = join(cacheRoot, manifest.revision);
  const projectPath = join(checkoutPath, "WebDriverAgent.xcodeproj");
  const found = await lstat(checkoutPath).catch(() => undefined);
  if (found) {
    if (await verifiedCache(checkoutPath, entries, manifest)) return { checkoutPath, projectPath, revision: manifest.revision, fromCache: true };
    throw new WdaSourceError("CACHE_CONFLICT", "Existing driver source cache does not match the pinned archive.");
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(cacheRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WdaSourceError("INVALID_CONFIGURATION", "Driver source cache root is unsafe.");
  }
  const temporary = await mkdtemp(join(cacheRoot, ".extract-"));
  if (dirname(temporary) !== cacheRoot || !temporary.startsWith(`${cacheRoot}${sep}.extract-`)) {
    throw new WdaSourceError("INVALID_CONFIGURATION", "Driver source temporary path is unsafe.");
  }
  try {
    for (const entry of entries) {
      cancelled(options.signal);
      await hooks.beforeEntry?.(entry.path);
      cancelled(options.signal);
      const target = join(temporary, ...entry.path.split("/"));
      if (entry.kind === "directory") await mkdir(target, { mode: 0o700 });
      else await writeFile(target, entry.bytes, { flag: "wx", mode: entry.executable ? 0o700 : 0o600, signal: options.signal });
    }
    cancelled(options.signal);
    await writeFile(join(temporary, MARKER), `${JSON.stringify({ revision: manifest.revision,
      archiveSha256: manifest.archiveSha256 })}\n`, { flag: "wx", mode: 0o600, signal: options.signal });
    cancelled(options.signal);
    const raced = await lstat(checkoutPath).catch(() => undefined);
    if (raced) {
      if (await verifiedCache(checkoutPath, entries, manifest)) return { checkoutPath, projectPath, revision: manifest.revision, fromCache: true };
      throw new WdaSourceError("CACHE_CONFLICT", "Existing driver source cache does not match the pinned archive.");
    }
    try { await rename(temporary, checkoutPath); }
    catch {
      if (await verifiedCache(checkoutPath, entries, manifest)) return { checkoutPath, projectPath, revision: manifest.revision, fromCache: true };
      throw new WdaSourceError("CACHE_CONFLICT", "Driver source cache could not be published.");
    }
    return { checkoutPath, projectPath, revision: manifest.revision, fromCache: false };
  } catch (error) {
    cancelled(options.signal);
    if (error instanceof WdaSourceError) throw error;
    throw new WdaSourceError("EXTRACTION_FAILED", "Driver source could not be prepared.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
