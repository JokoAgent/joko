import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  canonicalDedicatedHardwareSdkManifestJson,
  parseDedicatedHardwareSdkIdentity,
  parseDedicatedHardwareSdkManifest,
  type DedicatedHardwareSdkArchitecture,
  type DedicatedHardwareSdkFileManifestEntry,
  type DedicatedHardwareSdkIdentity,
  type DedicatedHardwareSdkManifest,
  type DedicatedHardwareSdkPlatform
} from "./dedicated-hardware/protocol.js";

const SDK_LOCK_FILE = "joko-dedicated-hardware-sdk.lock.json";
const SDK_LOCK_MAX_BYTES = 64 * 1024;
const SDK_DIRECTORY_DIGEST_DOMAIN = "joko-dedicated-hardware-sdk-directory-v1";

// This list gates SDK redistribution only. Locally installed SDKs and the native
// USB helper are resolved independently by the hardware runtime loader.
export const APPROVED_DEDICATED_HARDWARE_SDK_ARTIFACTS: readonly DedicatedHardwareSdkLock[] = Object.freeze([]);

export type DedicatedHardwareSdkLock = DedicatedHardwareSdkManifest;

export interface DedicatedHardwareSdkRuntimeTarget {
  readonly platform: DedicatedHardwareSdkPlatform;
  readonly architecture: DedicatedHardwareSdkArchitecture;
  readonly electronModulesAbi: number;
  readonly nodeApiVersion: number;
}

export interface DedicatedHardwareSdkFileInfo {
  readonly size: number;
  readonly dev?: number | bigint;
  readonly ino?: number | bigint;
  readonly mtimeMs?: number | bigint;
  readonly isFile: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface DedicatedHardwareSdkResolverIo {
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly readDirectory: (path: string) => Promise<readonly string[]>;
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<DedicatedHardwareSdkFileInfo>;
}

interface DirectoryDigestInput extends DedicatedHardwareSdkFileManifestEntry {
  readonly bytes: Uint8Array;
}

const DEFAULT_IO: DedicatedHardwareSdkResolverIo = Object.freeze({
  readFile,
  readDirectory: (path: string) => readdir(path),
  realpath,
  lstat
});

/**
 * Resolves only the single Joko-owned staged SDK location. Missing, unreadable,
 * unlicensed, redirected, target-incompatible, or integrity-mismatched inputs
 * fail closed. Reference checkouts and installed applications are never searched.
 */
export async function resolveDedicatedHardwareSdkIdentity(options: {
  readonly stagingDirectory: string;
  readonly io?: DedicatedHardwareSdkResolverIo;
  readonly approvedArtifacts?: readonly DedicatedHardwareSdkLock[];
  readonly runtimeTarget?: DedicatedHardwareSdkRuntimeTarget;
}): Promise<DedicatedHardwareSdkIdentity> {
  const runtimeTarget = options.runtimeTarget ?? currentDedicatedHardwareSdkRuntimeTarget();
  if (runtimeTarget === undefined) return unavailable();
  try {
    const inspected = await inspectDedicatedHardwareSdkDirectory({
      stagingDirectory: options.stagingDirectory,
      io: options.io ?? DEFAULT_IO,
      runtimeTarget,
      approvedArtifacts: options.approvedArtifacts ?? APPROVED_DEDICATED_HARDWARE_SDK_ARTIFACTS
    });
    return inspected ?? unavailable();
  } catch {
    return unavailable();
  }
}

/**
 * Utility-process admission check. The handed identity must be byte-for-byte
 * equivalent to the lock Main approved, and the complete tree is re-read and
 * re-hashed immediately before import.
 */
export async function reverifyDedicatedHardwareSdkIdentity(
  identity: Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }>,
  options: {
    readonly io?: DedicatedHardwareSdkResolverIo;
    readonly runtimeTarget?: DedicatedHardwareSdkRuntimeTarget;
  } = {}
): Promise<Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }> | undefined> {
  const runtimeTarget = options.runtimeTarget ?? currentDedicatedHardwareSdkRuntimeTarget();
  if (runtimeTarget === undefined) return undefined;
  try {
    return await inspectDedicatedHardwareSdkDirectory({
      stagingDirectory: identity.stagingDirectory,
      io: options.io ?? DEFAULT_IO,
      runtimeTarget,
      expectedManifest: identity.manifest
    });
  } catch {
    return undefined;
  }
}

export function parseDedicatedHardwareSdkLock(value: unknown): DedicatedHardwareSdkLock | undefined {
  return parseDedicatedHardwareSdkManifest(value);
}

