import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

export interface ClaudeNativeMemoryStatus {
  readonly entryCount: number;
  readonly sizeBytes: number;
  readonly targetCount: number;
}

export interface ClaudeNativeMemoryResetResult {
  readonly removedEntries: number;
  readonly removedTargets: number;
}

export type ClaudeNativeMemoryFilesystemFailure =
  | "unsafe_path"
  | "unavailable"
  | "changed"
  | "remove_failed";

export class ClaudeNativeMemoryFilesystemError extends Error {
  constructor(
    readonly failure: ClaudeNativeMemoryFilesystemFailure,
    readonly stateMayHaveChanged: boolean
  ) {
    super("Claude native memory storage could not be accessed safely.");
    this.name = "ClaudeNativeMemoryFilesystemError";
  }
}

export interface ClaudeNativeMemoryFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly realpath: (path: string) => Promise<string>;
  readonly readdir: (path: string) => Promise<readonly Dirent[]>;
  readonly rm: (path: string) => Promise<void>;
}

const nodeFileSystem: ClaudeNativeMemoryFileSystem = {
  lstat,
  realpath,
  readdir: (path) => readdir(path, { withFileTypes: true }),
  rm: (path) => rm(path, { recursive: true, force: false })
};

interface MemoryDirectoryCandidate {
  readonly path: string;
  readonly metadata: Stats;
  readonly entryCount: number;
  readonly sizeBytes: number;
}

interface NativeMemoryInventory extends ClaudeNativeMemoryStatus {
  readonly candidates: readonly MemoryDirectoryCandidate[];
}

export async function scanClaudeNativeMemory(
  configDirectory: string,
  signal?: AbortSignal,
  fileSystem: ClaudeNativeMemoryFileSystem = nodeFileSystem
): Promise<ClaudeNativeMemoryStatus> {
  const inventory = await inventoryClaudeNativeMemory(configDirectory, signal, fileSystem);
  return {
    entryCount: inventory.entryCount,
    sizeBytes: inventory.sizeBytes,
    targetCount: inventory.targetCount
  };
}

export async function resetClaudeNativeMemory(
  configDirectory: string,
  fileSystem: ClaudeNativeMemoryFileSystem = nodeFileSystem
): Promise<ClaudeNativeMemoryResetResult> {
  const inventory = await inventoryClaudeNativeMemory(configDirectory, undefined, fileSystem);
  let removedEntries = 0;
  let removedTargets = 0;
  for (const candidate of inventory.candidates) {
    try {
      const current = await requiredCanonicalDirectory(candidate.path, fileSystem);
      if (!sameFilesystemIdentity(current, candidate.metadata)) {
        throw new ClaudeNativeMemoryFilesystemError("changed", false);
      }
      await fileSystem.rm(candidate.path);
      removedEntries = safeSum(removedEntries, candidate.entryCount);
      removedTargets = safeSum(removedTargets, 1);
    } catch (error) {
      if (error instanceof ClaudeNativeMemoryFilesystemError) {
        throw new ClaudeNativeMemoryFilesystemError(
          error.failure,
          error.stateMayHaveChanged || removedTargets > 0
        );
      }
      throw new ClaudeNativeMemoryFilesystemError("remove_failed", true);
    }
  }
  return { removedEntries, removedTargets };
}

async function inventoryClaudeNativeMemory(
  configDirectory: string,
  signal: AbortSignal | undefined,
  fileSystem: ClaudeNativeMemoryFileSystem
): Promise<NativeMemoryInventory> {
  signal?.throwIfAborted();
  assertCanonicalAbsolutePath(configDirectory);
  const configRoot = await optionalCanonicalDirectory(configDirectory, fileSystem);
  if (configRoot === undefined) return emptyInventory();

  const projectsRoot = join(configDirectory, "projects");
  assertDirectChild(configDirectory, projectsRoot);
  const projects = await optionalCanonicalDirectory(projectsRoot, fileSystem);
  if (projects === undefined) return emptyInventory();
  assertSameDevice(configRoot, projects);

  const projectEntries = await readDirectory(projectsRoot, fileSystem);
  const candidates: MemoryDirectoryCandidate[] = [];
  let entryCount = 0;
  let sizeBytes = 0;
  for (const projectEntry of projectEntries) {
    signal?.throwIfAborted();
    if (projectEntry.isSymbolicLink()) {
      throw new ClaudeNativeMemoryFilesystemError("unsafe_path", false);
    }
    if (!projectEntry.isDirectory()) continue;
    const projectDirectory = join(projectsRoot, projectEntry.name);
    assertDirectChild(projectsRoot, projectDirectory);
    const projectMetadata = await requiredCanonicalDirectory(projectDirectory, fileSystem);
    assertSameDevice(projects, projectMetadata);

    const memoryDirectory = join(projectDirectory, "memory");
    assertDirectChild(projectDirectory, memoryDirectory);
    const memoryMetadata = await optionalCanonicalDirectory(memoryDirectory, fileSystem);
    if (memoryMetadata === undefined) continue;
    assertSameDevice(projectMetadata, memoryMetadata);
    const memoryStats = await statMemoryDirectory(memoryDirectory, signal, fileSystem);
    entryCount = safeSum(entryCount, memoryStats.entryCount);
    sizeBytes = safeSum(sizeBytes, memoryStats.sizeBytes);
    candidates.push({
      path: memoryDirectory,
      metadata: memoryMetadata,
      entryCount: memoryStats.entryCount,
      sizeBytes: memoryStats.sizeBytes
    });
  }
  return { entryCount, sizeBytes, targetCount: candidates.length, candidates };
}