export function createDedicatedHardwareSdkManifestIntegrity(
  value: Omit<DedicatedHardwareSdkManifest, "manifestIntegrity">
): string {
  return sha512Integrity(new TextEncoder().encode(canonicalDedicatedHardwareSdkManifestJson(value)));
}

export function createDedicatedHardwareSdkDirectoryIntegrity(
  entries: readonly DirectoryDigestInput[]
): string {
  const digest = createHash("sha512");
  digest.update(`${SDK_DIRECTORY_DIGEST_DOMAIN}\0`, "utf8");
  for (const entry of entries) {
    digest.update(JSON.stringify({
      relativePath: entry.relativePath,
      size: entry.size,
      integrity: entry.integrity
    }), "utf8");
    digest.update("\0", "utf8");
    digest.update(entry.bytes);
    digest.update("\0", "utf8");
  }
  return `sha512-${digest.digest("base64")}`;
}

export function dedicatedHardwareSdkEntryPath(
  identity: Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }>
): string {
  return manifestPath(identity.stagingDirectory, identity.manifest.entry.relativePath);
}

export function dedicatedHardwareSdkStagingDirectory(resourcesDirectory: string): string {
  return join(resolve(resourcesDirectory), "dedicated-hardware-sdk");
}

function currentDedicatedHardwareSdkRuntimeTarget(): DedicatedHardwareSdkRuntimeTarget | undefined {
  if ((process.platform !== "win32" && process.platform !== "darwin" && process.platform !== "linux") ||
      (process.arch !== "x64" && process.arch !== "arm64")) return undefined;
  const electronModulesAbi = Number(process.versions.modules);
  const nodeApiVersion = Number(process.versions.napi);
  if (!isPositiveSafeInteger(electronModulesAbi) || !isPositiveSafeInteger(nodeApiVersion)) return undefined;
  return {
    platform: process.platform,
    architecture: process.arch,
    electronModulesAbi,
    nodeApiVersion
  };
}

async function inspectDedicatedHardwareSdkDirectory(options: {
  readonly stagingDirectory: string;
  readonly io: DedicatedHardwareSdkResolverIo;
  readonly runtimeTarget: DedicatedHardwareSdkRuntimeTarget;
  readonly approvedArtifacts?: readonly DedicatedHardwareSdkLock[];
  readonly expectedManifest?: DedicatedHardwareSdkManifest;
}): Promise<Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }> | undefined> {
  const directory = options.stagingDirectory;
  if (!isNormalizedAbsolutePath(directory)) return undefined;
  const rootInfo = await options.io.lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !sameNormalizedPath(await options.io.realpath(directory), directory)) return undefined;

  const lockPath = join(directory, SDK_LOCK_FILE);
  const lockBytes = await readStableRegularFile(options.io, lockPath, SDK_LOCK_MAX_BYTES);
  const lock = parseDedicatedHardwareSdkLock(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(lockBytes)
  ) as unknown);
  if (lock === undefined || !targetsEqual(lock.target, options.runtimeTarget)) return undefined;
  if (options.expectedManifest !== undefined && !locksEqual(lock, options.expectedManifest)) return undefined;
  if (options.approvedArtifacts !== undefined &&
      !options.approvedArtifacts.some((candidate) => locksEqual(candidate, lock))) return undefined;

  const expectedFiles = [SDK_LOCK_FILE, ...lock.files.map((entry) => entry.relativePath)].sort();
  const expectedDirectories = manifestDirectories(lock.files);
  const before = await discoverDirectoryTree(options.io, directory);
  if (!sameStringArray(before.files, expectedFiles) || !sameStringArray(before.directories, expectedDirectories)) {
    return undefined;
  }

  const digestInputs: DirectoryDigestInput[] = [];
  for (const expected of lock.files) {
    const path = manifestPath(directory, expected.relativePath);
    const bytes = await readStableRegularFile(options.io, path, expected.size);
    if (bytes.byteLength !== expected.size || sha512Integrity(bytes) !== expected.integrity) return undefined;
    digestInputs.push({ ...expected, bytes });
  }
  if (createDedicatedHardwareSdkDirectoryIntegrity(digestInputs) !== lock.directoryIntegrity) return undefined;

  const after = await discoverDirectoryTree(options.io, directory);
  if (!sameStringArray(after.files, expectedFiles) || !sameStringArray(after.directories, expectedDirectories)) {
    return undefined;
  }
  const finalLockBytes = await readStableRegularFile(options.io, lockPath, SDK_LOCK_MAX_BYTES);
  if (!sameBytes(lockBytes, finalLockBytes)) return undefined;

  const identity = Object.freeze({ kind: "staged" as const, stagingDirectory: directory, manifest: lock });
  const parsedIdentity = parseDedicatedHardwareSdkIdentity(identity);
  return parsedIdentity?.kind === "staged" ? parsedIdentity : undefined;
}

async function discoverDirectoryTree(
  io: DedicatedHardwareSdkResolverIo,
  root: string
): Promise<Readonly<{ files: readonly string[]; directories: readonly string[] }>> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > 16) throw new Error("SDK directory nesting exceeds its boundary.");
    const entries = [...await io.readDirectory(directory)].sort();
    if (entries.length > 513 || new Set(entries).size !== entries.length ||
        new Set(entries.map((entry) => entry.toLocaleLowerCase("en-US"))).size !== entries.length) {
      throw new Error("SDK directory entries are invalid or ambiguous.");
    }
    for (const name of entries) {
      if (!isSafePathSegment(name)) throw new Error("SDK directory entry is unsafe.");
      const path = join(directory, name);
      assertContained(root, path);
      const info = await io.lstat(path);
      if (info.isSymbolicLink() || !sameNormalizedPath(await io.realpath(path), path)) {
        throw new Error("SDK directory entry is redirected.");
      }
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      if (info.isDirectory()) {
        directories.push(relativePath);
        await visit(path, relativePath, depth + 1);
      } else if (info.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error("SDK directory contains a non-regular entry.");
      }
    }
  };
  await visit(root, "", 0);
  return Object.freeze({ files: Object.freeze(files.sort()), directories: Object.freeze(directories.sort()) });
}

async function readStableRegularFile(
  io: DedicatedHardwareSdkResolverIo,
  path: string,
  maximumBytes: number
): Promise<Uint8Array> {
  const canonicalPath = await io.realpath(path);
  if (!sameNormalizedPath(canonicalPath, path)) throw new Error("SDK file is redirected.");
  const before = await io.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximumBytes) {
    throw new Error("SDK file is missing, unsafe, or outside its size boundary.");
  }
  const bytes = await io.readFile(path);
  const after = await io.lstat(path);
  if (bytes.byteLength !== before.size || !sameFileInfo(before, after) ||
      !sameNormalizedPath(await io.realpath(path), path)) {
    throw new Error("SDK file changed while it was verified.");
  }
  return bytes;
}

function manifestDirectories(files: readonly DedicatedHardwareSdkFileManifestEntry[]): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
  }
  return [...directories].sort();
}

function manifestPath(root: string, relativePath: string): string {
  const path = resolve(root, ...relativePath.split("/"));
  assertContained(root, path);
  return path;
}

function unavailable(): DedicatedHardwareSdkIdentity {
  return Object.freeze({ kind: "unavailable" });
}

function locksEqual(left: DedicatedHardwareSdkLock, right: DedicatedHardwareSdkLock): boolean {
  const parsedLeft = parseDedicatedHardwareSdkLock(left);
  const parsedRight = parseDedicatedHardwareSdkLock(right);
  return parsedLeft !== undefined && parsedRight !== undefined &&
    JSON.stringify(parsedLeft) === JSON.stringify(parsedRight);
}

function targetsEqual(
  left: DedicatedHardwareSdkManifest["target"],
  right: DedicatedHardwareSdkRuntimeTarget
): boolean {
  return left.platform === right.platform && left.architecture === right.architecture &&
    left.electronModulesAbi === right.electronModulesAbi && left.nodeApiVersion === right.nodeApiVersion;
}

function sameFileInfo(left: DedicatedHardwareSdkFileInfo, right: DedicatedHardwareSdkFileInfo): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.size === right.size &&
    (left.dev === undefined || right.dev === left.dev) &&
    (left.ino === undefined || right.ino === left.ino) &&
    (left.mtimeMs === undefined || right.mtimeMs === left.mtimeMs);
}

function isNormalizedAbsolutePath(value: string): boolean {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function sameNormalizedPath(left: string, right: string): boolean {
  const canonicalLeft = resolve(left);
  const canonicalRight = resolve(right);
  return process.platform === "win32"
    ? canonicalLeft.toLocaleLowerCase("en-US") === canonicalRight.toLocaleLowerCase("en-US")
    : canonicalLeft === canonicalRight;
}

function assertContained(root: string, candidate: string): void {
  const suffix = relative(root, candidate);
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw new Error("SDK path escapes its staging directory.");
}

function isSafePathSegment(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." &&
    /^[A-Za-z0-9@][A-Za-z0-9@._+-]*$/u.test(value);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}