async function statMemoryDirectory(
  memoryDirectory: string,
  signal: AbortSignal | undefined,
  fileSystem: ClaudeNativeMemoryFileSystem
): Promise<Pick<ClaudeNativeMemoryStatus, "entryCount" | "sizeBytes">> {
  const entries = await readDirectory(memoryDirectory, fileSystem);
  let entryCount = 0;
  let sizeBytes = 0;
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md")) continue;
    const file = join(memoryDirectory, entry.name);
    assertDirectChild(memoryDirectory, file);
    let metadata: Stats;
    try {
      metadata = await fileSystem.lstat(file);
    } catch {
      throw new ClaudeNativeMemoryFilesystemError("unavailable", false);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ClaudeNativeMemoryFilesystemError("changed", false);
    }
    entryCount = safeSum(entryCount, 1);
    sizeBytes = safeSum(sizeBytes, metadata.size);
  }
  return { entryCount, sizeBytes };
}

async function optionalCanonicalDirectory(
  path: string,
  fileSystem: ClaudeNativeMemoryFileSystem
): Promise<Stats | undefined> {
  let metadata: Stats;
  try {
    metadata = await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new ClaudeNativeMemoryFilesystemError("unavailable", false);
  }
  await assertCanonicalDirectory(path, metadata, fileSystem);
  return metadata;
}

async function requiredCanonicalDirectory(
  path: string,
  fileSystem: ClaudeNativeMemoryFileSystem
): Promise<Stats> {
  const metadata = await optionalCanonicalDirectory(path, fileSystem);
  if (metadata === undefined) throw new ClaudeNativeMemoryFilesystemError("changed", false);
  return metadata;
}

async function assertCanonicalDirectory(
  path: string,
  metadata: Stats,
  fileSystem: ClaudeNativeMemoryFileSystem
): Promise<void> {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ClaudeNativeMemoryFilesystemError("unsafe_path", false);
  }
  let canonical: string;
  try {
    canonical = await fileSystem.realpath(path);
  } catch {
    throw new ClaudeNativeMemoryFilesystemError("unavailable", false);
  }
  if (pathKey(canonical) !== pathKey(path)) {
    throw new ClaudeNativeMemoryFilesystemError("unsafe_path", false);
  }
}

async function readDirectory(
  path: string,
  fileSystem: ClaudeNativeMemoryFileSystem
): Promise<readonly Dirent[]> {
  try {
    return await fileSystem.readdir(path);
  } catch {
    throw new ClaudeNativeMemoryFilesystemError("unavailable", false);
  }
}

function assertCanonicalAbsolutePath(path: string): void {
  if (!isAbsolute(path)
    || path.includes("\0")
    || pathKey(path) !== pathKey(resolve(path))
    || pathKey(path) === pathKey(parse(path).root)) {
    throw new ClaudeNativeMemoryFilesystemError("unsafe_path", false);
  }
}

function assertDirectChild(parent: string, child: string): void {
  const parentKey = pathKey(parent);
  const expectedPrefix = parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`;
  const childKey = pathKey(child);
  if (!childKey.startsWith(expectedPrefix) || childKey.slice(expectedPrefix.length).includes(sep)) {
    throw new ClaudeNativeMemoryFilesystemError("unsafe_path", false);
  }
}

function pathKey(path: string): string {
  const value = normalize(resolve(path)).normalize("NFC");
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function assertSameDevice(parent: Stats, child: Stats): void {
  if (parent.dev !== child.dev) {
    throw new ClaudeNativeMemoryFilesystemError("unsafe_path", false);
  }
}

function safeSum(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ClaudeNativeMemoryFilesystemError("unavailable", false);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function emptyInventory(): NativeMemoryInventory {
  return { entryCount: 0, sizeBytes: 0, targetCount: 0, candidates: [] };
}
